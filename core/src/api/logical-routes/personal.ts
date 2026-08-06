import type { Hono, Context } from 'hono'
import { jsonWrite, isBadSourceUrl } from '../app.ts'
import { HandleTakenError } from '../../domain/types.ts'
import type { LogicalStore } from '../../logical/store.ts'
import type { ProjectionViewer, PublicLocalAccount } from '../../logical/types.ts'
import type { Auth } from '../../auth.ts'
import type { UserDirectory } from '../auth.ts'
import { apiKeyAuth } from '../auth.ts'
import type { Service } from '../../domain/service.ts'
import type { SourceService } from '../../domain/source-service.ts'
import { isString, readJsonBody, clampLimit, decodeBeforeCursor, MAX_API_KEYS_PER_USER } from './shared.ts'
import type { ApiKeyCreation } from './shared.ts'

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
    // Security audit M4: without this, a scripted caller could mint keys
    // without bound to cycle past the plugin's per-KEY 300/hr rate limit.
    if ((await users.countApiKeys(session.user.id, 'user')) >= MAX_API_KEYS_PER_USER) {
      return c.json({ error: 'api key limit reached' }, 429)
    }
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
