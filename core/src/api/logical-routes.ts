import type { Hono, Context } from 'hono'
import { jsonWrite } from './app.ts'
import { fingerprintRequest } from '../domain/source-repository.ts'
import { decodeCursor } from '../domain/cursor.ts'
import type { LogicalStore } from '../logical/store.ts'
import type { AcquisitionEngine } from '../logical/acquisition.ts'
import type { CommandEnvelope } from '../domain/types.ts'
import type { RunCursor, JobCursor, AdminRunProjection } from '../logical/types.ts'

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
      return c.json({ ...proj, disposition: 'replayed' as const }, proj.status === 'terminal' ? 200 : 202)
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
    const { proj, terminal } = await waitForTerminal(run.runId)
    return c.json({ ...proj, disposition }, terminal ? 200 : 202)
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
}
