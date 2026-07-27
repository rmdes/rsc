import type { Hono, Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { jsonWrite } from './app.ts'
import type { EventBus } from '../domain/bus.ts'
import type { LogicalStreamSource } from '../logical/runtime.ts'
import { fingerprintRequest } from '../domain/source-repository.ts'
import { decodeCursor } from '../domain/cursor.ts'
import type { LogicalStore } from '../logical/store.ts'
import type { ReadTx } from '../logical/database.ts'
import type { AcquisitionEngine } from '../logical/acquisition.ts'
import type { CommandEnvelope, AuditCategory } from '../domain/types.ts'
import type { RunCursor, JobCursor, AdminRunProjection, AdminRefreshResult, TimelineLens, TimelineCursorV2, ProjectionViewer, LogicalItemDto, ItemModerationResult } from '../logical/types.ts'
import type { Auth } from '../auth.ts'
import type { UserDirectory } from './auth.ts'
import type { Service } from '../domain/service.ts'
import type { FeedContext } from '../domain/feed.ts'
import { renderFirehoseRss, renderRssFeed, renderJsonFeed, renderCommentsFeed, injectSourceComments, emittedGuid, logicalToFeedEntry } from '../domain/feed.ts'

// The v2 administrative acquisition surface (spec §6.2-6.3): manual refresh plus
// run status/history/job reads. Mounted onto the shared app AFTER the
// `app.use('/admin/*', authed, requireAdmin())` gate so every route is admin-only
// by construction and BEFORE the V1 `/admin/sources/:id/:action` handler so
// `.../refresh` matches this route, not the transition matrix. Operator tokens
// cannot reach these (sessionAuth answers 401 before requireAdmin — V1 Finding 3).

export interface LogicalRouteDeps {
  store: LogicalStore
  acquisition: AcquisitionEngine
  refreshWaitMs?: number
  now?: () => string
}

const MODEL = 'logical-v2'
// The refresh command's request fingerprint inputs are EXACTLY [command, sourceId,
// actor] (spec §6.2, review rev 1 C3). The commandId travels only in the JSON body.
const REFRESH_COMMAND = 'acquisition.refresh'
const NEUTRAL_404 = { model: MODEL, error: 'source unavailable' }
const IDEMPOTENCY_CONFLICT = { model: MODEL, error: 'idempotency conflict' }
const INVALID_CURSOR = { model: MODEL, error: 'invalid cursor' }
const DEFAULT_LIMIT = 50

// V3 review-command fixed non-success bodies (spec §7.3). The neutral 404 is
// uniform across all four mutation routes (unknown item/source/tombstone are
// indistinguishable); the state-conflict 409 bodies are DISTINCT from the
// idempotency-conflict body.
const ITEM_UNAVAILABLE = { model: MODEL, error: 'item unavailable' }
const LOCAL_ORIGIN = { model: MODEL, error: 'local origin' }
const NOT_APPLICABLE = { model: MODEL, error: 'not applicable' }
const NOT_BLOCKED = { model: MODEL, error: 'source not blocked' }

// The eight administrator-selectable values of the NINE-value TS AuditCategory (V3
// re-added false_positive/remediated — the moderation categories; V4 added
// 'migration_review', which conversion writes and no route accepts). Typed as
// AuditCategory[] so a narrowed member fails typecheck here too. Distinct from
// app.ts's narrower six-value list.
const AUDIT_CATEGORIES: ReadonlyArray<AuditCategory> = ['spam', 'abuse', 'illegal_content', 'compromised_source', 'operator_policy', 'false_positive', 'remediated', 'other']
function isAuditCategory(v: unknown): v is AuditCategory {
  return typeof v === 'string' && (AUDIT_CATEGORIES as readonly string[]).includes(v)
}

function isString(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max
}
async function readJsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

// Every V3 mutation body is {commandId, category, note?}: commandId ONLY as the
// JSON body field (no header), category required (it enters the route fingerprint),
// note free text and EXCLUDED from the fingerprint (spec §7.1).
type ModBody = { commandId: string; category: AuditCategory; note: string | null }
async function readModBody(c: Context): Promise<ModBody | Response> {
  const body = await readJsonBody(c)
  if (!body || !isString(body.commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
  if (!isAuditCategory(body.category)) return c.json({ error: 'category invalid' }, 400)
  if (body.note !== undefined && body.note !== null && !isString(body.note, 0, 2000)) return c.json({ error: 'note invalid' }, 400)
  return { commandId: body.commandId, category: body.category, note: typeof body.note === 'string' ? body.note : null }
}

// Disposition mapping for hide/restore (spec §7.3). A matching replay re-maps the
// STORED result to the same 200/404/409 — the body is a pure function of the kind.
function moderationResponse(c: Context, r: ItemModerationResult): Response {
  switch (r.kind) {
    case 'applied': return c.json({ model: MODEL, ...r }, 200)
    case 'unknown': return c.json(ITEM_UNAVAILABLE, 404)
    case 'local_origin': return c.json(LOCAL_ORIGIN, 409)
    case 'not_applicable': return c.json(NOT_APPLICABLE, 409)
    case 'conflict': return c.json(IDEMPOTENCY_CONFLICT, 409)
  }
}

// Decode ?before= through the SHARED tuple codec into a raw 2-tuple (the audit and
// source→items reads map it to their cursor shapes). Neutral invalid-cursor 400 on
// any malformed input, via the shared invalid-cursor table.
function parseTuplePage(c: Context): { before: [string, string] | undefined; limit: number } | Response {
  let before: [string, string] | undefined
  const beforeRaw = c.req.query('before')
  if (beforeRaw !== undefined) {
    const dec = decodeCursor(beforeRaw)
    if (!dec || dec.tuple.length !== 2) return c.json(INVALID_CURSOR, 400)
    before = [dec.tuple[0], dec.tuple[1]]
  }
  const limitRaw = c.req.query('limit')
  const n = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw)
  const limit = Number.isInteger(n) ? Math.max(1, Math.min(100, n)) : DEFAULT_LIMIT
  return { before, limit }
}

// Every paginated read decodes ?before= through the SHARED tuple codec (VP7) and
// answers the neutral invalid-cursor 400 on any malformed input. Immutable tuples:
// runs by (startedAt,runId), jobs by (createdAt,jobId).
function parsePage(c: Context, kind: 'run' | 'job'): { before: RunCursor | JobCursor | undefined; limit: number } | Response {
  let before: RunCursor | JobCursor | undefined
  const beforeRaw = c.req.query('before')
  if (beforeRaw !== undefined) {
    const dec = decodeCursor(beforeRaw)
    if (!dec || dec.tuple.length !== 2) return c.json(INVALID_CURSOR, 400)
    before = kind === 'run'
      ? { startedAt: dec.tuple[0], runId: dec.tuple[1] }
      : { createdAt: dec.tuple[0], jobId: dec.tuple[1] }
  }
  const limitRaw = c.req.query('limit')
  const n = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw)
  const limit = Number.isInteger(n) ? Math.max(1, Math.min(100, n)) : DEFAULT_LIMIT
  return { before, limit }
}

export function mountLogicalRoutes(app: Hono, deps: LogicalRouteDeps): void {
  const { store, acquisition } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const refreshWaitMs = deps.refreshWaitMs ?? 5000

  // Wait up to five seconds (spec §6.2) for the run to reach overall terminal
  // status (acquisition committed AND no open reconciliation job). A zero-job
  // commit is already terminal and returns immediately; otherwise 202.
  async function waitForTerminal(runId: string): Promise<{ proj: AdminRunProjection; terminal: boolean }> {
    const deadline = Date.now() + refreshWaitMs
    for (;;) {
      // The run always exists here — it was just created or joined the active one.
      const proj = store.getRunProjection(runId)!
      if (proj.status === 'terminal') return { proj, terminal: true }
      if (Date.now() >= deadline) return { proj, terminal: false }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  app.post('/admin/sources/:sourceId/refresh', jsonWrite, async (c) => {
    const sourceId = c.req.param('sourceId') ?? ''
    const body = await readJsonBody(c)
    if (!body || !isString(body.commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
    const actorId = c.get('coreUser').id
    const command: CommandEnvelope = {
      actorScope: 'administrator',
      actorId,
      commandId: body.commandId,
      requestFingerprint: fingerprintRequest([REFRESH_COMMAND, sourceId, actorId]),
    }

    const check = store.checkAcquisitionCommand(command)
    if (check.kind === 'conflict') return c.json(IDEMPOTENCY_CONFLICT, 409)
    if (check.kind === 'refused') return c.json(check.refusal as { model: string; error: string }, 404)
    if (check.kind === 'replay') {
      const proj = store.getRunProjection(check.runId)
      if (!proj) return c.json(NEUTRAL_404, 404)
      const result: AdminRefreshResult = { ...proj, disposition: 'replayed' }
      return c.json(result, proj.status === 'terminal' ? 200 : 202)
    }

    // Fresh: an in-flight run means this command joins it (no second fetch).
    const joined = acquisition.inFlight(sourceId)
    const run = await acquisition.acquireSource(sourceId, { kind: 'administrator', command })
    if ('kind' in run) {
      // Ledger the refusal so replay stays a neutral 404 even after the source's
      // state changes (spec §6.2). claimAcquisition wrote nothing for an
      // unavailable source, so the ledger row is written here.
      store.ledgerRefusal({ command, refusal: NEUTRAL_404, now: now() })
      return c.json(NEUTRAL_404, 404)
    }
    const disposition = joined ? ('joined' as const) : ('created' as const)
    // A genuine new run (not one this command merely joined) just completed a
    // fetch — record it into the same durable health the scheduler updates
    // (spec §1.3), so skip-if-recent counts this manual poll. A joined run's
    // health is recorded by whichever call owns it (the scheduler tick or the
    // earlier refresh that started it) — recording here too would double-write.
    if (disposition === 'created') {
      store.recordHealth({ sourceId, outcome: run.outcome, now: now() })
    }
    const { proj, terminal } = await waitForTerminal(run.runId)
    const result: AdminRefreshResult = { ...proj, disposition }
    return c.json(result, terminal ? 200 : 202)
  })

  app.get('/admin/acquisition-runs/:runId', (c) => {
    const run = store.getRun(c.req.param('runId') ?? '')
    if (!run) return c.json({ model: MODEL, error: 'unknown run' }, 404)
    return c.json(run)
  })

  app.get('/admin/sources/:sourceId/runs', (c) => {
    const page = parsePage(c, 'run')
    if (page instanceof Response) return page
    return c.json(store.listRuns(c.req.param('sourceId') ?? '', page.before as RunCursor | undefined, page.limit))
  })

  app.get('/admin/acquisition-runs/:runId/jobs', (c) => {
    const page = parsePage(c, 'job')
    if (page instanceof Response) return page
    return c.json(store.listJobs(c.req.param('runId') ?? '', page.before as JobCursor | undefined, page.limit))
  })

  // --- V3 review mutations (spec §7.3, §1.1, §5.2) ------------------------
  // Each composes jsonWrite positionally, takes {commandId, category, note?} in the
  // JSON body, folds the pinned fingerprint (notes excluded, category included),
  // and maps the store result's kind to the fixed 200/404/409 bodies. Registered
  // before app.ts's /admin/sources/:id/:action transition matrix so `.../purge`
  // matches here, not the matrix (like /refresh above).
  app.post('/admin/items/:logicalItemId/hide', jsonWrite, async (c) => {
    const logicalItemId = c.req.param('logicalItemId') ?? ''
    const b = await readModBody(c)
    if (b instanceof Response) return b
    const actorId = c.get('coreUser').id
    const command: CommandEnvelope = { actorScope: 'administrator', actorId, commandId: b.commandId, requestFingerprint: fingerprintRequest(['hide', logicalItemId, actorId, b.category]) }
    return moderationResponse(c, store.hideItem({ command, logicalItemId, category: b.category, note: b.note, now: now() }))
  })

  app.post('/admin/items/:logicalItemId/restore', jsonWrite, async (c) => {
    const logicalItemId = c.req.param('logicalItemId') ?? ''
    const b = await readModBody(c)
    if (b instanceof Response) return b
    const actorId = c.get('coreUser').id
    const command: CommandEnvelope = { actorScope: 'administrator', actorId, commandId: b.commandId, requestFingerprint: fingerprintRequest(['restore', logicalItemId, actorId, b.category]) }
    return moderationResponse(c, store.restoreItem({ command, logicalItemId, category: b.category, note: b.note, now: now() }))
  })

  app.post('/admin/sources/:sourceId/purge', jsonWrite, async (c) => {
    const sourceId = c.req.param('sourceId') ?? ''
    const b = await readModBody(c)
    if (b instanceof Response) return b
    const actorId = c.get('coreUser').id
    const command: CommandEnvelope = { actorScope: 'administrator', actorId, commandId: b.commandId, requestFingerprint: fingerprintRequest(['purge', sourceId, actorId, b.category]) }
    const result = store.purgeSource({ command, sourceId, category: b.category, note: b.note, now: now() })
    switch (result.kind) {
      case 'purged': return c.json({ model: MODEL, ...result }, 200)
      case 'unknown': return c.json(ITEM_UNAVAILABLE, 404)
      case 'not_blocked': return c.json(NOT_BLOCKED, 409)
      case 'conflict': return c.json(IDEMPOTENCY_CONFLICT, 409)
    }
  })

  app.post('/admin/tombstones/:tombstoneId/unblock', jsonWrite, async (c) => {
    const tombstoneId = c.req.param('tombstoneId') ?? ''
    const b = await readModBody(c)
    if (b instanceof Response) return b
    const actorId = c.get('coreUser').id
    const command: CommandEnvelope = { actorScope: 'administrator', actorId, commandId: b.commandId, requestFingerprint: fingerprintRequest(['tombstone-unblock', tombstoneId, actorId, b.category]) }
    const result = store.unblockTombstone({ command, tombstoneId, category: b.category, note: b.note, now: now() })
    switch (result.kind) {
      case 'unblocked': return c.json({ model: MODEL, ...result }, 200)
      case 'unknown': return c.json(ITEM_UNAVAILABLE, 404)
      case 'conflict': return c.json(IDEMPOTENCY_CONFLICT, 409)
    }
  })

  // --- V3 review reads (spec §7.3) ----------------------------------------
  // Bounded item detail; audit + source→items paginate via the shared codec + the
  // shared invalid-cursor table; tombstones list unpaginated (spec: only audit and
  // source→items page). Every envelope carries model:'logical-v2'.
  app.get('/admin/items/:logicalItemId', (c) => {
    const detail = store.getAdminItemDetail(c.req.param('logicalItemId') ?? '')
    if (!detail) return c.json(ITEM_UNAVAILABLE, 404)
    return c.json(detail)
  })

  app.get('/admin/items/:logicalItemId/audit', (c) => {
    const page = parseTuplePage(c)
    if (page instanceof Response) return page
    const cursor = page.before ? { createdAt: page.before[0], id: page.before[1] } : undefined
    return c.json(store.listItemAudit(c.req.param('logicalItemId') ?? '', cursor, page.limit))
  })

  app.get('/admin/sources/:sourceId/items', (c) => {
    const page = parseTuplePage(c)
    if (page instanceof Response) return page
    const cursor = page.before ? { timelineSortAt: page.before[0], logicalItemId: page.before[1] } : undefined
    return c.json(store.listSourceItems(c.req.param('sourceId') ?? '', cursor, page.limit))
  })

  app.get('/admin/tombstones', (c) => c.json({ model: MODEL, tombstones: store.listTombstones() }))
}

// =============================================================================
// v2 ordinary read + feed surface (spec §3.4-3.6, §4.3, §4.5, §4.6) — Task 8
// =============================================================================
// Mounted (by app.ts) unconditionally, on every content path (/timeline,
// /post/:id/thread, /posts/:id/revisions, /users/rss.xml, /users/:handle/feed.*,
// /post/:id/comments.xml) plus GET /post/:id (the v2-only single-item route).

export interface LogicalReadDeps {
  store: LogicalStore
  auth: Auth
  users: UserDirectory
  service: Service
  feeds: FeedContext
}

const FEED_LIMIT = 50
const XML = { 'content-type': 'application/rss+xml; charset=utf-8' }

// The six lens selectors (spec §3.5), parsed strictly from the query BEFORE any DB
// work. Personal/local_author/publisher carry a raw key resolved inside the read
// snapshot. Anything malformed collapses to the single 'invalid' answer.
type LensSpec =
  | { kind: 'public' } | { kind: 'local' } | { kind: 'federated' }
  | { kind: 'personal'; handle: string } | { kind: 'local_author'; handle: string }
  | { kind: 'publisher'; publisherId: string }

const LENS_KEYS = ['origin', 'followed_by', 'author', 'publisher', 'federated'] as const
// v1/legacy selectors that are invalid in v2 (spec §3.5): source, feed_type,
// top_level, and federated=false all return the same 'invalid lens'.
const FORBIDDEN_KEYS = ['source', 'feed_type', 'top_level'] as const

function parseLensSpec(c: Context): LensSpec | 'invalid' {
  for (const k of FORBIDDEN_KEYS) if (c.req.query(k) !== undefined) return 'invalid'
  const present: string[] = []
  for (const k of LENS_KEYS) {
    const vals = c.req.queries(k)
    if (vals === undefined || vals.length === 0) continue
    if (vals.length > 1) return 'invalid' // duplicate selector
    present.push(k)
  }
  if (present.length > 1) return 'invalid' // combined selectors
  if (present.length === 0) return { kind: 'public' }
  const key = present[0]
  const v = c.req.query(key) ?? ''
  if (v === '') return 'invalid' // empty selector
  if (key === 'origin') return v === 'local' ? { kind: 'local' } : 'invalid'
  if (key === 'federated') return v === 'true' ? { kind: 'federated' } : 'invalid'
  if (key === 'followed_by') return { kind: 'personal', handle: v }
  if (key === 'author') return { kind: 'local_author', handle: v }
  return { kind: 'publisher', publisherId: v }
}

function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return FEED_LIMIT
  const n = Number(raw)
  return Number.isInteger(n) ? Math.max(1, Math.min(100, n)) : FEED_LIMIT
}

export function mountLogicalReadRoutes(app: Hono, deps: LogicalReadDeps): void {
  const { store, auth, users, service, feeds } = deps
  const ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }
  const NOT_FOUND = { error: 'not found' }

  // Optional viewer: the authenticated account when a session is present, else
  // anonymous. A read NEVER mints a guest (no ensureCoreUser) and NEVER writes.
  async function viewerAccount(c: Context): Promise<string | null> {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return null
    const u = await users.getUserByAuthUserId(session.user.id)
    return u ? u.id : null
  }

  // --- GET /timeline (spec §3.5) ------------------------------------------
  app.get('/timeline', async (c) => {
    const spec = parseLensSpec(c)
    if (spec === 'invalid') return c.json({ error: 'invalid lens' }, 400)
    let before: TimelineCursorV2 | null = null
    const beforeRaw = c.req.query('before')
    if (beforeRaw !== undefined) {
      const dec = decodeCursor(beforeRaw)
      if (!dec || dec.tuple.length !== 2) return c.json({ error: 'invalid cursor' }, 400)
      before = { version: 1, timelineSortAt: dec.tuple[0], logicalItemId: dec.tuple[1] }
    }
    const limit = clampLimit(c.req.query('limit'))
    const viewer: ProjectionViewer = { localAccountId: await viewerAccount(c), activeSourceIds: [] }
    const result = store.snapshot((tx) => {
      let lens: TimelineLens
      if (spec.kind === 'personal' || spec.kind === 'local_author') {
        const acc = tx.resolveLocalAccount(spec.handle)
        if (!acc) return 'notfound' as const
        lens = spec.kind === 'personal' ? { kind: 'personal', account: acc } : { kind: 'local_author', account: acc }
      } else if (spec.kind === 'publisher') {
        const pub = tx.resolvePublisher(spec.publisherId)
        if (!pub) return 'notfound' as const
        lens = { kind: 'publisher', publisher: pub }
      } else {
        lens = { kind: spec.kind }
      }
      return tx.projectTimeline({ lens, before, limit, viewer })
    })
    if (result === 'notfound') return c.json(NOT_FOUND, 404)
    return c.json(result)
  })

  // --- GET /post/:id — deliberate v2-only single-item route (spec §3.4) ----
  app.get('/post/:id', async (c) => {
    const viewer: ProjectionViewer = { localAccountId: await viewerAccount(c), activeSourceIds: [] }
    const env = store.snapshot((tx) => {
      const item = tx.projectItem(c.req.param('id') ?? '', viewer)
      return item ? { model: 'logical-v2' as const, item, journalCursor: tx.journalCursor() } : null
    })
    if (!env) return c.json(NOT_FOUND, 404)
    return c.json(env)
  })

  // --- GET /post/:id/thread (spec §4.3) ------------------------------------
  app.get('/post/:id/thread', async (c) => {
    const viewer: ProjectionViewer = { localAccountId: await viewerAccount(c), activeSourceIds: [] }
    const env = store.snapshot((tx) => tx.projectThread(c.req.param('id') ?? '', viewer))
    if (!env) return c.json(NOT_FOUND, 404)
    return c.json(env)
  })

  // --- GET /posts/:id/revisions — history (spec §4.5) ----------------------
  app.get('/posts/:id/revisions', async (c) => {
    const viewer: ProjectionViewer = { localAccountId: await viewerAccount(c), activeSourceIds: [] }
    const env = store.snapshot((tx) => tx.projectHistory(c.req.param('id') ?? '', viewer))
    if (!env) return c.json(NOT_FOUND, 404)
    return c.json(env)
  })

  // --- feeds (spec §4.6): central projector, no placeholders ---------------

  function injectComments(xml: string, items: LogicalItemDto[]): string {
    if (!feeds.publicUrl) return xml
    const pub = feeds.publicUrl
    return injectSourceComments(xml, items.filter((d) => d.directReplyCount > 0)
      .map((d) => ({ guid: emittedGuid(logicalToFeedEntry(d)), count: d.directReplyCount, feedUrl: `${pub}/post/${d.id}/comments.xml` })))
  }

  // The all-users firehose: origin=local WITHOUT the river predicate (transports
  // local replies). Static route — wins over /users/:handle/feed.xml.
  app.get('/users/rss.xml', (c) => {
    const items = store.snapshot((tx) => tx.projectLocalActivity({ authorId: null, limit: FEED_LIMIT }))
    const xml = injectComments(renderFirehoseRss(items.map(logicalToFeedEntry), feeds), items)
    return c.body(xml, 200, XML)
  })

  // Local-account feeds use the local_author (activity) lens. A remote handle
  // redirects to its origin feed exactly like v1 (existing URLs stay stable).
  async function feedAccount(c: Context): Promise<{ id: string } | Response> {
    const handle = (c.req.param('handle') ?? '').toLowerCase()
    const user = await service.getUserByHandle(handle)
    if (!user) return c.json({ error: 'unknown user' }, 404)
    if (user.kind === 'remote') {
      if (!user.feedUrl) return c.json({ error: 'unknown user' }, 404)
      return c.redirect(user.feedUrl, 302)
    }
    return { id: user.id }
  }

  app.get('/users/:handle/feed.xml', async (c) => {
    const r = await feedAccount(c)
    if (r instanceof Response) return r
    const items = store.snapshot((tx) => tx.projectLocalActivity({ authorId: r.id, limit: FEED_LIMIT }))
    const author = items[0]?.selectedAuthor
    const user = { id: r.id, kind: 'local' as const, handle: (c.req.param('handle') ?? '').toLowerCase(), displayName: author && author.kind === 'local' ? author.displayName : (c.req.param('handle') ?? ''), feedUrl: null, createdAt: '', authUserId: null }
    const xml = injectComments(renderRssFeed(user, items.map(logicalToFeedEntry), feeds), items)
    return c.body(xml, 200, XML)
  })

  app.get('/users/:handle/feed.json', async (c) => {
    const r = await feedAccount(c)
    if (r instanceof Response) return r
    const items = store.snapshot((tx) => tx.projectLocalActivity({ authorId: r.id, limit: FEED_LIMIT }))
    const author = items[0]?.selectedAuthor
    const user = { id: r.id, kind: 'local' as const, handle: (c.req.param('handle') ?? '').toLowerCase(), displayName: author && author.kind === 'local' ? author.displayName : (c.req.param('handle') ?? ''), feedUrl: null, createdAt: '', authUserId: null }
    return c.body(renderJsonFeed(user, items.map(logicalToFeedEntry), feeds), 200, { 'content-type': 'application/feed+json; charset=utf-8' })
  })

  // Comments feed: bounded thread projector for policy/safety, but serializes
  // ordinary-visible DIRECT replies only (spec §4.6). Never serializes placeholders.
  app.get('/post/:id/comments.xml', (c) => {
    const id = c.req.param('id') ?? ''
    const data = store.snapshot((tx) => {
      const item = tx.projectItem(id, ANON)
      if (!item) return null
      const thread = tx.projectThread(id, ANON)
      const replies = (thread?.nodes ?? [])
        .filter((n): n is { kind: 'item'; item: LogicalItemDto } => n.kind === 'item' && n.item.parentLogicalItemId === id)
        .map((n) => n.item)
      return { item, replies }
    })
    if (!data) return c.json({ error: 'unknown post' }, 404)
    let xml = renderCommentsFeed(logicalToFeedEntry(data.item), data.replies.map(logicalToFeedEntry), feeds)
    xml = injectComments(xml, data.replies)
    return c.body(xml, 200, XML)
  })
}

// =============================================================================
// v2 reserved-handle lookup (V4 spec §3.5) — Task 8
// =============================================================================
// Mounted by server.ts beside the stream route (both need composition pieces
// app.ts does not carry), unconditionally.
//
// Web asks this before rendering /u/:handle: every legacy remote handle is
// permanently reserved at conversion and redirects to its publisher page. The
// reservation relation has NO foreign keys and outlives source removal and purge
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
