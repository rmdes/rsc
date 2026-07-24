// Logical-v2 wire DTOs and internal record contracts (Task 2 foundation).
// Transcribed verbatim from the governing spec
// (docs/superpowers/specs/2026-07-22-rsc-logical-items-ordinary-reads-design.md)
// and the plan's "File map and shared interfaces" section. These are the frozen
// shapes every later Vertical 2 task consumes by import.
//
// Placement notes (Task 2 plan corrections, 2026-07-23):
//  - DatabaseContext / ReadTx / WriteTx live in ./database.ts (the transaction
//    module), not here.
//  - the shared pagination cursor codec (encodeCursor/decodeCursor tuple form)
//    lives in ../domain/cursor.ts (neutral home) so the V1 source plane never
//    imports the logical vertical. See that module + the dated plan note.
//  - the journal cursor codec + appendJournal live in ./journal.ts.

import type { CommandEnvelope, RemoteSource, AuditCategory } from '../domain/types.ts'

// --- Ordinary-read DTOs (spec §3.4) --------------------------------------

export type LogicalItemId = string

export type SelectedAuthor =
  | { kind: 'local'; id: string; handle: string; displayName: string }
  | {
      kind: 'remote_publisher'
      id: string
      displayName: string
      canonicalFeedUrl: string | null
      profileAvailable: boolean
      attributionLevel: 'bound_single_publisher' | 'aggregate_assertion' | 'source_scoped_fallback'
    }

export type ReplyContextDto = {
  kind: 'asserted_external'
  authorLabel: string | null
  snippet: string | null
  url: string | null
}

export type EnclosureDto = {
  url: string
  mimeType: string | null
  title: string | null
  sizeBytes: number | null
  durationSeconds: number | null
}

export type LogicalItemDto = {
  kind: 'logical_item'
  id: LogicalItemId
  origin: 'local' | 'remote'
  parentResolutionState: 'none' | 'missing' | 'ambiguous' | 'resolved'
  parentLogicalItemId: LogicalItemId | null
  threadRootId: LogicalItemId | null
  selectedAuthor: SelectedAuthor
  title: string | null
  content: string | null
  contentMarkdown: string | null
  permalink: string | null
  sourceLink: string | null
  replyContext: ReplyContextDto | null
  enclosures: EnclosureDto[]
  publishedAt: string
  updatedAt: string | null
  // spec §3.4: null exactly when updatedAt is null; Vertical 4 widens the SQL
  // CHECK with 'legacy_unknown' at cutover, so DTO consumers check membership,
  // not exhaustive equality.
  updatedAtProvenance: 'explicit' | 'arrival' | null
  directReplyCount: number
  conversationReplyCount: number
  classification: { personal: boolean; federated: boolean }
}

export type LogicalSingleItemEnvelope = {
  model: 'logical-v2'
  item: LogicalItemDto
  journalCursor: string
}

// --- Lenses and timeline (spec §3.5) -------------------------------------

export type PublicLocalAccount = { id: string; handle: string; displayName: string }
export type PublicPublisher = {
  id: string
  displayName: string
  canonicalFeedUrl: string
  identityLevel: 'feed_anchored'
}

export type TimelineLens =
  | { kind: 'public' }
  | { kind: 'local' }
  | { kind: 'personal'; account: PublicLocalAccount }
  | { kind: 'local_author'; account: PublicLocalAccount }
  | { kind: 'publisher'; publisher: PublicPublisher }
  | { kind: 'federated' }

export type LogicalTimelineEnvelope = {
  model: 'logical-v2'
  lens: TimelineLens
  timeline: LogicalItemDto[]
  nextCursor: string | null
  journalCursor: string
}

// --- Thread and history envelopes (spec §4.3, §4.5) ----------------------

export type LogicalThreadEnvelope = {
  model: 'logical-v2'
  requestedLogicalItemId: string
  rootId: string | null
  nodes: Array<
    | { kind: 'item'; item: LogicalItemDto }
    | {
        kind: 'placeholder'
        logicalItemId: string
        parentLogicalItemId: string | null
        timelineSortAt: string
        placeholderKind: 'unavailable'
      }
  >
  truncated: { depth: boolean; nodes: boolean; cycle: boolean }
  journalCursor: string
}

export type LogicalHistoryEnvelope = {
  model: 'logical-v2'
  logicalItemId: string
  origin: 'local' | 'remote'
  entries: Array<{
    sequence: number
    title: string | null
    content: string | null
    markdown: string | null
    permalink: string | null
    enclosures: EnclosureDto[]
    updatedAt: string | null
    updatedAtProvenance: 'explicit' | 'arrival' | null
    current: boolean
  }>
  currentSequence: number
  journalCursor: string
}

// --- Journal (spec §5.1-5.2) ---------------------------------------------

export type JournalChangeMask =
  | 'presentation' | 'author' | 'visibility' | 'classification'
  | 'ancestry' | 'reply_counts' | 'history' | 'barrier'

export type JournalEffect =
  | { kind: 'upsert'; logicalItemId: string; changeMask: JournalChangeMask }
  | { kind: 'remove'; logicalItemId: string; changeMask: JournalChangeMask }
  | { kind: 'reset'; changeMask: JournalChangeMask }

