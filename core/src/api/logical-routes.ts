import type { Hono, Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { jsonWrite, isBadSourceUrl, pageArgs, readTabOverrides, establishFederation, isAuditCategory as isSourceGovernanceCategory, IDEMPOTENCY_CONFLICT as SOURCES_IDEMPOTENCY_CONFLICT } from './app.ts'
import { HandleTakenError } from '../domain/types.ts'
import type { EventBus } from '../domain/bus.ts'
import type { LogicalStreamSource } from '../logical/runtime.ts'
import { fingerprintRequest, SOURCE_TRANSITIONS, CATEGORY_OPTIONAL_ACTIONS } from '../domain/source-repository.ts'
import type { SourceRepository, SourceTransitionAction } from '../domain/source-repository.ts'
import { decodeCursor } from '../domain/cursor.ts'
import type { LogicalStore } from '../logical/store.ts'
import type { ReadTx } from '../logical/database.ts'
import type { AcquisitionEngine } from '../logical/acquisition.ts'
import type { CommandEnvelope, AuditCategory, AttributionMode } from '../domain/types.ts'
import type { RunCursor, JobCursor, AdminRunProjection, AdminRefreshResult, TimelineLens, ProjectionViewer, LogicalItemDto, ItemModerationResult, PublicLocalAccount } from '../logical/types.ts'
import type { Auth } from '../auth.ts'
import type { UserDirectory } from './auth.ts'
import { apiKeyAuth, apiKeyAuthAdmin } from './auth.ts'
import type { Service } from '../domain/service.ts'
import type { SourceService } from '../domain/source-service.ts'
import type { FeedContext } from '../domain/feed.ts'
import { renderFirehoseRss, renderRssFeed, renderJsonFeed, renderCommentsFeed, injectSourceComments, emittedGuid, logicalToFeedEntry, itemContentFields } from '../domain/feed.ts'
import { MODEL, NEUTRAL_404, isString, readJsonBody, clampLimit, decodeBeforeCursor, FEED_LIMIT } from './logical-routes/shared.ts'
import type { ApiKeyCreation } from './logical-routes/shared.ts'

export * from './logical-routes/write.ts'
export * from './logical-routes/read.ts'

// =============================================================================
// Authed personal API (2026-08-01 design, phase 2) — GET /me/timeline, GET /me/posts
// =============================================================================
// Key-authed equivalents of the browser's own Personal tab / own-posts view.
// Unlike GET /timeline (session-optional, handle-driven, never mints a
// guest — see mountLogicalReadRoutes' viewerAccount comment), these always
// require a key and resolve the account from its owner via ensureCoreUser —
// a different trust class from that function's stated invariant, which is
// why this is a SEPARATE mount function rather than two more app.get() calls
// folded into mountLogicalReadRoutes (rev 2 — ponytail-review traced the
// invariant collision this would cause).

export interface PersonalApiDeps {
  store: LogicalStore
  auth: Auth
  users: UserDirectory
  service: Service
  sourceService: SourceService
}

// Whitelisted to exactly what apiKeyAuth actually gates somewhere in this
// file (Global Constraints) — a raw request can't mint a key scoped to a
// permission no route checks yet. Phase 2 added timeline:read/posts:read;
// phase 3 adds posts:write, follows:write, profile:write (Tasks 1-3's
// routes). admin.* (phase 4) stays deliberately absent.
const ALLOWED_KEY_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  timeline: ['read'],
  posts: ['read', 'write'],
  follows: ['write'],
  profile: ['write']
}
function isValidKeyPermissions(v: unknown): v is Record<string, string[]> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length === 0) return false
  return entries.every(([resource, actions]) => {
    // Object.hasOwn, not bare indexing: a crafted resource key like
    // "toString" or "__proto__" would otherwise resolve to an inherited
    // Object.prototype member instead of undefined, and the subsequent
    // `allowed.includes` throws a TypeError that surfaces as a raw 500.
    if (!Object.hasOwn(ALLOWED_KEY_PERMISSIONS, resource)) return false
    const allowed = ALLOWED_KEY_PERMISSIONS[resource]
    return Array.isArray(actions) && actions.length > 0 && actions.every((a) => typeof a === 'string' && allowed.includes(a))
  })
}

// Owner-projected outcomes shared by the two subscribe/unsubscribe routes
// below — byte-identical to app.ts's own NEUTRAL_UNAVAILABLE/IDEMPOTENCY_CONFLICT
// constants (design §4: blocked/never-existed/tombstoned are ONE indistinguishable
// answer; the idempotency-conflict body is distinct from it).
const SUB_NEUTRAL_UNAVAILABLE = { error: 'source unavailable' }
const SUB_IDEMPOTENCY_CONFLICT = { error: 'idempotency conflict' }

