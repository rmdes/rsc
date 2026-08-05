import type { Hono } from 'hono'
import { jsonWrite, pageArgs, readTabOverrides, establishFederation, isAuditCategory as isSourceGovernanceCategory, IDEMPOTENCY_CONFLICT as SOURCES_IDEMPOTENCY_CONFLICT } from '../app.ts'
import { SOURCE_TRANSITIONS, CATEGORY_OPTIONAL_ACTIONS } from '../../domain/source-repository.ts'
import type { SourceRepository, SourceTransitionAction } from '../../domain/source-repository.ts'
import type { AttributionMode } from '../../domain/types.ts'
import type { Auth } from '../../auth.ts'
import type { UserDirectory } from '../auth.ts'
import { apiKeyAuthAdmin } from '../auth.ts'
import type { Service } from '../../domain/service.ts'
import type { SourceService } from '../../domain/source-service.ts'
import type { FeedContext } from '../../domain/feed.ts'
import { isString, readJsonBody } from './shared.ts'
import type { ApiKeyCreation } from './shared.ts'

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