export interface JournalMetadata {
  highWaterSeq: number
  resetGeneration: number
}

// Decoded journal cursor (opaque on the wire; encodes model + version +
// generation + sequence). Distinct from the pagination cursors below.
export interface JournalCursor {
  version: 1
  resetGeneration: number
  sequence: number
}

export type ReplyCountOverlay = {
  rootLogicalItemId: string
  rootConversationReplyCount: number
}

// --- Activation (spec §7.1) ----------------------------------------------

export interface SourceModelV2Activation {
  schemaVersion: 1
  state: 'never_activated' | 'active' | 'reconciliation_required'
  lastActivatedAt: string | null
  lastReconciledAt: string | null
}

// --- Admin projections (spec §6.2-6.3) -----------------------------------

export type AdminFetchProjection = {
  outcome:
    | 'pending' | 'not_modified' | 'parsed' | 'completed_truncated'
    | 'redirect_conflict' | 'operational_failure' | 'cancelled'
    | 'superseded' | 'policy_rejected'
  effectiveUrl: string | null
  httpStatus: number | null
  failureCategory:
    | 'network' | 'timeout' | 'http' | 'body_limit'
    | 'feed_parse' | 'policy' | 'superseded' | null
  diagnostic: string | null
}

export type AdminAcquisitionCounters = {
  candidates: number
  seen: number
  observed: number
  unchanged: number
  skipped: number
  omitted: number
  itemsTruncated: boolean
  bodyLimitExceeded: boolean
  notModified: boolean
}

export type AdminReconciliationCounters = {
  reconciled: number
  conflicted: number
  pending: number
  processing: number
  retrying: number
  failed: number
  failedByCategory: { operationalExhausted: number; invariantOrDataFailure: number }
}

export type AdminAcquisitionVersions = {
  parserAdapter: string | null
  parserVersion: string | null
  boundsProfileVersion: string
  identifierNormalizationVersion: string
  fingerprintVersion: string
}

export type AdminRunProjection = {
  model: 'logical-v2'
  runId: string
  sourceId: string
  status: 'terminal' | 'processing'
  statusLocation: string
  fetch: AdminFetchProjection
  acquisition: AdminAcquisitionCounters
  reconciliation: AdminReconciliationCounters
}

export type AdminRefreshResult = AdminRunProjection & {
  disposition: 'created' | 'joined' | 'replayed'
}

export type AdminAcquisitionRun = AdminRunProjection & {
  reason: 'scheduled' | 'administrator_refresh'
  startedAt: string
  acquisitionCommittedAt: string | null
  completedAt: string | null
  versions: AdminAcquisitionVersions
}

export type AdminReconciliationJobSummary = {
  jobId: string
  createdAt: string
  status: 'pending' | 'processing' | 'retrying' | 'reconciled' | 'conflicted' | 'failed'
  attempts: number
  nextAttemptAt: string | null
  failureCategory: 'operational_exhausted' | 'invariant_or_data_failure' | null
  diagnostic: string | null
}

// --- Item audit (V3 foundation, spec §1.2) --------------------------------
// item_audit_v2 mirrors V1's source_audit_v2 shape; actor kind is narrower
// (no 'operator_token' — nothing v3 audits runs under a token actor). The SQL
// CHECK on category is its OWN nine-value CHECK (schema.ts) — never a mirror
// of this TS union.

export interface ItemAuditEvent {
  id: string
  logicalItemId: string
  commandId: string
  actorId: string | null
  actorKind: 'administrator' | 'system'
  action: string
  category: AuditCategory | null
  note: string | null
  resultJson: string
  createdAt: string
}

// --- Pagination cursors (spec §6.3) --------------------------------------
// Decoded forms; the shared opaque codec lives in ../domain/cursor.ts.

export interface RunCursor { startedAt: string; runId: string }
export interface JobCursor { createdAt: string; jobId: string }
export interface TimelineCursorV2 { version: 1; timelineSortAt: string; logicalItemId: string }

export interface AdminPage<T> {
  model: 'logical-v2'
  items: T[]
  nextCursor: string | null
}

// --- Projection inputs (plan File map) -----------------------------------

export interface ProjectionViewer {
  localAccountId: string | null
  activeSourceIds: readonly string[]
}

export interface TimelineQuery {
  lens: TimelineLens
  before: TimelineCursorV2 | null
  limit: number
  viewer: ProjectionViewer
}

// --- Acquisition / reconciliation / orphan input records (plan File map) --
// Fixed before their first consumer so later tasks widen usage, not shape.

export interface ConditionalValidators {
  effectiveUrl: string
  etag: string | null
  lastModified: string | null
}

// --- Acquisition claim/commit/fail records (plan File map lines 189-200) ---
// Fixed here before their first consumer (Task 4). These reference the V1
// domain types CommandEnvelope/RemoteSource, so Task 2 (which only touched the
// logical vertical) deferred them; Task 4 is the acquisition writer that adds
// them. Shapes are transcribed verbatim from the plan — do not re-derive.

