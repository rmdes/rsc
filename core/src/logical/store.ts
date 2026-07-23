import type { DatabaseContext, ReadTx } from './database.ts'
import type {
  LogicalReadTx, SourceModelV2Activation, LogicalItemDto, ClaimAcquisitionInput, ClaimAcquisitionResult,
  CommitAcquisitionInput, FailAcquisitionInput, AcquisitionRun,
  AdminAcquisitionRun, AdminRunProjection, AdminReconciliationJobSummary, AdminPage,
  RunCursor, JobCursor, AdminFetchProjection, AdminReconciliationCounters, AdminAcquisitionCounters,
} from './types.ts'
import type { User, CommandEnvelope } from '../domain/types.ts'
import { getJournalMetadata } from './journal.ts'
import { createLocalPost, editLocalPost, deleteLocalPost, deleteLocalAccount } from './local.ts'
import { claimAcquisition, commitAcquisition, failAcquisition, BOUNDS } from './acquisition.ts'
import { encodeCursor } from '../domain/cursor.ts'

// Bounded transactional reads/writes over the logical-v2 schema (plan File map,
// VP6: the concrete factory is exported and TS infers its type — no LogicalStore
// interface). Task 2 realizes only the read seam's activation + journal-metadata
// reads; later tasks widen both the snapshot callback shape and the store's
// write methods (claimAcquisition, commitAcquisition, reconcileClaim, …).

// The subset of LogicalReadTx Task 2 implements. Later tasks broaden this Pick.
type ReadSeam = Pick<LogicalReadTx, 'getActivation' | 'getJournalMetadata'>

function makeReadTx(tx: ReadTx): ReadSeam {
  return {
    getActivation(): SourceModelV2Activation {
      const row = tx.prepare(
        `SELECT schema_version, state, last_activated_at, last_reconciled_at
         FROM logical_activation_v2 WHERE singleton = 1`,
      ).get() as { schema_version: 1; state: SourceModelV2Activation['state']; last_activated_at: string | null; last_reconciled_at: string | null }
      return {
        schemaVersion: row.schema_version,
        state: row.state,
        lastActivatedAt: row.last_activated_at,
        lastReconciledAt: row.last_reconciled_at,
      }
    },
    getJournalMetadata: () => getJournalMetadata(tx),
  }
}

// --- admin acquisition projections (spec §6.2-6.3) ---------------------------
// The run row (acquisition_runs_v2) stores outcome/counters/timestamps but NOT
// the final effective URL, HTTP status, or parser adapter/version — Task 4's
// schema has no columns for them. So the projection derives effectiveUrl from the
// run's redirect evidence (else the source's canonical URL), maps not_modified to
// 304, and sources the versioned constants from BOUNDS. parserAdapter/parserVersion
// are per-run and unpersisted, hence null.
// ponytail: derive effectiveUrl/httpStatus from what the run persists; add run
// columns only if an operator needs the exact final status of a parsed poll.

const IDENTIFIER_NORMALIZATION_VERSION = 'v1'
const RUN_COLUMNS = `id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic`

interface RunRow {
  id: string
  source_id: string
  reason: 'scheduled' | 'administrator_refresh'
  status: 'processing' | 'terminal'
  started_at: string
  acquisition_committed_at: string | null
  completed_at: string | null
  outcome: AdminFetchProjection['outcome']
  counters_json: string
  failure_category: AdminFetchProjection['failureCategory']
  diagnostic: string | null
}

// Overall run terminality (spec §2.1: terminal = pending + processing + retrying
// = 0). The row's own status tracks the acquisition transaction; a run is only
// "terminal" for admin purposes once no reconciliation job is still open.
function overallStatus(tx: ReadTx, row: RunRow): 'terminal' | 'processing' {
  if (row.status === 'processing') return 'processing'
  const n = (tx.prepare(`SELECT COUNT(*) AS n FROM reconciliation_jobs_v2 WHERE run_id = ? AND status IN ('pending','processing','retrying')`).get(row.id) as { n: number }).n
  return n === 0 ? 'terminal' : 'processing'
}

