import type { DatabaseContext, ReadTx } from './database.ts'
import type {
  LogicalReadTx, SourceModelV2Activation, LogicalItemDto, ClaimAcquisitionInput, ClaimAcquisitionResult,
  CommitAcquisitionInput, FailAcquisitionInput, AcquisitionRun,
  AdminAcquisitionRun, AdminRunProjection, AdminReconciliationJobSummary, AdminPage,
  RunCursor, JobCursor, AdminFetchProjection, AdminReconciliationCounters, AdminAcquisitionCounters,
  ItemAuditEvent,
} from './types.ts'
import type { User, CommandEnvelope, PushProtocol } from '../domain/types.ts'
import type { PushRowV2 } from './push.ts'
import { getJournalMetadata, snapshotJournalCursor, appendJournal } from './journal.ts'
import { HandleTakenError } from '../domain/types.ts'
import { assertHandleUnreserved } from './schema.ts'
import { createLocalPost, editLocalPost, deleteLocalPost, deleteLocalAccount } from './local.ts'
import { claimAcquisition, commitAcquisition, failAcquisition, BOUNDS } from './acquisition.ts'
import { claimReconciliation, reconcileClaim, recordReconciliationFailure, deferVerification } from './reconcile.ts'
import { scheduleVerification, resolveVerificationBatch } from './verification.ts'
import type { ResolveVerificationInput } from './types.ts'
import { scheduleOrphanWork, claimOrphanWork, adoptOrphans, projectThread } from './threading.ts'
import { projectItem, projectTimeline, projectHistory, projectLocalActivity, resolveLocalAccount, resolvePublisher, rankAttribution, itemOrdinaryVisible } from './projector.ts'
import type { EvidenceLevel } from './projector.ts'
import type { ProjectionViewer, TimelineQuery, LogicalTimelineEnvelope, LogicalHistoryEnvelope, LogicalThreadEnvelope, PublicLocalAccount, PublicPublisher } from './types.ts'
import type { AdminItemDetail, AdminDeliveryRow, AdminVersionRow, AdminClaimRow, AdminConflictRow, AdminSourceItemRow, TombstoneView } from './types.ts'
import type { ReconciliationClaim, ReconcileClaimInput, ReconcileResult, RecordJobFailureInput } from './types.ts'
import type { NewOrphanWork, OrphanClaim, AdoptOrphansInput, AdoptOrphansResult } from './types.ts'
import type { WriteTx } from './database.ts'
import { encodeCursor } from '../domain/cursor.ts'
import { clampLimit } from '../domain/source-repository.ts'
import { rowToItemAuditEvent, hideItem, restoreItem } from './moderation.ts'
import type { ItemAuditRow } from './moderation.ts'
import type { ModerationCommandInput, ItemModerationResult } from './types.ts'
import { scheduleFanout, claimFanout, processFanoutBatch } from './fanout.ts'
import type { FanoutClaim, FanoutBatchResult } from './fanout.ts'
import { purgeSource, removeSourceEvidence, isTombstoned, unblockTombstone } from './tombstones.ts'
import type { PurgeCommandInput, PurgeResult, UnblockCommandInput, UnblockResult } from './tombstones.ts'
import { deriveRoot as adminDeriveRoot } from './roots.ts'

// Bounded transactional reads/writes over the logical-v2 schema (plan File map,
// VP6: the concrete factory is exported and TS infers its type — no LogicalStore
// interface). Task 2 realizes only the read seam's activation + journal-metadata
// reads; later tasks widen both the snapshot callback shape and the store's
// write methods (claimAcquisition, commitAcquisition, reconcileClaim, …).

// The subset of LogicalReadTx implemented so far, plus the Task 8 ordinary-read
// projection seam (projectItem/projectTimeline/projectThread/projectHistory) and
// the two lens resolvers the routes call inside the same snapshot. Later tasks
// broaden this further.
type ReadSeam = Pick<LogicalReadTx, 'getActivation' | 'getJournalMetadata'> & {
  projectItem(id: string, viewer: ProjectionViewer): LogicalItemDto | undefined
  projectTimeline(query: TimelineQuery): LogicalTimelineEnvelope
  projectThread(id: string, viewer: ProjectionViewer): LogicalThreadEnvelope | undefined
  projectHistory(id: string, viewer: ProjectionViewer): LogicalHistoryEnvelope | undefined
  projectLocalActivity(opts: { authorId: string | null; limit: number }): LogicalItemDto[]
  resolveLocalAccount(handle: string): PublicLocalAccount | undefined
  resolvePublisher(publisherId: string): PublicPublisher | undefined
  journalCursor(): string
}

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
    projectItem: (id, viewer) => projectItem(tx, id, viewer),
    projectTimeline: (query) => projectTimeline(tx, query),
    // projectThread takes projectItem as an INJECTED dependency (Task 7's clean
    // structure-vs-policy seam); bind it to the real projector here.
    projectThread: (id, viewer) => projectThread(tx, id, (cid) => projectItem(tx, cid, viewer)),
    projectHistory: (id, viewer) => projectHistory(tx, id, viewer),
    projectLocalActivity: (opts) => projectLocalActivity(tx, opts),
    resolveLocalAccount: (handle) => resolveLocalAccount(tx, handle),
    resolvePublisher: (publisherId) => resolvePublisher(tx, publisherId),
    journalCursor: () => snapshotJournalCursor(tx),
  }
}