export type AcquisitionReason =
  | { kind: 'scheduled' }
  | { kind: 'administrator'; command: CommandEnvelope }

export interface ClaimAcquisitionInput {
  sourceId: string
  reason: AcquisitionReason
  now: string
}

export type ClaimAcquisitionResult =
  | { kind: 'claimed'; runId: string; source: RemoteSource; disposition: 'created' | 'joined' | 'replayed' }
  | { kind: 'unavailable'; reason: 'unknown' | 'paused' | 'blocked' | 'unscheduled' }

export interface CommitAcquisitionInput {
  runId: string
  sourceId: string
  committedAt: string
  effectiveUrl: string | null
  validators: ConditionalValidators | null
  redirects: RedirectObservation[]
  // rev 5 (RC1): proven permanent-chain targets (spec §1.6) upserted into
  // source_aliases_v2 inside the result transaction.
  aliases: string[]
  observations: NewObservationVersion[]
  findings: AcquisitionFinding[]
  counters: AdminAcquisitionCounters
  outcome: AdminFetchProjection['outcome']
  pushCapabilityJson: string | null
}

export interface FailAcquisitionInput {
  runId: string
  sourceId: string
  now: string
  outcome: 'operational_failure' | 'cancelled' | 'superseded' | 'policy_rejected'
  category: AdminFetchProjection['failureCategory']
  diagnostic: string | null
}

// Return of commitAcquisition/failAcquisition — the durable run's terminal
// identity (plan File map: `commitAcquisition(input):AcquisitionRun`).
export interface AcquisitionRun {
  runId: string
  sourceId: string
  status: 'processing' | 'terminal'
  outcome: AdminFetchProjection['outcome']
}

export interface RedirectObservation {
  ordinal: number
  status: number | null
  fromEvidence: string
  toEvidence: string
  permanentProof: boolean
}

export interface NewObservationVersion {
  id: string
  deliveryId: string
  wireOrdinal: number
  arrivalAt: string
  fingerprintVersion: 1
  fingerprint: string
  canonicalMaterial: Uint8Array
  rawEvidenceJson: string
  normalizedJson: string
}

export interface AcquisitionFinding {
  kind:
    | 'fingerprint_collision' | 'item_evidence_limit' | 'enclosure_limit'
    | 'operational_identifier_limit' | 'invalid_identifier'
    | 'redirect_ownership_conflict' | 'redirect_loop' | 'parser_item_error'
  evidenceJson: string
}

export interface NewOrphanWork {
  aliasKind: 'permalink' | 'scoped_opaque'
  aliasKey: string
  candidateHighWater: string
  createdAt: string
}

export interface OrphanClaim {
  workId: string
  candidateHighWater: string
}

export interface AdoptOrphansInput {
  claim: OrphanClaim
  now: string
  limit: number
}

export interface AdoptOrphansResult {
  adopted: number
  ambiguous: number
  remaining: boolean
}

export interface ReconciliationClaim {
  jobId: string
  runId: string
  observationVersionId: string
}

export interface ReconcileClaimInput {
  claim: ReconciliationClaim
  now: string
}

export type ReconcileResult =
  | { kind: 'reconciled' | 'conflicted'; logicalItemId: string }
  | { kind: 'superseded' }

export interface RecordJobFailureInput {
  jobId: string
  now: string
  category: 'operational_exhausted' | 'invariant_or_data_failure'
  diagnostic: string | null
  retryAt: string | null
}

// --- Threading (plan File map) -------------------------------------------

export type NormalizedReplyReference =
  | { kind: 'permalink'; key: string; scope: null; raw: string }
  | { kind: 'opaque'; key: string; scope: { kind: 'source' | 'publisher'; id: string } | null; raw: string }

export type ParentResolutionResult =
  | { state: 'none' | 'missing' | 'ambiguous'; parentLogicalItemId: null }
  | { state: 'resolved'; parentLogicalItemId: string }

// --- Read seam (plan File map, VP6) --------------------------------------
// The one stub seam later tasks fill in. Task 2 realizes only getActivation and
// getJournalMetadata (see store.ts). Later tasks widen the store's snapshot
// callback to the fuller shape.

export interface LogicalReadTx {
  getActivation(): SourceModelV2Activation
  getJournalMetadata(): JournalMetadata
  projectItem(id: string, viewer: ProjectionViewer): LogicalItemDto | undefined
  projectTimeline(query: TimelineQuery): LogicalTimelineEnvelope
  projectThread(id: string, viewer: ProjectionViewer): LogicalThreadEnvelope | undefined
  projectHistory(id: string, viewer: ProjectionViewer): LogicalHistoryEnvelope | undefined
  getRun(id: string): AdminAcquisitionRun | undefined
  listRuns(sourceId: string, cursor: RunCursor | undefined, limit: number): AdminPage<AdminRunProjection>
  listJobs(runId: string, cursor: JobCursor | undefined, limit: number): AdminPage<AdminReconciliationJobSummary>
  listItemAudit(logicalItemId: string, cursor: { createdAt: string; id: string } | undefined, limit: number): AdminPage<ItemAuditEvent>
}
