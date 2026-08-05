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
export * from './logical-routes/personal.ts'

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