// --- v2 inbound push rows (V4 Task 2, spec §1.2) -----------------------------
// The same idiom as the legacy repo methods (core/src/domain/repository.ts:51-55)
// over push_subscriptions_v2, keyed by source instead of user. Two states only.
const PUSH_COLUMNS = `id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at`

interface PushRow {
  id: string; source_id: string; mode: PushProtocol; endpoint: string; topic: string
  callback_token: string; secret: string | null; state: 'pending' | 'active'
  expires_at: string; created_at: string
}

function toPushRowV2(r: PushRow): PushRowV2 {
  return {
    id: r.id, sourceId: r.source_id, mode: r.mode, endpoint: r.endpoint, topic: r.topic,
    callbackToken: r.callback_token, secret: r.secret, state: r.state, expiresAt: r.expires_at, createdAt: r.created_at,
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

// --- V3 admin review reads (Task 8, spec §7.3) -------------------------------
// Every section is inline-capped at ADMIN_SECTION_CAP newest-first (ponytail:
// inline caps, no cursors; paginate a section only when a real item ever exceeds
// 100). Raw evidence is BOUNDED text (Core returns semantic text; Web renders):
// truncated, never HTML-rendered here.
const ADMIN_SECTION_CAP = 100
const ADMIN_RAW_EVIDENCE_CAP = 4096
const ADMIN_ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }

function boundText(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) : s
}

interface AdminItemRow {
  id: string; origin: 'local' | 'remote'; timeline_sort_at: string
  parent_state: string; parent_logical_item_id: string | null
  selected_delivery_id: string | null; selected_publisher_id: string | null
  hidden_at: string | null; structural_tombstone: number
}

// The five terminal/moderation states (spec §5.3, §1.1): structural tombstone and
// deleted-local markers first, then hidden, then ordinary-visible vs unsupported
// (no ordinary-eligible delivery) via THE shared projector gate.
function adminItemState(tx: ReadTx, row: { id: string; hidden_at: string | null; structural_tombstone: number }): AdminItemDetail['state'] {
  if (row.structural_tombstone === 1) return 'structural_tombstone'
  if (tx.prepare(`SELECT 1 FROM logical_deleted_local_v2 WHERE logical_item_id = ? LIMIT 1`).get(row.id)) return 'deleted_local'
  if (row.hidden_at != null) return 'hidden'
  return projectItem(tx, row.id, ADMIN_ANON) !== undefined ? 'ordinary' : 'unsupported'
}