function effectiveUrlFor(tx: ReadTx, row: RunRow): string | null {
  const redirect = tx.prepare(`SELECT to_evidence FROM redirect_observations_v2 WHERE run_id = ? ORDER BY ordinal DESC LIMIT 1`).get(row.id) as { to_evidence: string } | undefined
  if (redirect) return redirect.to_evidence
  const src = tx.prepare(`SELECT canonical_url FROM remote_sources_v2 WHERE id = ?`).get(row.source_id) as { canonical_url: string } | undefined
  return src?.canonical_url ?? null
}

function reconciliationCounters(tx: ReadTx, runId: string): AdminReconciliationCounters {
  const rows = tx.prepare(`SELECT status, failure_category, COUNT(*) AS n FROM reconciliation_jobs_v2 WHERE run_id = ? GROUP BY status, failure_category`).all(runId) as { status: string; failure_category: string | null; n: number }[]
  const c: AdminReconciliationCounters = { reconciled: 0, conflicted: 0, pending: 0, processing: 0, retrying: 0, failed: 0, failedByCategory: { operationalExhausted: 0, invariantOrDataFailure: 0 } }
  for (const r of rows) {
    if (r.status === 'reconciled') c.reconciled += r.n
    else if (r.status === 'conflicted') c.conflicted += r.n
    else if (r.status === 'pending') c.pending += r.n
    else if (r.status === 'processing') c.processing += r.n
    else if (r.status === 'retrying') c.retrying += r.n
    else if (r.status === 'failed') {
      c.failed += r.n
      if (r.failure_category === 'operational_exhausted') c.failedByCategory.operationalExhausted += r.n
      else if (r.failure_category === 'invariant_or_data_failure') c.failedByCategory.invariantOrDataFailure += r.n
    }
  }
  return c
}

function runProjection(tx: ReadTx, row: RunRow): AdminRunProjection {
  return {
    model: 'logical-v2',
    runId: row.id,
    sourceId: row.source_id,
    status: overallStatus(tx, row),
    statusLocation: `/admin/acquisition-runs/${row.id}`,
    fetch: {
      outcome: row.outcome,
      effectiveUrl: effectiveUrlFor(tx, row),
      httpStatus: row.outcome === 'not_modified' ? 304 : null,
      failureCategory: row.failure_category,
      diagnostic: row.diagnostic,
    },
    acquisition: JSON.parse(row.counters_json) as AdminAcquisitionCounters,
    reconciliation: reconciliationCounters(tx, row.id),
  }
}

function acquisitionRun(tx: ReadTx, row: RunRow): AdminAcquisitionRun {
  return {
    ...runProjection(tx, row),
    reason: row.reason,
    startedAt: row.started_at,
    acquisitionCommittedAt: row.acquisition_committed_at,
    completedAt: row.completed_at,
    versions: {
      parserAdapter: null,
      parserVersion: null,
      boundsProfileVersion: BOUNDS.boundsProfileVersion,
      identifierNormalizationVersion: IDENTIFIER_NORMALIZATION_VERSION,
      fingerprintVersion: String(BOUNDS.fingerprintVersion),
    },
  }
}

const JOB_COLUMNS = `id, created_at, status, attempts, next_attempt_at, failure_category, diagnostic`
interface JobRow {
  id: string
  created_at: string
  status: AdminReconciliationJobSummary['status']
  attempts: number
  next_attempt_at: string | null
  failure_category: AdminReconciliationJobSummary['failureCategory']
  diagnostic: string | null
}

// The refresh command ledger decision (spec §6.2), read from acquisition_commands_v2.
export type RefreshLedgerCheck =
  | { kind: 'fresh' }
  | { kind: 'conflict' }
  | { kind: 'refused'; refusal: unknown }
  | { kind: 'replay'; runId: string }