export function mountPersonalApiRoutes(app: Hono, deps: PersonalApiDeps): void {
  const { store, auth, users, service, sourceService } = deps
  const apiKeyCreateApi = auth.api as unknown as ApiKeyCreation

  function accountOf(c: Context): PublicLocalAccount {
    const u = c.get('coreUser')
    return { id: u.id, handle: u.handle, displayName: u.displayName }
  }

  app.get('/me/timeline', apiKeyAuth(auth, users, { timeline: ['read'] }), (c) => {
    const before = decodeBeforeCursor(c)
    if (before === 'invalid') return c.json({ error: 'invalid cursor' }, 400)
    const limit = clampLimit(c.req.query('limit'))
    const account = accountOf(c)
    const viewer: ProjectionViewer = { localAccountId: account.id, activeSourceIds: [] }
    const result = store.snapshot((tx) => tx.projectTimeline({ lens: { kind: 'personal', account }, before, limit, viewer }))
    return c.json(result)
  })

  app.get('/me/posts', apiKeyAuth(auth, users, { posts: ['read'] }), (c) => {
    const before = decodeBeforeCursor(c)
    if (before === 'invalid') return c.json({ error: 'invalid cursor' }, 400)
    const limit = clampLimit(c.req.query('limit'))
    const account = accountOf(c)
    const viewer: ProjectionViewer = { localAccountId: account.id, activeSourceIds: [] }
    const result = store.snapshot((tx) => tx.projectTimeline({ lens: { kind: 'local_author', account }, before, limit, viewer }))
    return c.json(result)
  })

  // --- key-authed post create/edit/delete (posts:write, phase 3) ---------
  // POST/PATCH are key-authed twins of app.ts's cookie-authed `POST /posts`
  // and `PATCH /posts/:id` — same validation, same service calls, same
  // error shapes, transcribed from those exact handlers. DELETE is a
  // genuinely new self-serve capability: until now only an admin could
  // hard-delete a post (app.ts's `DELETE /admin/posts/:id`); this scopes
  // that same service.deletePost to the caller's OWN post, gated by the
  // same ownership check PATCH already uses (post.source !== 'local' ||
  // post.authorId !== me.id -> 403), checked BEFORE calling deletePost so a
  // remote post is refused the same way for every caller, not just its
  // (nonexistent) local owner.
  app.post('/me/posts', apiKeyAuth(auth, users, { posts: ['write'] }), jsonWrite, async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { content, inReplyTo } = body
    if (!isString(content, 1, 100000)) return c.json({ error: 'content invalid' }, 400)
    if (inReplyTo !== undefined && !isString(inReplyTo, 1, 64)) return c.json({ error: 'inReplyTo invalid' }, 400)
    let replyTarget
    if (typeof inReplyTo === 'string') {
      replyTarget = await service.resolveReplyTarget(inReplyTo)
      if (!replyTarget) return c.json({ error: 'unknown post' }, 404)
    }
    const me = c.get('coreUser')
    const post = await service.createLocalPostAs(me.handle, me.displayName, content, replyTarget)
    return c.json({ post }, 201)
  })

  app.patch('/me/posts/:id', apiKeyAuth(auth, users, { posts: ['write'] }), jsonWrite, async (c) => {
    const me = c.get('coreUser')
    const post = await service.getPost(c.req.param('id'))
    if (!post) return c.json({ error: 'unknown post' }, 404)
    if (post.source !== 'local' || post.authorId !== me.id) return c.json({ error: 'not editable' }, 403)
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { content } = body
    if (!isString(content, 1, 100000)) return c.json({ error: 'content invalid' }, 400)
    if (content === post.content) return c.json({ post }, 200) // no-op: no phantom revision
    const entry = await service.editLocalPost(post, content, me)
    return c.json({ post: entry }, 200)
  })

  app.delete('/me/posts/:id', apiKeyAuth(auth, users, { posts: ['write'] }), jsonWrite, async (c) => {
    const me = c.get('coreUser')
    const post = await service.getPost(c.req.param('id'))
    if (!post) return c.json({ error: 'unknown post' }, 404)
    if (post.source !== 'local' || post.authorId !== me.id) return c.json({ error: 'not editable' }, 403)
    const result = await service.deletePost(post.id)
    if ('error' in result) return c.json({ error: result.error === 'unknown' ? 'unknown post' : 'not a local post' }, result.error === 'unknown' ? 404 : 409)
    return c.json({ ok: true }, 200)
  })

  // --- key-authed follow/unfollow (follows:write, phase 3 task 2a) --------
  // Key-authed twins of app.ts's cookie-authed `POST /me/follows` / `DELETE
  // /me/follows/:target` — same body/param shape, same service calls
  // (service.addFollow/removeFollow silently no-op on a self-follow or an
  // instance target; this route doesn't second-guess that, matching its
  // sibling). Named `api-follows`, not the bare `/me/follows` path Task 1's
  // `/me/posts` pattern would suggest: app.ts already claims that EXACT
  // method+path pair for the cookie-authed route, so reusing it here would
  // make this registration unreachable (Hono matches method+path on one
  // instance) — the `api-` infix disambiguates, same naming spirit as
  // `POST /me/api-keys` above (a different underlying collision, same fix).
  app.post('/me/api-follows', apiKeyAuth(auth, users, { follows: ['write'] }), jsonWrite, async (c) => {
    const body = await readJsonBody(c)
    if (!body || !isString(body.handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    const target = await service.getUserByHandle(body.handle.toLowerCase())
    if (!target) return c.json({ error: 'unknown user' }, 404)
    await service.addFollow(c.get('coreUser'), target)
    return c.json({ ok: true }, 200)
  })

  app.delete('/me/api-follows/:target', apiKeyAuth(auth, users, { follows: ['write'] }), async (c) => {
    const target = await service.getUserByHandle((c.req.param('target') ?? '').toLowerCase())
    if (!target) return c.json({ error: 'unknown user' }, 404)
    await service.removeFollow(c.get('coreUser').id, target)
    return c.json({ ok: true }, 200)
  })

  // --- key-authed subscribe/unsubscribe (follows:write, phase 3 task 2b) --
  // Key-authed twins of app.ts's cookie-authed `POST /me/subscriptions` /
  // `DELETE /me/subscriptions/:sourceId` — same validation, same
  // sourceService calls, same response-shape switch and idempotency
  // semantics, transcribed from those exact handlers. Bundled under the
  // SAME follows:write permission as api-follows above (spec deliberately
  // groups local-follow and remote-subscription writes under one
  // resource). Named `api-subscriptions`, not the bare `/me/subscriptions`
  // path: app.ts already claims that exact method+path pair for its
  // cookie-authed route, so reusing it here would make this registration
  // unreachable — same `api-` disambiguation as api-follows/api-keys above.
  // The cookie-authed sibling also carries registeredOnly(); deliberately
  // NOT mirrored here — apiKeyAuth routes are already registered-only by
  // construction (see auth.ts's registeredOnly() comment), and stacking
  // registeredOnly() after apiKeyAuth would unconditionally 403 every
  // request since apiKeyAuth never sets sessionIsAnonymous.
  app.post('/me/api-subscriptions', apiKeyAuth(auth, users, { follows: ['write'] }), jsonWrite, async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { url, commandId } = body
    if (!isString(url, 1, 2048)) return c.json({ error: 'url invalid' }, 400)
    if (!isString(commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
    let result
    try {
      result = await sourceService.subscribeByUrl(c.get('coreUser'), url, commandId)
    } catch (err) {
      if (isBadSourceUrl(err)) return c.json({ error: 'url invalid' }, 400)
      throw err
    }
    switch (result.kind) {
      case 'source': {
        const subscription = result.subscription
        // Pending answers the neutral payload ONLY — never the owner
        // projection, which would leak that the source is under review.
        if (subscription.subscriptionState !== 'active') {
          return c.json({ subscription: 'pending', message: 'This source is awaiting review.' }, result.created ? 202 : 200)
        }
        return c.json({ subscription }, result.created ? 201 : 200)
      }
      case 'local':
        return c.json({ follow: result.follow }, result.created ? 201 : 200)
      case 'cap':
        return c.json({ error: 'subscription limit reached' }, 429)
      case 'conflict':
        return c.json(SUB_IDEMPOTENCY_CONFLICT, 409)
      default:
        return c.json(SUB_NEUTRAL_UNAVAILABLE, 409)
    }
  })

  app.delete('/me/api-subscriptions/:sourceId', apiKeyAuth(auth, users, { follows: ['write'] }), jsonWrite, async (c) => {
    const body = await readJsonBody(c)
    if (!body || !isString(body.commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
    const result = await sourceService.unsubscribe(c.get('coreUser').id, c.req.param('sourceId') ?? '', body.commandId)
    if (result.kind === 'unknown') return c.json({ error: 'unknown subscription' }, 404)
    if (result.kind === 'conflict') return c.json(SUB_IDEMPOTENCY_CONFLICT, 409)
    // sourceRemoved is deliberately NOT surfaced: whether the source row
    // survived is a function of governance/federation/retention, which an
    // ordinary DTO never reveals.
    return c.json({ ok: true }, 200)
  })

  // --- key-authed profile update (profile:write, phase 3 task 3) ---------
  // Key-authed twin of app.ts's cookie-authed `PATCH /me` — same validation
  // and same HandleTakenError -> 409 mapping, transcribed from that exact
  // handler. Named `api-profile`, not the bare `/me` path: app.ts already
  // claims that exact method+path pair for its cookie-authed route, so
  // reusing it here would make this registration unreachable — same `api-`
  // disambiguation as api-follows/api-subscriptions above.
  app.patch('/me/api-profile', apiKeyAuth(auth, users, { profile: ['write'] }), jsonWrite, async (c) => {
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { handle, displayName } = body
    if (handle !== undefined && !isString(handle, 1, 64)) return c.json({ error: 'handle invalid' }, 400)
    if (displayName !== undefined && !isString(displayName, 1, 200)) return c.json({ error: 'displayName invalid' }, 400)
    if (handle === undefined && displayName === undefined) return c.json({ error: 'nothing to update' }, 400)
    try {
      const user = await service.updateUserProfile(c.get('coreUser').id, {
        ...(handle !== undefined ? { handle: handle.toLowerCase() } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
      })
      return c.json({ user })
    } catch (err) {
      if (err instanceof HandleTakenError) return c.json({ error: 'handle already taken' }, 409)
      throw err
    }
  })

  // Cookie-authed (a user manages their OWN keys from the browser, before
  // any key exists to authenticate WITH) — not apiKeyAuth. See ApiKeyCreation
  // above for why this can't just be a web-side fetch to better-auth's own
  // /api-key/create REST endpoint.
  //
  // Breadcrumb for whoever builds phase 4: this route's own in-process call
  // to apiKeyCreateApi.createApiKey below carries neither `ctx.request` nor
  // `ctx.headers`, so it is invisible to a session-keyed better-auth
  // `hooks.before` (auth.ts's own anonymous-session guard on the REST
  // /api-key/create endpoint is exactly such a hook, and does not fire for
  // this call — confirmed: that's why SERVER_ONLY_PROPERTY doesn't fire for
  // this route's own `permissions` field either). This route is safe today
  // only because it enforces its own registered-only check explicitly, right
  // above. Any FUTURE in-process issuance path (a phase-4 admin equivalent of
  // this route, say) must do the same — it cannot rely on a hook that only
  // sees real HTTP requests.
  app.post('/me/api-keys', jsonWrite, async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'authentication required' }, 401)
    // Same cast + field sessionAuth uses for the same purpose (api/auth.ts).
    // Self-serve keys are scoped to registered users (spec) — an anonymous
    // guest's session cookie passes hasSession on the web side, so this is
    // the real boundary.
    if ((session.user as { isAnonymous?: boolean | null }).isAnonymous === true) return c.json({ error: 'registration required' }, 403)
    const body = await readJsonBody(c)
    // 32, not an arbitrary round number: the apiKey plugin's real
    // maximumNameLength default (confirmed in the installed source,
    // @better-auth/api-key/dist/index.mjs — core/src/auth.ts's apiKey()
    // config never overrides it). A longer name used to reach the plugin's
    // own check and throw past this route as a raw 500.
    if (!body || !isString(body.name, 1, 32)) return c.json({ error: 'name invalid' }, 400)
    if (!isValidKeyPermissions(body.permissions)) return c.json({ error: 'permissions invalid' }, 400)
    try {
      const created = await apiKeyCreateApi.createApiKey({
        body: { configId: 'user', userId: session.user.id, name: body.name, permissions: body.permissions }
      })
      return c.json({ id: created.id, key: created.key, name: created.name, prefix: created.prefix }, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'could not create key' }, 400)
    }
  })
}

// =============================================================================
// admin-tier API key issuance (phase 4 Task 2)
// =============================================================================

export interface AdminApiDeps {
  auth: Auth
  users: UserDirectory
  adminEmails: ReadonlySet<string>
  service: Service
  sourceRepo: SourceRepository
  sourceService: SourceService
  logicalStore: { schedulerStats(input: { now: string; pollSeconds: number }): unknown }
  feeds: FeedContext
  websubMode: string
  pushInEnabled: boolean
  mailEnabled: boolean
  pollSeconds: number
}

// Mirrors app.ts's own isAttributionMode exactly (that one is module-private
// there) — needed here for the admin-tier transition route's
// set_attribution_mode validation, transcribed from the cookie-authed
// sibling.
function isAttributionMode(v: unknown): v is AttributionMode {
  return v === 'single_publisher' || v === 'aggregate'
}

// The spec's six named governance verbs (Global Constraints) — a RESTRICTED
// subset of SOURCE_TRANSITIONS' full ten-action matrix (pause, resume,
// quarantine, allow, approve, reject, revoke, block, unblock,
// set_attribution_mode). approve/reject/revoke/set_attribution_mode stay
// cookie-authed-only.
const ADMIN_API_ALLOWED_ACTIONS: ReadonlySet<string> = new Set(['pause', 'resume', 'quarantine', 'allow', 'block', 'unblock'])

// Mirrors ALLOWED_KEY_PERMISSIONS's shape and purpose exactly, scoped to the
// admin.* vocabulary — a raw request can't mint an admin key for a
// permission no admin-tier route checks yet (Tasks 3-5 add the routes this
// whitelist names; it is deliberately written to their FINAL shape now so
// this task doesn't need revisiting per later task).
const ALLOWED_ADMIN_KEY_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  'admin.read': ['read'],
  'admin.sources': ['write'],
  'admin.moderation': ['write'],
}
function isValidAdminKeyPermissions(v: unknown): v is Record<string, string[]> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length === 0) return false
  return entries.every(([resource, actions]) => {
    if (!Object.hasOwn(ALLOWED_ADMIN_KEY_PERMISSIONS, resource)) return false
    const allowed = ALLOWED_ADMIN_KEY_PERMISSIONS[resource]
    return Array.isArray(actions) && actions.length > 0 && actions.every((a) => typeof a === 'string' && allowed.includes(a))
  })
}

