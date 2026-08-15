import type { Hono, Context } from 'hono'
import { jsonWrite } from '../app.ts'
import { fingerprintRequest } from '../../domain/source-repository.ts'
import { decodeCursor } from '../../domain/cursor.ts'
import type { LogicalStore } from '../../logical/store.ts'
import type { AcquisitionEngine } from '../../logical/acquisition.ts'
import type { CommandEnvelope, AuditCategory } from '../../domain/types.ts'
import type { RunCursor, JobCursor, AdminRunProjection, AdminRefreshResult, ItemModerationResult } from '../../logical/types.ts'
import { MODEL, NEUTRAL_404, isString, readJsonBody, isAuditCategory } from './shared.ts'

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

// The refresh command's request fingerprint inputs are EXACTLY [command, sourceId,
// actor] (spec §6.2, review rev 1 C3). The commandId travels only in the JSON body.
const REFRESH_COMMAND = 'acquisition.refresh'
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

// isAuditCategory (the eight administrator-selectable values of the NINE-value
// TS AuditCategory) now lives in shared.ts, reused by DELETE /admin/posts/:id
// and /admin-api/posts/:id's readRemovalBody — same moderation vocabulary,
// one list. Distinct from app.ts's narrower six-value source-governance list.

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