// The local-mutation write seam (Task 3): each command runs inside ONE db.write()
// so local storage, logical metadata, and journal effects commit atomically (spec
// §2.6). service.ts routes v2-on local mutations here; later tasks widen the store
// with acquisition/reconciliation write methods.
export function createLogicalStore(db: DatabaseContext) {
  return {
    snapshot<T>(fn: (tx: ReadSeam) => T): T {
      return db.read((tx) => fn(makeReadTx(tx)))
    },
    createLocalPost(input: { author: User; content: string; replyToId: string | null; now: string }): LogicalItemDto {
      return db.write((tx) => createLocalPost({ tx, ...input }))
    },
    editLocalPost(input: { postId: string; authorId: string; content: string; now: string }): LogicalItemDto {
      return db.write((tx) => editLocalPost({ tx, ...input }))
    },
    deleteLocalPost(input: { postId: string; actorId: string; now: string }): void {
      db.write((tx) => deleteLocalPost({ tx, ...input }))
    },
    deleteLocalAccount(input: { accountId: string; actorId: string; now: string }): void {
      db.write((tx) => deleteLocalAccount({ tx, ...input }))
    },
    // Acquisition write seam (Task 4). The two-transaction protocol (spec §1.4)
    // is driven by the acquisition engine: claim commits in its own db.write()
    // before the acquisition-result db.write() (commit/fail). Each is one atomic
    // transaction; the engine sequences them.
    claimAcquisition(input: ClaimAcquisitionInput): ClaimAcquisitionResult {
      return db.write((tx) => claimAcquisition(tx, input))
    },
    commitAcquisition(input: CommitAcquisitionInput): AcquisitionRun {
      return db.write((tx) => commitAcquisition(tx, input))
    },
    failAcquisition(input: FailAcquisitionInput): AcquisitionRun {
      return db.write((tx) => failAcquisition(tx, input))
    },

    // --- admin acquisition reads (Task 5) ---------------------------------
    getRun(runId: string): AdminAcquisitionRun | undefined {
      return db.read((tx) => {
        const row = tx.prepare(`SELECT ${RUN_COLUMNS} FROM acquisition_runs_v2 WHERE id = ?`).get(runId) as RunRow | undefined
        return row ? acquisitionRun(tx, row) : undefined
      })
    },
    getRunProjection(runId: string): AdminRunProjection | undefined {
      return db.read((tx) => {
        const row = tx.prepare(`SELECT ${RUN_COLUMNS} FROM acquisition_runs_v2 WHERE id = ?`).get(runId) as RunRow | undefined
        return row ? runProjection(tx, row) : undefined
      })
    },
    listRuns(sourceId: string, before: RunCursor | undefined, limit: number): AdminPage<AdminRunProjection> {
      return db.read((tx) => {
        const rows = (before
          ? tx.prepare(`SELECT ${RUN_COLUMNS} FROM acquisition_runs_v2 WHERE source_id = ? AND (started_at < ? OR (started_at = ? AND id < ?)) ORDER BY started_at DESC, id DESC LIMIT ?`).all(sourceId, before.startedAt, before.startedAt, before.runId, limit + 1)
          : tx.prepare(`SELECT ${RUN_COLUMNS} FROM acquisition_runs_v2 WHERE source_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`).all(sourceId, limit + 1)) as RunRow[]
        const page = rows.slice(0, limit)
        const last = page[page.length - 1]
        const nextCursor = rows.length > limit && last ? encodeCursor(1, [last.started_at, last.id]) : null
        return { model: 'logical-v2', items: page.map((r) => runProjection(tx, r)), nextCursor }
      })
    },
    listJobs(runId: string, before: JobCursor | undefined, limit: number): AdminPage<AdminReconciliationJobSummary> {
      return db.read((tx) => {
        const rows = (before
          ? tx.prepare(`SELECT ${JOB_COLUMNS} FROM reconciliation_jobs_v2 WHERE run_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT ?`).all(runId, before.createdAt, before.createdAt, before.jobId, limit + 1)
          : tx.prepare(`SELECT ${JOB_COLUMNS} FROM reconciliation_jobs_v2 WHERE run_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`).all(runId, limit + 1)) as JobRow[]
        const page = rows.slice(0, limit)
        const last = page[page.length - 1]
        const nextCursor = rows.length > limit && last ? encodeCursor(1, [last.created_at, last.id]) : null
        return { model: 'logical-v2', items: page.map((r) => ({ jobId: r.id, createdAt: r.created_at, status: r.status, attempts: r.attempts, nextAttemptAt: r.next_attempt_at, failureCategory: r.failure_category, diagnostic: r.diagnostic })), nextCursor }
      })
    },

    // --- refresh command ledger (spec §6.2) -------------------------------
    checkAcquisitionCommand(command: CommandEnvelope): RefreshLedgerCheck {
      return db.read((tx) => {
        const row = tx.prepare(`SELECT request_fingerprint, run_id, refusal_json FROM acquisition_commands_v2 WHERE actor_id = ? AND command_id = ?`).get(command.actorId, command.commandId) as { request_fingerprint: string; run_id: string | null; refusal_json: string | null } | undefined
        if (!row) return { kind: 'fresh' }
        if (row.request_fingerprint !== command.requestFingerprint) return { kind: 'conflict' }
        if (row.refusal_json != null) return { kind: 'refused', refusal: JSON.parse(row.refusal_json) }
        if (row.run_id != null) return { kind: 'replay', runId: row.run_id }
        return { kind: 'fresh' }
      })
    },
    // A valid command against an unavailable source is LEDGERED so replay returns
    // the same refusal even after the source's state changes (spec §6.2).
    ledgerRefusal(input: { command: CommandEnvelope; refusal: unknown; now: string }): void {
      db.write((tx) => {
        tx.prepare(`INSERT INTO acquisition_commands_v2 (actor_id, command_id, request_fingerprint, run_id, refusal_json, created_at) VALUES (?, ?, ?, NULL, ?, ?)`)
          .run(input.command.actorId, input.command.commandId, input.command.requestFingerprint, JSON.stringify(input.refusal), input.now)
      })
    },

    // --- scheduler support (spec §1.3) ------------------------------------
    listSchedulableSources(): string[] {
      return db.read((tx) => {
        const rows = tx.prepare(
          `SELECT s.id FROM remote_sources_v2 s
           WHERE s.operation = 'enabled' AND s.governance != 'blocked'
             AND (EXISTS (SELECT 1 FROM source_subscriptions_v2 sub WHERE sub.source_id = s.id AND sub.state = 'active')
                  OR EXISTS (SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = s.id))
           ORDER BY s.id ASC`,
        ).all() as { id: string }[]
        return rows.map((r) => r.id)
      })
    },
    getHealth(sourceId: string): { lastPollAt: string | null } | undefined {
      return db.read((tx) => {
        const r = tx.prepare(`SELECT last_poll_at FROM source_health_v2 WHERE source_id = ?`).get(sourceId) as { last_poll_at: string | null } | undefined
        return r ? { lastPollAt: r.last_poll_at } : undefined
      })
    },
    // Durable per-source health (spec §1.3): success/304/truncation/committed
    // conflict reset the failure count; operational failures increment it;
    // cancellation/supersession/policy rejection only bump the poll timestamp.
    recordHealth(input: { sourceId: string; outcome: AdminFetchProjection['outcome']; now: string }): void {
      const { sourceId, outcome, now } = input
      const success = outcome === 'parsed' || outcome === 'completed_truncated' || outcome === 'not_modified' || outcome === 'redirect_conflict'
      const opFailure = outcome === 'operational_failure'
      db.write((tx) => {
        const existing = tx.prepare(`SELECT source_id FROM source_health_v2 WHERE source_id = ?`).get(sourceId)
        if (!existing) {
          tx.prepare(`INSERT INTO source_health_v2 (source_id, last_poll_at, last_success_at, last_failure_at, consecutive_failures) VALUES (?, ?, ?, ?, ?)`)
            .run(sourceId, now, success ? now : null, opFailure ? now : null, opFailure ? 1 : 0)
        } else if (success) {
          tx.prepare(`UPDATE source_health_v2 SET last_poll_at = ?, last_success_at = ?, consecutive_failures = 0 WHERE source_id = ?`).run(now, now, sourceId)
        } else if (opFailure) {
          tx.prepare(`UPDATE source_health_v2 SET last_poll_at = ?, last_failure_at = ?, consecutive_failures = consecutive_failures + 1 WHERE source_id = ?`).run(now, now, sourceId)
        } else {
          tx.prepare(`UPDATE source_health_v2 SET last_poll_at = ? WHERE source_id = ?`).run(now, sourceId)
        }
      })
    },
  }
}

export type LogicalStore = ReturnType<typeof createLogicalStore>