// Mounted from app.ts AFTER app.use('/admin/*', authed, requireAdmin()) —
// see this plan's Global Constraints (Hono middleware is registration-order
// dependent, verified live). Every route here already runs behind that
// gate; c.get('coreUser') is already set by `authed` by the time any
// handler below runs.
export function mountAdminApiRoutes(app: Hono, deps: AdminApiDeps): void {
  const { auth } = deps
  const apiKeyCreateApi = auth.api as unknown as ApiKeyCreation

  app.post('/admin/api-keys', jsonWrite, async (c) => {
    const body = await readJsonBody(c)
    if (!body || !isString(body.name, 1, 32)) return c.json({ error: 'name invalid' }, 400)
    if (!isValidAdminKeyPermissions(body.permissions)) return c.json({ error: 'permissions invalid' }, 400)
    // userId MUST be the better-auth authUserId (session.user.id), NOT
    // c.get('coreUser').id (the RSC-domain `users` table's own separately
    // generated UUID — see storage/sqlite.ts insertUser, `id: randomUUID()`).
    // apiKeyAuthAdmin's verification (api/auth.ts) and better-auth's own
    // /api-key/list + /api-key/delete REST endpoints all key a verified/
    // looked-up key's `referenceId` against the authUserId, exactly like
    // /me/api-keys above does with `userId: session.user.id`. Using
    // coreUser.id here (an earlier version of this route did) mints a key
    // that can never authenticate against any admin-api route (apiKeyAuthAdmin
    // looks up `users.getAuthUserAdminFields(referenceId)`, which finds
    // nothing for a `users`-table id) and is invisible to its own owner's
    // session via the standard list/delete endpoints — found live via Task
    // 6's manual UI check, root-caused, and covered by a regression test
    // above ("a key minted through this route actually works").
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'authentication required' }, 401)
    try {
      const created = await apiKeyCreateApi.createApiKey({
        body: { configId: 'admin', userId: session.user.id, name: body.name, permissions: body.permissions },
      })
      return c.json({ id: created.id, key: created.key, name: created.name, prefix: created.prefix }, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'could not create key' }, 400)
    }
  })

  // --- admin.read routes (phase 4 Task 3b) --------------------------------
  // Key-authed twins of app.ts's cookie-authed GET /admin/sources, /admin/users,
  // /admin/overview, /admin/settings — same validation, same response shapes,
  // transcribed from those exact handlers. Only the auth middleware differs
  // (apiKeyAuthAdmin's per-request admin re-verification vs sessionAuth +
  // requireAdmin's session check).
  const { users, adminEmails, service, sourceRepo, sourceService, logicalStore, feeds, websubMode, pushInEnabled, mailEnabled, pollSeconds } = deps
  const readAdmin = apiKeyAuthAdmin(auth, users, adminEmails, { 'admin.read': ['read'] })

  app.get('/admin-api/sources', readAdmin, async (c) => {
    const args = pageArgs(c)
    if (args instanceof Response) return args
    const filter = c.req.query('filter')
    if (filter !== undefined && filter !== 'governance' && filter !== 'orphan') return c.json({ error: 'filter invalid' }, 400)
    const q = c.req.query('q')
    if (q !== undefined && q.length > 256) return c.json({ error: 'q invalid' }, 400)
    return c.json(await sourceRepo.listSourceSummaries(args.cursor, args.limit, filter as 'governance' | 'orphan' | undefined, q))
  })

  app.get('/admin-api/users', readAdmin, (c) => {
    const args = pageArgs(c)
    if (args instanceof Response) return args
    return c.json(service.listUsers(args.cursor, args.limit))
  })

  app.get('/admin-api/overview', readAdmin, (c) => c.json({
    counts: service.instanceStats(true),
    federation: { websub: websubMode, rssCloud: feeds.rssCloud, pushIn: pushInEnabled, publicUrl: feeds.publicUrl },
    mailEnabled,
    adminEmails: [...adminEmails],
    scheduler: logicalStore.schedulerStats({ now: new Date().toISOString(), pollSeconds }),
  }))

  app.get('/admin-api/settings', readAdmin, async (c) =>
    c.json({
      maxSubsPerUser: Number(await service.getSetting('max_subs_per_user') ?? '500'),
      maxRemoteItemsPerSource: Number(await service.getSetting('max_remote_items_per_source') ?? '0'),
      maxRemoteItemAgeDays: Number(await service.getSetting('max_remote_item_age_days') ?? '0'),
      ...(await readTabOverrides((k) => service.getSetting(k))),
    }))

  // --- admin.sources write routes (phase 4 Task 4) ------------------------
  // Key-authed twins of app.ts's cookie-authed POST /admin/sources/:id/:action
  // and POST /admin/sources — same validation, same sourceService calls,
  // same response-shape branches, transcribed from those exact handlers.
  // ONE addition on the transition route: the ADMIN_API_ALLOWED_ACTIONS
  // allowlist (module scope, above) restricts a key-authed caller to the
  // spec's six named governance verbs — checked BEFORE the transition
  // matrix lookup, so approve/reject/revoke/set_attribution_mode 400 here
  // even though they're valid SOURCE_TRANSITIONS entries the cookie-authed
  // sibling still accepts.
  const writeAdminSources = apiKeyAuthAdmin(auth, users, adminEmails, { 'admin.sources': ['write'] })

  app.post('/admin-api/sources/:id/:action', writeAdminSources, jsonWrite, async (c) => {
    const segment = c.req.param('action') ?? ''
    if (!ADMIN_API_ALLOWED_ACTIONS.has(segment)) return c.json({ error: 'action invalid' }, 400)
    // Route segments are hyphenated; only this one differs from its domain
    // action, every other segment is its action verbatim (same as the
    // cookie-authed sibling — kept for fidelity even though none of the six
    // allowed verbs here is currently hyphenated).
    const action = (segment === 'attribution-mode' ? 'set_attribution_mode' : segment) as SourceTransitionAction
    // hasOwn, not `in`: `constructor`/`__proto__` are inherited keys.
    if (!Object.hasOwn(SOURCE_TRANSITIONS, action)) return c.json({ error: 'action invalid' }, 400)
    const body = await readJsonBody(c)
    if (!body) return c.json({ error: 'body invalid' }, 400)
    const { category, note, commandId, attributionMode } = body
    if (!isString(commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
    // This route's category validation MUST match its cookie-authed sibling
    // (app.ts POST /admin/sources/:id/:action) exactly, hence the aliased
    // import rather than this file's own (wider, V3-moderation) isAuditCategory
    // — see the fix note on that import.
    if (category === undefined || category === null) {
      if (!CATEGORY_OPTIONAL_ACTIONS.has(action)) return c.json({ error: 'category invalid' }, 400)
    } else if (!isSourceGovernanceCategory(category)) return c.json({ error: 'category invalid' }, 400)
    if (note !== undefined && note !== null && !isString(note, 0, 2000)) return c.json({ error: 'note invalid' }, 400)
    // Required for set_attribution_mode, optional-but-valid everywhere else.
    if ((attributionMode !== undefined || action === 'set_attribution_mode') && !isAttributionMode(attributionMode)) return c.json({ error: 'attributionMode invalid' }, 400)

    // The command runs FIRST, so the ledger answers before anything else: a
    // replayed command id returns its stored result (spec §11) instead of
    // being re-judged against state its own first run already changed.
    const id = c.req.param('id') ?? ''
    const result = await sourceService.transition({
      sourceId: id, action, category: isSourceGovernanceCategory(category) ? category : null,
      note: typeof note === 'string' ? note : null,
      ...(isAttributionMode(attributionMode) ? { attributionMode } : {}),
      commandId, actorId: c.get('coreUser').id, actorKind: 'administrator',
    })
    if (result.kind === 'applied') return c.json({ source: result.source, audit: result.audit }, 200)
    // An unknown source is ledgered like any other outcome, so this 404 consumes
    // the commandId: reusing it against a VALID source then conflicts.
    if (result.kind === 'unknown') return c.json({ error: 'unknown source' }, 404)
    // The repository collapses an illegal transition and an idempotency
    // conflict into one {kind:'conflict'}; the exported matrix is what tells
    // them apart, so ask it here — only now that a replay is ruled out.
    const detail = await sourceRepo.getSourceDetail(id)
    if (!detail) return c.json({ error: 'unknown source' }, 404)
    const axes = { operation: detail.source.operation, governance: detail.source.governance, federation: detail.federationStatus }
    if (SOURCE_TRANSITIONS[action](axes) === null) return c.json({ error: 'invalid transition' }, 409)
    return c.json(SOURCES_IDEMPOTENCY_CONFLICT, 409)
  })

  app.post('/admin-api/sources', writeAdminSources, jsonWrite, (c) =>
    establishFederation(c, c.get('coreUser').id, 'administrator', sourceService))

  // --- admin.moderation write routes (phase 4 Task 5) ---------------------
  // Key-authed twins of app.ts's cookie-authed DELETE /admin/users/:handle
  // and DELETE /admin/posts/:id — same service calls, same response-shape
  // branches, transcribed from those exact handlers. Only the auth
  // middleware differs (apiKeyAuthAdmin vs sessionAuth + requireAdmin).
  const writeAdminModeration = apiKeyAuthAdmin(auth, users, adminEmails, { 'admin.moderation': ['write'] })

  app.delete('/admin-api/users/:handle', writeAdminModeration, async (c) => {
    const result = await service.deleteLocalAccount(c.req.param('handle') ?? '')
    if ('error' in result) return c.json({ error: result.error === 'unknown' ? 'unknown user' : 'not a local account' }, result.error === 'unknown' ? 404 : 409)
    return c.json({ ok: true }, 200)
  })

  app.delete('/admin-api/posts/:id', writeAdminModeration, async (c) => {
    const result = await service.deletePost(c.req.param('id') ?? '')
    if ('error' in result) return c.json({ error: result.error === 'unknown' ? 'unknown post' : 'not a local post' }, result.error === 'unknown' ? 404 : 409)
    return c.json({ ok: true }, 200)
  })
}

// =============================================================================
// v2 reserved-handle lookup (V4 spec §3.5) — Task 8
// =============================================================================
// Mounted by server.ts beside the stream route (both need composition pieces
// app.ts does not carry), unconditionally.
//
// Web asks this before rendering /u/:handle: a legacy remote handle converted
// from a single_publisher source is permanently reserved at conversion and
// redirects to its publisher page — an aggregate source's handle is never
// reserved, so /u/:handle just 404s for it as always. The reservation relation
// has NO foreign keys and outlives source removal and purge
// (schema.ts), so a hit here does NOT promise the publisher still exists —
// after a purge the redirect still fires and /p/:publisherId 404s through the
// ordinary not-found path (spec WP5). No post-purge branch exists, here or in web.
export function mountLogicalHandleRoute(app: Hono, deps: { raw: ReadTx }): void {
  app.get('/handles/:handle', (c) => {
    const handle = (c.req.param('handle') ?? '').toLowerCase()
    // ponytail: one indexed primary-key lookup — no snapshot needed for a single
    // statement, and the reservation is immutable once written.
    const row = deps.raw.prepare(`SELECT publisher_id FROM handle_reservations_v2 WHERE handle = ?`).get(handle) as { publisher_id: string } | undefined
    if (!row) return c.json(NEUTRAL_404, 404)
    return c.json({ model: MODEL, handle, reserved: true, publisherId: row.publisher_id })
  })
}

// =============================================================================
// v2 durable SSE transport (spec §5.3-5.5) — Task 10
// =============================================================================
// GET /stream. Mounted (by server.ts) only when the flag is on, on a v2-only path
// with no v1 collision. The journal — never the in-memory bus — is the event
// authority (spec §5.4): the bus supplies only coalesced wake-up sequence hints;
// every frame is projected from the durable journal under CURRENT policy.

export interface LogicalStreamDeps {
  source: LogicalStreamSource
  bus: EventBus
  resolveViewer: (c: Context) => Promise<ProjectionViewer>
  pollMs?: number
  heartbeatMs?: number
}

const RESET_DATA = JSON.stringify({ model: 'logical-v2', kind: 'reset' })
const STREAM_BATCH = 200

export function mountLogicalStreamRoute(app: Hono, deps: LogicalStreamDeps): void {
  const { source, bus, resolveViewer } = deps
  const pollMs = deps.pollMs ?? 1000
  const heartbeatMs = deps.heartbeatMs ?? 15000

  app.get('/stream', (c) =>
    streamSSE(c, async (stream) => {
      const viewer = await resolveViewer(c)

      // Register the wake-up listener BEFORE replay (spec §5.4): a live effect
      // landing during replay must not be lost. The hint is coalesced (highest
      // sequence wins) and is only a wake — the pump re-reads the durable journal.
      let hintHigh = 0
      const off = bus.onSequenceHint((s) => { hintHigh = Math.max(hintHigh, s) })
      stream.onAbort(off)

      // Core accepts the opaque cursor through the Last-Event-ID header (the
      // browser sets it on auto-reconnect and it takes precedence); the initial
      // `?last=` query seeds it. Missing/empty is invalid → reset (Core never
      // silently starts at current high water).
      const cursor = c.req.header('Last-Event-ID') ?? c.req.query('last') ?? null
      const start = source.start(cursor && cursor.length > 0 ? cursor : null)
      if (start.kind === 'reset') {
        await stream.writeSSE({ event: 'reset', data: RESET_DATA }) // synthesized: no invented id
        return // close
      }

      let after = start.afterSequence
      const generation = start.generation

      // Drain the journal from `after` under current policy. Returns true when a
      // reset (stored, generation change, or unsafe reconstruction) closed the run.
      const pump = async (): Promise<boolean> => {
        for (;;) {
          const b = source.batch({ afterSequence: after, generation, viewer, limit: STREAM_BATCH })
          for (const f of b.frames) {
            if (f.control === 'reset') {
              await stream.writeSSE({ event: 'reset', data: RESET_DATA, ...(f.id ? { id: f.id } : {}) })
              return true
            }
            await stream.writeSSE({ event: f.event.kind, id: f.id, data: JSON.stringify(f.event) })
          }
          if (b.done) return true
          if (b.lastSequence <= after) break // caught up
          after = b.lastSequence
        }
        return false
      }

      if (await pump()) return

      let lastHb = Date.now()
      while (!stream.aborted) {
        await stream.sleep(pollMs)
        if (stream.aborted) break
        const nowMs = Date.now()
        const heartbeatDue = nowMs - lastHb >= heartbeatMs
        // Heartbeats are SSE comments AND trigger DB catch-up (spec §5.4).
        if (heartbeatDue) { await stream.write(': hb\n\n'); lastHb = nowMs }
        // A coalesced sequence hint (highest wins) wakes the pump between beats;
        // the heartbeat is the safety catch-up (the bus is never authority — the
        // pump always re-reads the durable journal under current policy).
        if (heartbeatDue || hintHigh > after) {
          if (await pump()) return
        }
      }
    }),
  )
}

// =============================================================================
// Public firehose SSE (2026-08-01 design, phase 1) — GET /firehose/stream
// =============================================================================
// Public, anonymous, no key, no session lookup. Reuses the same
// durable-journal transport as /stream (source.start/source.batch, the bus's
// coalesced sequence hint) but hardcodes an anonymous viewer and reshapes
// every frame: only origin==='local' upserts are emitted, and content is
// rendered through the SAME safe-wire path /users/rss.xml already uses
// (itemContentFields) — never the raw internal DTO, which may carry
// unrendered markdown. A remove frame carries no origin info and is passed
// through unfiltered: a remove for an id whose upsert was filtered out is a
// harmless no-op for any consumer that never saw that id in the first place.

export interface PublicFirehoseDeps {
  source: LogicalStreamSource
  bus: EventBus
  feeds: FeedContext
  pollMs?: number
  heartbeatMs?: number
  maxConnectionsPerIp?: number
  maxConnectionsTotal?: number
}

const FIREHOSE_ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }
const FIREHOSE_RESET = JSON.stringify({ model: 'firehose-v1', kind: 'reset' })
const FIREHOSE_BATCH = 200