function adminItemDetail(tx: ReadTx, id: string): AdminItemDetail | undefined {
  const li = tx.prepare(
    `SELECT id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, hidden_at, structural_tombstone
     FROM logical_items_v2 WHERE id = ?`,
  ).get(id) as AdminItemRow | undefined
  if (!li) return undefined

  // TRUE totals (independent of the per-section caps).
  const one = (sql: string, ...args: unknown[]): number => (tx.prepare(sql).get(...args) as { n: number }).n
  const counts = {
    deliveries: one(`SELECT COUNT(*) AS n FROM logical_identity_keys_v2 WHERE kind = 'delivery' AND logical_item_id = ?`, id),
    versions: one(`SELECT COUNT(*) AS n FROM observation_versions_v2 WHERE delivery_id IN (SELECT key FROM logical_identity_keys_v2 WHERE kind = 'delivery' AND logical_item_id = ?)`, id),
    claims: one(`SELECT COUNT(*) AS n FROM publisher_claims_v2 WHERE logical_item_id = ?`, id),
    conflicts: one(`SELECT COUNT(*) AS n FROM logical_conflicts_v2 WHERE logical_item_id = ?`, id),
    audit: one(`SELECT COUNT(*) AS n FROM item_audit_v2 WHERE logical_item_id = ?`, id),
  }

  // deliveries (cap, newest-first) + each delivery's bounded versions section
  const deliveryRows = tx.prepare(
    `SELECT d.id, d.source_id, d.key_kind, d.key, d.first_seen_at
     FROM deliveries_v2 d
     JOIN logical_identity_keys_v2 ik ON ik.key = d.id AND ik.kind = 'delivery'
     WHERE ik.logical_item_id = ?
     ORDER BY d.first_seen_at DESC, d.id DESC LIMIT ?`,
  ).all(id, ADMIN_SECTION_CAP) as { id: string; source_id: string; key_kind: string; key: string; first_seen_at: string }[]
  const deliveries: AdminDeliveryRow[] = deliveryRows.map((d) => {
    const gov = tx.prepare(`SELECT governance FROM remote_sources_v2 WHERE id = ?`).get(d.source_id) as { governance: string } | undefined
    const hasEligibleVersion = tx.prepare(
      `SELECT 1 FROM observation_versions_v2 v JOIN reconciliation_jobs_v2 j ON j.observation_version_id = v.id AND j.kind = 'observation'
       WHERE v.delivery_id = ? AND j.status IN ('reconciled','conflicted') LIMIT 1`,
    ).get(d.id) !== undefined
    const vRows = tx.prepare(
      `SELECT id, arrival_at, wire_ordinal, fingerprint, raw_evidence_json FROM observation_versions_v2 WHERE delivery_id = ? ORDER BY arrival_at DESC, id DESC LIMIT ?`,
    ).all(d.id, ADMIN_SECTION_CAP) as { id: string; arrival_at: string; wire_ordinal: number; fingerprint: string; raw_evidence_json: string }[]
    const versions: AdminVersionRow[] = vRows.map((v) => ({ observationVersionId: v.id, arrivalAt: v.arrival_at, wireOrdinal: v.wire_ordinal, fingerprint: v.fingerprint, rawEvidence: boundText(v.raw_evidence_json, ADMIN_RAW_EVIDENCE_CAP) }))
    return { deliveryId: d.id, sourceId: d.source_id, eligible: gov?.governance === 'allowed' && hasEligibleVersion, keyKind: d.key_kind, key: d.key, firstSeenAt: d.first_seen_at, versions }
  })

  // claims (cap, newest-first) — conflictIds are the conflicts sharing the claim's version
  const claimRows = tx.prepare(
    `SELECT id, evidence_level, publisher_id, first_seen_at, observation_version_id FROM publisher_claims_v2 WHERE logical_item_id = ? ORDER BY first_seen_at DESC, id DESC LIMIT ?`,
  ).all(id, ADMIN_SECTION_CAP) as { id: string; evidence_level: EvidenceLevel; publisher_id: string; first_seen_at: string; observation_version_id: string }[]
  const claims: AdminClaimRow[] = claimRows.map((c) => ({
    claimId: c.id, evidenceLevel: c.evidence_level, publisherId: c.publisher_id, firstSeenAt: c.first_seen_at, observationVersionId: c.observation_version_id,
    conflictIds: (tx.prepare(`SELECT id FROM logical_conflicts_v2 WHERE observation_version_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(c.observation_version_id, ADMIN_SECTION_CAP) as { id: string }[]).map((r) => r.id),
  }))

  // conflicts (cap, newest-first)
  const conflictRows = tx.prepare(
    `SELECT id, kind, evidence_json, logical_item_id, observation_version_id, created_at FROM logical_conflicts_v2 WHERE logical_item_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(id, ADMIN_SECTION_CAP) as { id: string; kind: string; evidence_json: string; logical_item_id: string | null; observation_version_id: string | null; created_at: string }[]
  const conflicts: AdminConflictRow[] = conflictRows.map((c) => ({ conflictId: c.id, kind: c.kind, disputed: boundText(c.evidence_json, ADMIN_RAW_EVIDENCE_CAP), logicalItemId: c.logical_item_id, observationVersionId: c.observation_version_id, createdAt: c.created_at }))

  // verification (cap, newest-first): one row per check; attempts from the batch job
  const checkRows = tx.prepare(
    `SELECT publisher_feed_url, state, batch_key, resolved_at FROM verification_checks_v2 WHERE logical_item_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(id, ADMIN_SECTION_CAP) as { publisher_feed_url: string; state: 'pending' | 'verified' | 'unverified'; batch_key: string; resolved_at: string | null }[]
  const verification = checkRows.map((c) => {
    const job = tx.prepare(`SELECT attempts FROM reconciliation_jobs_v2 WHERE kind = 'verification' AND verification_batch_key = ? ORDER BY attempts DESC LIMIT 1`).get(c.batch_key) as { attempts: number } | undefined
    return { publisherFeedUrl: c.publisher_feed_url, state: c.state, attempts: job?.attempts ?? 0, lastCheckedAt: c.resolved_at }
  })

  // selected: stored hints + the selected publisher's strongest claim level
  const selLevels = li.selected_publisher_id
    ? (tx.prepare(`SELECT evidence_level FROM publisher_claims_v2 WHERE logical_item_id = ? AND publisher_id = ?`).all(id, li.selected_publisher_id) as { evidence_level: EvidenceLevel }[]).map((r) => r.evidence_level)
    : []

  return {
    model: 'logical-v2',
    logicalItemId: li.id,
    origin: li.origin,
    state: adminItemState(tx, li),
    hiddenAt: li.hidden_at,
    selected: { deliveryId: li.selected_delivery_id, publisherId: li.selected_publisher_id, attributionLevel: rankAttribution(selLevels) },
    parentLogicalItemId: li.parent_logical_item_id,
    threadRootId: li.parent_logical_item_id ? adminDeriveRoot(tx, li.parent_logical_item_id) : null,
    counts,
    deliveries,
    claims,
    conflicts,
    verification,
  }
}

// The schedulability predicate (spec §1.3): enabled, not blocked, and either
// actively subscribed or federated. Shared by listSchedulableSources (the full
// membership-check list push.ts uses), countSchedulableSources, and
// listDueSources (both below) — one predicate, never re-expressed.
const SCHEDULABLE_SOURCE_WHERE = `s.operation = 'enabled' AND s.governance != 'blocked'
  AND (EXISTS (SELECT 1 FROM source_subscriptions_v2 sub WHERE sub.source_id = s.id AND sub.state = 'active')
       OR EXISTS (SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = s.id))`

// The local-mutation write seam (Task 3): each command runs inside ONE db.write()
// so local storage, logical metadata, and journal effects commit atomically (spec
// §2.6). service.ts routes v2-on local mutations here; later tasks widen the store
// with acquisition/reconciliation write methods.
export function createLogicalStore(db: DatabaseContext) {
  return {
    snapshot<T>(fn: (tx: ReadSeam) => T): T {
      return db.read((tx) => fn(makeReadTx(tx)))
    },
    createLocalPost(input: { author: User; content: string; replyToId: string | null; now: string; publicUrl?: string | null }): LogicalItemDto {
      return db.write((tx) => createLocalPost({ tx, ...input }))
    },
    // The reply-target gate: true iff the id is a local post or an
    // ordinary-visible remote logical item — exactly what a reader can see,
    // so exactly what a reply may target (the v1 posts lookup alone rejects
    // every remote item under v2).
    replyTargetVisible(id: string): boolean {
      return db.read((tx) => itemOrdinaryVisible(tx, id))
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

    // --- V1 membership/profile bridge (Task 9, spec §3.7) -----------------
    // When v2 is on, service.ts routes local-account follow/unfollow and profile
    // edits here so the domain mutation and its single Personal-membership reset
    // commit in one atomic write. A reset is appended only when a row actually
    // changes (an idempotent re-follow/unfollow appends nothing); a profile edit
    // is an explicit command and always appends one. No source generation moves —
    // these are membership/identity, not source policy. No fan-out.
    addLocalFollow(input: { followerId: string; followedId: string; now: string }): void {
      db.write((tx) => {
        // follows has only its composite PK, so a bare DO NOTHING targets it.
        const r = tx.prepare(`INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`).run(input.followerId, input.followedId, input.now)
        if (r.changes > 0) appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, input.now)
      })
    },
    removeLocalFollow(input: { followerId: string; followedId: string; now: string }): void {
      db.write((tx) => {
        const r = tx.prepare(`DELETE FROM follows WHERE follower_id = ? AND followed_id = ?`).run(input.followerId, input.followedId)
        if (r.changes > 0) appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, input.now)
      })
    },
    // Mirrors SqliteRepository.updateUserProfile (the SHARED reservation guard +
    // RETURNING + HandleTakenError on a UNIQUE collision), plus the reset.
    // Column-named UPDATE; the caller has already normalized handle/displayName.
    // This is the rename service.ts takes whenever v2 is on — i.e. the only state
    // in which handle_reservations_v2 is non-empty — so the guard MUST run here;
    // it runs inside this write, so check and rename are one transaction.
    updateUserProfile(userId: string, patch: { handle?: string; displayName?: string }): User {
      return db.write((tx) => {
        if (patch.handle !== undefined) assertHandleUnreserved(tx, patch.handle)
        const sets: string[] = []
        const args: unknown[] = []
        if (patch.handle !== undefined) { sets.push('handle = ?'); args.push(patch.handle) }
        if (patch.displayName !== undefined) { sets.push('display_name = ?'); args.push(patch.displayName) }
        const cols = `id, kind, handle, display_name, feed_url, created_at, auth_user_id, feed_type`
        type Row = { id: string; kind: 'local' | 'remote'; handle: string; display_name: string; feed_url: string | null; created_at: string; auth_user_id: string | null; feed_type: User['feedType'] }
        let row: Row | undefined
        try {
          row = sets.length === 0
            ? tx.prepare(`SELECT ${cols} FROM users WHERE id = ?`).get(userId) as Row | undefined
            : tx.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? RETURNING ${cols}`).get(...args, userId) as Row | undefined
        } catch (err) {
          if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HandleTakenError('handle already taken')
          throw err
        }
        if (!row) throw new Error(`updateUserProfile: unknown user ${userId}`)
        if (sets.length > 0) appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, new Date().toISOString())
        return { id: row.id, kind: row.kind, handle: row.handle, displayName: row.display_name, feedUrl: row.feed_url, createdAt: row.created_at, authUserId: row.auth_user_id, feedType: row.feed_type }
      })
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

    // --- reconciliation write seam (Task 6) -------------------------------
    // The in-process serial drain (reconcile.ts) drives these. claim + reconcile
    // are separate transactions per the two-transaction spirit (spec §2.3): claim
    // commits 'processing' before the job transaction runs; a rolled-back job
    // transaction records its failure in this SEPARATE small transaction.
    claimReconciliation(now: string): ReconciliationClaim | null {
      return db.write((tx) => claimReconciliation(tx, now))
    },
    reconcileClaim(input: ReconcileClaimInput): ReconcileResult {
      return db.write((tx) => reconcileClaim(tx, input))
    },
    recordReconciliationFailure(input: RecordJobFailureInput): void {
      db.write((tx) => recordReconciliationFailure(tx, input))
    },

    // --- bounded origin verification (Task 4, spec §7.1) ------------------
    // scheduleVerification takes the caller's WriteTx so the check + batch job
    // commit atomically inside V2 reconciliation's aggregate-claim transaction
    // (the enqueue is called directly from reconcile.ts). deferVerification lets
    // the SYNC drain un-claim a verification job (async fetch belongs to the async
    // drain). resolveVerificationBatch is the Task-5 outcome-handling stub — Task 4
    // performs the fetch and hands the parsed response here; today a no-op.
    scheduleVerification(tx: WriteTx, input: { logicalItemId: string; sourceId: string; publisherFeedUrl: string; now: string }): void {
      scheduleVerification(tx, input)
    },
    deferVerification(jobId: string, now: string): void {
      db.write((tx) => deferVerification(tx, jobId, now))
    },
    // Task 5 outcome handling: ONE db.write() resolves the fetched/failed batch —
    // per-check verified/unverified, verified direct-origin evidence, the audit,
    // hint recompute, journal effect, and publisher aliases all commit atomically.
    resolveVerificationBatch(input: ResolveVerificationInput): void {
      db.write((tx) => resolveVerificationBatch(tx, input))
    },

    // --- orphan-work write seam (Task 7) ----------------------------------
    // scheduleOrphanWork takes the caller's WriteTx so it commits atomically
    // with the alias mint that triggers it (spec §4.2); claim + adopt run the
    // continuous worker (driven by Task 10's runtime), each its own transaction.
    scheduleOrphanWork(tx: WriteTx, input: NewOrphanWork): void {
      scheduleOrphanWork(tx, input)
    },
    claimOrphanWork(_now: string): OrphanClaim | null {
      return db.write((tx) => claimOrphanWork(tx))
    },
    adoptOrphans(input: AdoptOrphansInput): AdoptOrphansResult {
      return db.write((tx) => adoptOrphans(tx, input))
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

    // --- hidden moderation (Task 2, spec §1.1) ----------------------------
    // Each is ONE ledger-backed BEGIN IMMEDIATE write: state change + one audit
    // record + inline single-item hint recompute + the §6 journal effect atomic.
    hideItem(input: ModerationCommandInput): ItemModerationResult {
      return db.write((tx) => hideItem(tx, input))
    },
    restoreItem(input: ModerationCommandInput): ItemModerationResult {
      return db.write((tx) => restoreItem(tx, input))
    },

    // --- purge + tombstones (Task 6, spec §5) -----------------------------
    // purgeSource is ONE ledger-backed BEGIN IMMEDIATE write: the tombstone +
    // alias copy, the FK-ordered evidence deletion, per-item reselect/delete/
    // tombstone, and exactly one journal reset commit atomically. removeSourceEvidence
    // is the shared step-4 helper (Task 7's cleanup reuses it inside its own write);
    // isTombstoned is the resolution guard (Task 7's first caller).
    purgeSource(input: PurgeCommandInput): PurgeResult {
      return db.write((tx) => purgeSource(tx, input))
    },
    removeSourceEvidence(tx: WriteTx, input: { sourceId: string; now: string }): { ordinaryAffected: boolean } {
      return removeSourceEvidence(tx, input)
    },
    isTombstoned(url: string): boolean {
      return db.read((tx) => isTombstoned(tx, url))
    },
    // Unblock (Task 7 built the free fn; Task 8 wires it): ONE ledger-backed write
    // deleting the tombstone + its aliases, creating NO source. The route maps on
    // .kind.
    unblockTombstone(input: UnblockCommandInput): UnblockResult {
      return db.write((tx) => unblockTombstone(tx, input))
    },

    // --- policy fan-out (Task 3, spec §4.1) -------------------------------
    // scheduleFanout takes the caller's WriteTx so the enqueue commits atomically
    // with the transition's reset + generation advance (the real enqueue is in
    // sqlite.ts, next to advancePolicyGeneration, calling the free fn directly).
    // claim + processBatch drive the ONE V2 drain (reconcile.ts); each is its own
    // transaction, and a batch bounds the writer-lock hold of a full recompute.
    scheduleFanout(tx: WriteTx, input: { sourceId: string; generation: number; now: string }): void {
      scheduleFanout(tx, input)
    },
    claimFanout(now: string): FanoutClaim | null {
      return db.write((tx) => claimFanout(tx, now))
    },
    processFanoutBatch(input: { claim: FanoutClaim; now: string }): FanoutBatchResult {
      return db.write((tx) => processFanoutBatch(tx, input))
    },

    // --- item audit reads (Task 1, spec §1.2) -----------------------------
    // Mirrors listRuns/listJobs exactly: newest-first over the immutable
    // (createdAt, id) tuple through the shared cursor codec. limit defaults to
    // 50 and clamps to [1,100] (V1's clampLimit) — Task 1 has no route yet to
    // apply that default, so the primitive owns it directly.
    listItemAudit(logicalItemId: string, cursor: { createdAt: string; id: string } | undefined, limit: number = 50): AdminPage<ItemAuditEvent> {
      return db.read((tx) => {
        const lim = clampLimit(limit)
        const COLS = `id, logical_item_id, command_id, actor_id, actor_kind, action, category, note, result_json, created_at`
        const rows = (cursor
          ? tx.prepare(`SELECT ${COLS} FROM item_audit_v2 WHERE logical_item_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`).all(logicalItemId, cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
          : tx.prepare(`SELECT ${COLS} FROM item_audit_v2 WHERE logical_item_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(logicalItemId, lim + 1)) as ItemAuditRow[]
        const page = rows.slice(0, lim)
        const last = page[page.length - 1]
        const nextCursor = rows.length > lim && last ? encodeCursor(1, [last.created_at, last.id]) : null
        return { model: 'logical-v2', items: page.map(rowToItemAuditEvent), nextCursor }
      })
    },

    // --- V3 admin review reads (Task 8, spec §7.3) ------------------------
    // Bounded item evidence detail; the source→items list (paginated, newest-first
    // over the shared (timelineSortAt, logicalItemId) tuple) carrying the source's
    // TRUE conflictCount; the unpaginated tombstone list.
    getAdminItemDetail(id: string): AdminItemDetail | undefined {
      return db.read((tx) => adminItemDetail(tx, id))
    },
    listSourceItems(sourceId: string, cursor: { timelineSortAt: string; logicalItemId: string } | undefined, limit: number): AdminPage<AdminSourceItemRow> & { conflictCount: number } {
      return db.read((tx) => {
        const lim = clampLimit(limit)
        const rows = (cursor
          ? tx.prepare(`SELECT DISTINCT li.id, li.timeline_sort_at, li.hidden_at, li.structural_tombstone FROM logical_items_v2 li JOIN logical_identity_keys_v2 ik ON ik.logical_item_id = li.id AND ik.kind = 'delivery' JOIN deliveries_v2 d ON d.id = ik.key WHERE d.source_id = ? AND (li.timeline_sort_at < ? OR (li.timeline_sort_at = ? AND li.id < ?)) ORDER BY li.timeline_sort_at DESC, li.id DESC LIMIT ?`).all(sourceId, cursor.timelineSortAt, cursor.timelineSortAt, cursor.logicalItemId, lim + 1)
          : tx.prepare(`SELECT DISTINCT li.id, li.timeline_sort_at, li.hidden_at, li.structural_tombstone FROM logical_items_v2 li JOIN logical_identity_keys_v2 ik ON ik.logical_item_id = li.id AND ik.kind = 'delivery' JOIN deliveries_v2 d ON d.id = ik.key WHERE d.source_id = ? ORDER BY li.timeline_sort_at DESC, li.id DESC LIMIT ?`).all(sourceId, lim + 1)) as { id: string; timeline_sort_at: string; hidden_at: string | null; structural_tombstone: number }[]
        const page = rows.slice(0, lim)
        const last = page[page.length - 1]
        const nextCursor = rows.length > lim && last ? encodeCursor(1, [last.timeline_sort_at, last.id]) : null
        const items: AdminSourceItemRow[] = page.map((r) => ({ logicalItemId: r.id, state: adminItemState(tx, r), timelineSortAt: r.timeline_sort_at, hiddenAt: r.hidden_at }))
        // TRUE conflict count across ALL the source's items (not just this page) —
        // Task 9's source-detail page reads it (AdminSourceAcquisitionSummary never
        // shipped; see the dated plan note).
        const conflictCount = (tx.prepare(
          `SELECT COUNT(*) AS n FROM logical_conflicts_v2 WHERE logical_item_id IN (SELECT DISTINCT ik.logical_item_id FROM logical_identity_keys_v2 ik JOIN deliveries_v2 d ON d.id = ik.key WHERE ik.kind = 'delivery' AND d.source_id = ?)`,
        ).get(sourceId) as { n: number }).n
        return { model: 'logical-v2', items, nextCursor, conflictCount }
      })
    },
    listTombstones(): TombstoneView[] {
      return db.read((tx) => {
        const rows = tx.prepare(`SELECT id, canonical_url, action, category, note, created_at FROM blocked_source_tombstones_v2 ORDER BY created_at DESC, id DESC`).all() as { id: string; canonical_url: string; action: 'block' | 'purge'; category: TombstoneView['category']; note: string | null; created_at: string }[]
        return rows.map((r) => ({
          id: r.id, canonicalUrl: r.canonical_url, action: r.action, category: r.category, note: r.note, createdAt: r.created_at,
          aliases: (tx.prepare(`SELECT url FROM tombstone_aliases_v2 WHERE tombstone_id = ? ORDER BY url ASC`).all(r.id) as { url: string }[]).map((a) => a.url),
        }))
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

    // --- v2 inbound push rows (V4 Task 2, spec §1.2) ----------------------
    // The write methods take the caller's WriteTx so a registration's row and
    // whatever else the caller commits stay in one transaction.
    findPushRow(filter: { token?: string; sourceId?: string; mode?: PushProtocol; topic?: string }, opts?: { unexpiredAt?: string; state?: 'pending' | 'active' }): PushRowV2 | undefined {
      return db.read((tx) => {
        const where: string[] = []
        const args: unknown[] = []
        if (filter.token !== undefined) { where.push('callback_token = ?'); args.push(filter.token) }
        if (filter.sourceId !== undefined) { where.push('source_id = ?'); args.push(filter.sourceId) }
        if (filter.mode !== undefined) { where.push('mode = ?'); args.push(filter.mode) }
        if (filter.topic !== undefined) { where.push('topic = ?'); args.push(filter.topic) }
        if (opts?.unexpiredAt !== undefined) { where.push('expires_at > ?'); args.push(opts.unexpiredAt) }
        if (opts?.state !== undefined) { where.push('state = ?'); args.push(opts.state) }
        const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
        const r = tx.prepare(`SELECT ${PUSH_COLUMNS} FROM push_subscriptions_v2${clause} LIMIT 1`).get(...args) as PushRow | undefined
        return r ? toPushRowV2(r) : undefined
      })
    },
    // H4 (v1 sqlite.ts:597-599, kept): token and secret are the subscription's
    // IDENTITY across renewals — never rewritten on conflict.
    upsertPushRow(tx: WriteTx, row: PushRowV2): void {
      tx.prepare(
        `INSERT INTO push_subscriptions_v2 (${PUSH_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, mode) DO UPDATE SET endpoint = excluded.endpoint, topic = excluded.topic, state = excluded.state, expires_at = excluded.expires_at`,
      ).run(row.id, row.sourceId, row.mode, row.endpoint, row.topic, row.callbackToken, row.secret, row.state, row.expiresAt, row.createdAt)
    },
    deletePushRow(tx: WriteTx, id: string): void {
      tx.prepare(`DELETE FROM push_subscriptions_v2 WHERE id = ?`).run(id)
    },
    listRenewablePushRows(horizon: string): PushRowV2[] {
      return db.read((tx) => (tx.prepare(`SELECT ${PUSH_COLUMNS} FROM push_subscriptions_v2 WHERE state = 'active' AND expires_at < ? ORDER BY id ASC`).all(horizon) as PushRow[]).map(toPushRowV2))
    },
    purgeExpiredPushRows(tx: WriteTx, now: string): void {
      tx.prepare(`DELETE FROM push_subscriptions_v2 WHERE expires_at <= ?`).run(now)
    },

    // --- scheduler support (spec §1.3) ------------------------------------
    listSchedulableSources(): string[] {
      return db.read((tx) => {
        const rows = tx.prepare(
          `SELECT s.id FROM remote_sources_v2 s WHERE ${SCHEDULABLE_SOURCE_WHERE} ORDER BY s.id ASC`,
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
    countSchedulableSources(): number {
      return db.read((tx) => (tx.prepare(
        `SELECT COUNT(*) AS n FROM remote_sources_v2 s WHERE ${SCHEDULABLE_SOURCE_WHERE}`,
      ).get() as { n: number }).n)
    },
    // Staleness-ordered (oldest last_poll_at first, NULLs first — never-polled
    // is maximally overdue), LIMIT-bounded due-query (spec 2026-07-28 §1). A
    // source with an active, unexpired push lease needs pollSeconds ×
    // pushPollFactor elapsed instead of pollSeconds — same rule scheduler.ts
    // used to apply per-source in JS, now index-supported SQL so this stays
    // O(limit), never O(catalog size).
    listDueSources(input: { now: string; pollSeconds: number; pushPollFactor: number; limit: number }): { id: string; canonicalUrl: string }[] {
      return db.read((tx) => {
        const nowMs = Date.parse(input.now)
        const baseCutoff = new Date(nowMs - input.pollSeconds * 1000).toISOString()
        const pushCutoff = new Date(nowMs - input.pollSeconds * 1000 * input.pushPollFactor).toISOString()
        const rows = tx.prepare(
          `SELECT s.id AS id, s.canonical_url AS canonical_url FROM remote_sources_v2 s
           LEFT JOIN source_health_v2 h ON h.source_id = s.id
           WHERE ${SCHEDULABLE_SOURCE_WHERE}
             AND (
               h.last_poll_at IS NULL
               OR h.last_poll_at < CASE
                    WHEN EXISTS (SELECT 1 FROM push_subscriptions_v2 p WHERE p.source_id = s.id AND p.state = 'active' AND p.expires_at > ?)
                    THEN ? ELSE ? END
             )
           ORDER BY h.last_poll_at ASC, s.id ASC
           LIMIT ?`,
        ).all(input.now, pushCutoff, baseCutoff, input.limit) as { id: string; canonical_url: string }[]
        return rows.map((r) => ({ id: r.id, canonicalUrl: r.canonical_url }))
      })
    },
    // /admin/overview's cycle-health readout (spec 2026-07-28 §4): every field
    // computed fresh from durable state here, matching how every other
    // /admin/overview field already works (service.instanceStats) — no new
    // in-memory scheduler-closure bookkeeping.
    schedulerStats(input: { now: string; pollSeconds: number }): {
      catalogSize: number
      mostOverdueSeconds: number | null
      attemptedLastWindow: number
      windowSpanSeconds: number | null
    } {
      return db.read((tx) => {
        const { n: catalogSize } = tx.prepare(
          `SELECT COUNT(*) AS n FROM remote_sources_v2 s WHERE ${SCHEDULABLE_SOURCE_WHERE}`,
        ).get() as { n: number }

        const staleness = tx.prepare(
          `SELECT MIN(h.last_poll_at) AS oldest, SUM(CASE WHEN h.last_poll_at IS NULL THEN 1 ELSE 0 END) AS neverPolled
           FROM remote_sources_v2 s LEFT JOIN source_health_v2 h ON h.source_id = s.id
           WHERE ${SCHEDULABLE_SOURCE_WHERE}`,
        ).get() as { oldest: string | null; neverPolled: number | null }
        const mostOverdueSeconds = catalogSize === 0 || (staleness.neverPolled ?? 0) > 0 || staleness.oldest === null
          ? null
          : Math.round((Date.parse(input.now) - Date.parse(staleness.oldest)) / 1000)

        const windowStart = new Date(Date.parse(input.now) - input.pollSeconds * 1000).toISOString()
        const window = tx.prepare(
          `SELECT COUNT(*) AS attempted, MIN(started_at) AS windowStart, MAX(COALESCE(completed_at, started_at)) AS windowEnd
           FROM acquisition_runs_v2 WHERE started_at >= ?`,
        ).get(windowStart) as { attempted: number; windowStart: string | null; windowEnd: string | null }
        const windowSpanSeconds = window.attempted > 0 && window.windowStart && window.windowEnd
          ? Math.round((Date.parse(window.windowEnd) - Date.parse(window.windowStart)) / 1000)
          : null

        return { catalogSize, mostOverdueSeconds, attemptedLastWindow: window.attempted, windowSpanSeconds }
      })
    },
  }
}

export type LogicalStore = ReturnType<typeof createLogicalStore>