function firehoseEntry(item: LogicalItemDto, feeds: FeedContext): Record<string, unknown> {
  const entry = logicalToFeedEntry(item)
  const { description, sourceNs } = itemContentFields(entry)
  const authorUrl = entry.author.kind === 'local' && feeds.publicUrl ? `${feeds.publicUrl}/u/${entry.author.handle}` : entry.author.feedUrl
  return {
    model: 'firehose-v1',
    kind: 'upsert',
    id: item.id,
    title: entry.title,
    content: description,
    // entry.contentMarkdown only ever holds a REMOTE peer's captured markdown;
    // a local post's markdown lives in content and only surfaces here via
    // itemContentFields' sourceNs.markdown (the same value /users/rss.xml emits
    // as source:markdown).
    contentMarkdown: sourceNs?.markdown ?? null,
    url: entry.url,
    publishedAt: entry.publishedAt,
    author: { displayName: entry.author.displayName, url: authorUrl },
    inReplyTo: entry.inReplyTo,
  }
}

export function mountPublicFirehoseRoute(app: Hono, deps: PublicFirehoseDeps): void {
  const { source, bus, feeds } = deps
  const pollMs = deps.pollMs ?? 1000
  const heartbeatMs = deps.heartbeatMs ?? 15000
  const maxPerIp = deps.maxConnectionsPerIp ?? 5
  // A per-IP cap alone bounds nothing: addresses are free, so N attackers get
  // N*5 streams. This endpoint is anonymous, so the GLOBAL ceiling is the one
  // that actually protects the process.
  const maxGlobal = deps.maxConnectionsTotal ?? 50
  // ponytail: single-process in-memory counters, reset on every deploy/restart.
  // Both live prod paths (compose.prod.yaml, Cloudron package) run one Node
  // process per instance today, so this is an accepted, named ceiling — would
  // need a shared store (e.g. Redis) if an instance ever ran multiple replicas
  // behind a load balancer.
  const ipCounts = new Map<string, number>()
  let totalConnections = 0

  // One awaited MACROTASK yield between pump batches. A cursor is unauthenticated
  // and `sequence = 0` is serveable against a journal that is never pruned, so any
  // anonymous caller can demand a full-history replay: without this the `for(;;)`
  // below drains 200-row batches of synchronous db.read + per-row projectItem
  // back-to-back and starves the event loop. `await writeSSE` does NOT help —
  // promise continuations resolve as microtasks, which never reach the check phase
  // where incoming HTTP callbacks are queued (the f612128 poll-tick lesson).
  const breathe = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

  app.get('/firehose/stream', (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (totalConnections >= maxGlobal) return c.json({ error: 'firehose at capacity' }, 429)
    const current = ipCounts.get(ip) ?? 0
    if (current >= maxPerIp) return c.json({ error: 'too many connections from this address' }, 429)
    ipCounts.set(ip, current + 1)
    totalConnections++
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      totalConnections--
      const n = (ipCounts.get(ip) ?? 1) - 1
      if (n <= 0) ipCounts.delete(ip)
      else ipCounts.set(ip, n)
    }

    return streamSSE(c, async (stream) => {
      stream.onAbort(release)
      try {
        let hintHigh = 0
        const off = bus.onSequenceHint((s) => { hintHigh = Math.max(hintHigh, s) })
        stream.onAbort(off)

        const cursor = c.req.header('Last-Event-ID') ?? c.req.query('last') ?? null
        let after: number
        let generation: number
        if (cursor && cursor.length > 0) {
          const start = source.start(cursor)
          if (start.kind === 'reset') {
            await stream.writeSSE({ event: 'reset', data: FIREHOSE_RESET })
            return
          }
          after = start.afterSequence
          generation = start.generation
        } else {
          // No cursor at all is the NORMAL case here (a fresh curl/EventSource
          // client has nothing to send yet) — unlike /stream, which always has an
          // SSR-derived cursor and treats "missing" as a real anomaly worth
          // resetting on, the firehose has no such guarantee. Start tailing from
          // now instead of reset-and-closing a client that never had a cursor to
          // send in the first place.
          const start = source.current()
          after = start.afterSequence
          generation = start.generation
        }

        const pump = async (): Promise<boolean> => {
          for (;;) {
            const b = source.batch({ afterSequence: after, generation, viewer: FIREHOSE_ANON, limit: FIREHOSE_BATCH })
            for (const f of b.frames) {
              if (f.control === 'reset') {
                await stream.writeSSE({ event: 'reset', data: FIREHOSE_RESET, ...(f.id ? { id: f.id } : {}) })
                return true
              }
              if (f.event.kind === 'upsert') {
                if (f.event.item.origin !== 'local') continue
                await stream.writeSSE({ event: 'upsert', id: f.id, data: JSON.stringify(firehoseEntry(f.event.item, feeds)) })
              } else if (f.event.kind === 'remove') {
                // No origin check here, unlike upserts above: a remove frame carries
                // no content/origin, only an opaque id, so passing it through
                // unfiltered is safe — a remove for an id whose upsert was filtered
                // out (a remote item) is a harmless no-op for any consumer that
                // never saw that id.
                await stream.writeSSE({ event: 'remove', id: f.id, data: JSON.stringify({ model: 'firehose-v1', kind: 'remove', id: f.event.logicalItemId }) })
              }
            }
            if (b.done) return true
            if (b.lastSequence <= after) break
            after = b.lastSequence
            await breathe() // let HTTP in between batches — see `breathe` above
          }
          return false
        }

        if (await pump()) return

        let lastHb = Date.now()
        while (!stream.aborted) {
          await stream.sleep(pollMs)
          if (stream.aborted) break
          const nowMs = Date.now()
          const heartbeatDue = nowMs - lastHb >= heartbeatMs
          if (heartbeatDue) { await stream.write(': hb\n\n'); lastHb = nowMs }
          if (heartbeatDue || hintHigh > after) {
            if (await pump()) return
          }
        }
      } finally {
        release()
      }
    })
  })
}
