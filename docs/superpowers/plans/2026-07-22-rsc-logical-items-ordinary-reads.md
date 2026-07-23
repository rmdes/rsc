# RSC Logical Items and Ordinary Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the disabled-by-default Vertical 2 logical-item acquisition,
reconciliation, ordinary-read, feed, Web, and durable SSE path without dual
writing or exposing Vertical 3 evidence-review behavior.

**Architecture:** Extend the Vertical 1 source registry with an additive
logical-v2 schema. Network acquisition commits immutable observations and
durable jobs; an in-process serial drain reconciles each version into logical
identity, presentation, ancestry, and journal effects. One snapshot projector
serves API, feeds, Web SSR, and SSE while local posts remain authoritative
through a one-to-one bridge.

**Tech Stack:** Node 22 native TypeScript, Hono, better-sqlite3/Kysely,
feedsmith, Vitest, SvelteKit 2, Svelte 5.

**Revision:** 4 — folds the dual plan review (correctness QC1-4 + ponytail
VP1-8; adjudications in
`docs/superpowers/reviews/2026-07-22-v2-logical-items-spec-review.md`,
section "PLAN REVIEW (2026-07-23)"). Applied: QC1 (the core-side capability
supersession is now a Task 5 step staging
`core/test/source-capability-api.test.ts`; the web task keeps only the type
widening), QC2+VP5 (`AdminPage<T>` is the one canonical page name), QC3
(Appendix D's refresh sketch carries the admin cookie), QC4 (dead "feed
proxy" prose deleted), VP2 (the branded ReadTx/WriteTx symbol types and the
nested-write-rejection test are dropped; `read()`/`write()` are thin wrappers
over `raw.transaction(fn).deferred()`/`.immediate()` — the `sqlite.ts` house
idiom; nesting is SAVEPOINT-safe natively), VP3 (only the timeline ordering
index ships; the other composites are deferred behind a ponytail comment),
VP4 (`threading.ts` and its test are created in Task 3 and modified
thereafter), VP6 (the `LogicalStore` interface is removed — `store.ts`
exports the concrete factory and TS infers; `LogicalReadTx` stays as the one
stub seam), VP7 (one shared `encodeCursor`/`decodeCursor` for the
run/job/timeline pagination cursors plus one shared invalid-cursor test
table; the journal cursor stays separate per spec §5.2), VP8 (old Task 3
merged into Task 2). VP1 was refuted — Appendix A now states why run-level
push-capability capture is forced. **Task renumbering:** old Task 3 is merged
into Task 2, so old Tasks 4-13 are now Tasks 3-12 (13 tasks → 12); any
external reference to a rev-3 task number from 4 upward shifts down by one.

Revision 3 folded spec review rev 1 (folded into the spec at commit
`9892757`) onto the revision-2 spine (dependency order, shared SQLite
transaction boundary, up-front cross-task signatures, red/green slices — all
retained). Removed as dead: the epoch/`replay_floor_seq`/`pruneJournal`
journal ring (now `highWaterSeq` + `resetGeneration`), every fence/`leaseUntil`
field and column (acquisition claims, reconciliation jobs, orphan work) in
favor of a per-source in-process in-flight boolean and a serial drain, the
four-slot scheduler and its 16-row window (now one global serial poll loop
with `next_poll_at` renamed `last_poll_at`), parent/root reply upserts and
their reset fallback (now one journal effect per reply plus a send-time
`replyCounts` overlay), "four evidence levels" (now three), and the
`Idempotency-Key` header (command IDs travel as body `commandId`). Added: the
C1 capability-failure carve, the C2 `jsonWrite` pin, the C3 request-fingerprint
pin, the C5 V1 capability-test supersession, the WP4 inert push-capability
column, and the source-scoped `policy_generation` column.

**Status:** Plan review folded (rev 4); READY for implementation — execution remains gated on the roadmap's all-four-plans + final cross-vertical review gate.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-07-22-rsc-logical-items-ordinary-reads-design.md` rev 4 (review rev 1 folded, commit `9892757`).
- Prerequisite: Vertical 1 plan rev 4 has been implemented and reviewed.
- Companion dependency: root-only plan commit `7e7dc14` is executed as the
  first Vertical 2 slice; refuse execution if that path no longer matches the
  reviewed commit.
- `RSC_SOURCE_MODEL_V2` remains startup-immutable and defaults off. No dual writes, legacy remote conversion, v2 push, origin verification, moderation, purge, evidence-review API, or policy fan-out.
- V2 startup fails closed until schema, activation barrier, projector, journal, poll loop, reconciliation drain, and orphan worker are ready.
- Core stores and returns semantic content; Web alone renders HTML through `web/src/lib/server/render.ts`. Never add another sanitizer path.
- Use one SQLite write transaction for every domain mutation and its journal effects. Notifications happen after commit and contain sequence hints only.
- No TypeScript parameter properties in `core/src`; no new dependency without a separate approved design.
- Core route tasks must invoke `.claude/skills/hono/SKILL.md`. Web tasks must invoke the repository UI/Svelte skills and follow `design-system/rsc/MASTER.md`.
- Stage explicit paths only. Every commit ends with `developed with the help of AI tools`.
- This plan may be implemented only after all four vertical plans and the final cross-vertical review pass.

## File map and shared interfaces

Create focused modules rather than growing `sqlite.ts`, `service.ts`, or
`app.ts` into a second implementation:

```text
core/src/logical/types.ts             exact spec DTOs and internal records
core/src/logical/schema.ts            additive migration SQL and activation v1
core/src/logical/database.ts          shared read/write SQLite transaction context
core/src/logical/store.ts             bounded transactional reads/writes
core/src/logical/journal.ts           reset generation, cursor, append, replay
core/src/logical/projector.ts         pure effective selection and DTO projection
core/src/logical/local.ts             local bridge and mutation integration
core/src/logical/acquisition.ts       bounded fetch, redirects, parsing, observations
core/src/logical/scheduler.ts         single-lane serial polling and durable health
core/src/logical/reconcile.ts         in-process serial reconciliation drain
core/src/logical/threading.ts         parent resolution, adoption, bounded projection
core/src/logical/runtime.ts           startup activation and worker composition
core/src/api/logical-routes.ts        v2 ordinary/admin routes and stream
web/src/lib/logical-types.ts          browser-safe mirror of v2 wire contracts
web/src/lib/logical-api.ts            capability-checked v2 Core client
web/src/lib/logical-live.ts           upsert/remove/reset reconciliation
```

`core/src/logical/types.ts` exports the spec names verbatim:
`LogicalItemDto`, `SelectedAuthor`, `ReplyContextDto`, `EnclosureDto`,
`LogicalSingleItemEnvelope`, `LogicalThreadEnvelope`, `LogicalHistoryEnvelope`,
`TimelineLens`, `LogicalTimelineEnvelope`, `JournalCursor`, `ReplyCountOverlay`,
`AdminRunProjection`, `AdminRefreshResult`, and `AdminAcquisitionRun`.

Vertical 1 and Vertical 2 share this exact transaction boundary. Task 2 changes
`createSourceRepository(raw)` to `createSourceRepository(db)` and keeps all
Vertical 1 command signatures stable:

```ts
import type BetterSqlite3 from 'better-sqlite3'

export type ReadTx = BetterSqlite3.Database
export type WriteTx = BetterSqlite3.Database
export interface DatabaseContext {
  raw: BetterSqlite3.Database
  read<T>(fn: (tx: ReadTx) => T): T   // thin wrapper: raw.transaction(fn).deferred()
  write<T>(fn: (tx: WriteTx) => T): T // thin wrapper: raw.transaction(fn).immediate()
}
export function createDatabaseContext(raw: BetterSqlite3.Database): DatabaseContext

export type JournalEffect =
  | { kind:'upsert'; logicalItemId:string; changeMask:JournalChangeMask }
  | { kind:'remove'; logicalItemId:string; changeMask:JournalChangeMask }
  | { kind:'reset'; changeMask:JournalChangeMask }
export function appendJournal(tx: WriteTx, effect: JournalEffect, now:string): number

export interface LogicalReadTx {
  getActivation(): SourceModelV2Activation
  getJournalMetadata(): JournalMetadata
  projectItem(id:string, viewer:ProjectionViewer): LogicalItemDto | undefined
  projectTimeline(query:TimelineQuery): LogicalTimelineEnvelope
  projectThread(id:string, viewer:ProjectionViewer): LogicalThreadEnvelope | undefined
  projectHistory(id:string, viewer:ProjectionViewer): LogicalHistoryEnvelope | undefined
  getRun(id:string): AdminAcquisitionRun | undefined
  listRuns(sourceId:string, cursor:RunCursor|undefined, limit:number): AdminPage<AdminRunProjection>
  listJobs(runId:string, cursor:JobCursor|undefined, limit:number): AdminPage<AdminReconciliationJobSummary>
}
// rev 4 (VP6): the LogicalStore interface is removed — store.ts exports the
// concrete factory and TS infers its type; LogicalReadTx above is the one
// stub seam tests need. The returned object carries exactly:
export function createLogicalStore(db: DatabaseContext): {
  snapshot<T>(fn:(tx:LogicalReadTx)=>T):T
  claimAcquisition(input:ClaimAcquisitionInput):ClaimAcquisitionResult
  commitAcquisition(input:CommitAcquisitionInput):AcquisitionRun
  failAcquisition(input:FailAcquisitionInput):AcquisitionRun
  claimReconciliation(now:string):ReconciliationClaim|null
  reconcileClaim(input:ReconcileClaimInput):ReconcileResult
  recordReconciliationFailure(input:RecordJobFailureInput):void
  scheduleOrphanWork(tx:WriteTx,input:NewOrphanWork):void
  claimOrphanWork(now:string):OrphanClaim|null
  adoptOrphans(input:AdoptOrphansInput):AdoptOrphansResult
}
```

The input/result records are fixed before their first consumer:

```ts
export type AcquisitionReason =
  | {kind:'scheduled'}
  | {kind:'administrator';command:CommandEnvelope}
export interface ClaimAcquisitionInput {sourceId:string;reason:AcquisitionReason;now:string}
export type ClaimAcquisitionResult =
  | {kind:'claimed';runId:string;source:RemoteSource}
  | {kind:'unavailable';reason:'unknown'|'paused'|'blocked'|'unscheduled'}
export interface CommitAcquisitionInput {runId:string;sourceId:string;committedAt:string;effectiveUrl:string|null;validators:ConditionalValidators|null;redirects:RedirectObservation[];observations:NewObservationVersion[];findings:AcquisitionFinding[];counters:AdminAcquisitionCounters;outcome:AdminFetchProjection['outcome'];pushCapabilityJson:string|null}
export interface FailAcquisitionInput {runId:string;sourceId:string;now:string;outcome:'operational_failure'|'cancelled'|'superseded'|'policy_rejected';category:AdminFetchProjection['failureCategory'];diagnostic:string|null}
export interface ReconciliationClaim {jobId:string;runId:string;observationVersionId:string}
export interface ReconcileClaimInput {claim:ReconciliationClaim;now:string}
export type ReconcileResult = {kind:'reconciled'|'conflicted';logicalItemId:string}|{kind:'superseded'}
export interface RecordJobFailureInput {jobId:string;now:string;category:'operational_exhausted'|'invariant_or_data_failure';diagnostic:string|null;retryAt:string|null}
export interface NewOrphanWork {aliasKind:'permalink'|'scoped_opaque';aliasKey:string;candidateHighWater:string;createdAt:string}
export interface OrphanClaim {workId:string;candidateHighWater:string}
export interface AdoptOrphansInput {claim:OrphanClaim;now:string;limit:number}
export interface AdoptOrphansResult {adopted:number;ambiguous:number;remaining:boolean}
export interface TimelineQuery {lens:TimelineLens;before:TimelineCursorV2|null;limit:number;viewer:ProjectionViewer}
export interface ProjectionViewer {localAccountId:string|null;activeSourceIds:readonly string[]}
export interface ConditionalValidators {effectiveUrl:string;etag:string|null;lastModified:string|null}
export interface SourceModelV2Activation {schemaVersion:1;state:'never_activated'|'active'|'reconciliation_required';lastActivatedAt:string|null;lastReconciledAt:string|null}
export interface JournalMetadata {highWaterSeq:number;resetGeneration:number}
export type JournalChangeMask = 'presentation'|'author'|'visibility'|'classification'|'ancestry'|'reply_counts'|'history'|'barrier'
export interface RedirectObservation {ordinal:number;status:number|null;fromEvidence:string;toEvidence:string;permanentProof:boolean}
export interface NewObservationVersion {id:string;deliveryId:string;wireOrdinal:number;arrivalAt:string;fingerprintVersion:1;fingerprint:string;canonicalMaterial:Uint8Array;rawEvidenceJson:string;normalizedJson:string}
export interface AcquisitionFinding {kind:'fingerprint_collision'|'item_evidence_limit'|'enclosure_limit'|'operational_identifier_limit'|'invalid_identifier'|'redirect_ownership_conflict'|'redirect_loop'|'parser_item_error';evidenceJson:string}
export interface RunCursor {startedAt:string;runId:string}
export interface JobCursor {createdAt:string;jobId:string}
export interface TimelineCursorV2 {version:1;timelineSortAt:string;logicalItemId:string}
// rev 4 (VP7): one shared codec serves all three pagination cursors
// (RunCursor, JobCursor, TimelineCursorV2) and one shared invalid-cursor
// test table is exercised by the admin pagination and timeline routes; the
// journal cursor keeps its own generation-qualified codec (spec §5.2).
export function encodeCursor(version:1, tuple:readonly string[]):string
export function decodeCursor(cursor:string):{version:1;tuple:readonly string[]}|null
export interface AdminPage<T> {model:'logical-v2';items:T[];nextCursor:string|null}
export type NormalizedReplyReference =
  | {kind:'permalink';key:string;scope:null;raw:string}
  | {kind:'opaque';key:string;scope:{kind:'source'|'publisher';id:string}|null;raw:string}
export type ParentResolutionResult =
  | {state:'none'|'missing'|'ambiguous';parentLogicalItemId:null}
  | {state:'resolved';parentLogicalItemId:string}
export interface LogicalScheduler {start():void;stop():void;wake():void;drainOnce(now:string):Promise<number>}
export interface LogicalRuntime {scheduler:LogicalScheduler;stop():Promise<void>;ready:Promise<void>}
export function createLogicalRuntime(input:{db:DatabaseContext;store:ReturnType<typeof createLogicalStore>;sourceRepository:SourceRepository;config:Config;notify:(sequence:number)=>void}):LogicalRuntime
```

Local and source commands receive `DatabaseContext` (a `write()` inside a
`write()` is SAVEPOINT-safe natively — no rejection machinery):

```ts
createLocalPost(input:{tx:WriteTx;author:User;content:string;replyToId:string|null;now:string}):LogicalItemDto
editLocalPost(input:{tx:WriteTx;postId:string;authorId:string;content:string;now:string}):LogicalItemDto
deleteLocalPost(input:{tx:WriteTx;postId:string;actorId:string;now:string}):void
deleteLocalAccount(input:{tx:WriteTx;accountId:string;actorId:string;now:string}):void
resolveInitialParent(tx:WriteTx,input:{observationVersionId:string;reference:NormalizedReplyReference|null;logicalItemId:string}):ParentResolutionResult
```

---

### Task 1: Execute the root-only companion slice

**Files:** The exact files and tests listed in
`docs/superpowers/plans/2026-07-22-root-only-timelines.md`.

**Interfaces:** Produces the reviewed v1 `topLevel` timeline behavior and compact
reply-count UI. Vertical 2 later replaces its transient SSE count enrichment
with durable logical journal effects.

- [ ] **Step 1:** Execute that reviewed plan task-by-task with its required TDD and review gates.
- [ ] **Step 2:** Run `npm test -w core && npm run typecheck -w core && npm test -w web && npm run check -w web && npm run build -w web`; expect all commands to exit 0.
- [ ] **Step 3:** Record the companion plan's final reviewed commit in this plan's execution notes. Do not rewrite its historical tasks.

### Task 2: Shared database context, exact contracts, additive schema, and journal primitives

**Files:** Create `core/src/logical/types.ts`, `core/src/logical/schema.ts`,
`core/src/logical/store.ts`, `core/src/logical/database.ts`,
`core/src/logical/journal.ts`, `core/test/logical-schema.test.ts`,
`core/test/logical-database.test.ts`, `core/test/logical-journal.test.ts`,
`core/test/logical-runtime-guard.test.ts`;
modify `core/src/storage/sqlite.ts`, `core/src/domain/source-repository.ts`.
Modify `core/src/server.ts` to reject configured v2 until Task 10 replaces the
guard with the complete runtime.

**Interfaces:** Produces all signatures above (the review-rev-1-folded
shapes), `DatabaseContext`, additive tables, the inactive activation row, and
the journal primitives `encodeJournalCursor`, `decodeJournalCursor`,
`appendJournal`, `readJournalBatch`, and snapshot cursor reads. It does not
reconcile or mark v2 active.

- [ ] **Step 1:** Add `logical-database.test.ts` proving one injected throw
  rolls back source, audit, ledger, and logical rows. Run
  `npm test -w core -- logical-database`; expect module-not-found.
- [ ] **Step 2:** Implement `createDatabaseContext()` as thin
  `read()`/`write()` wrappers over
  `raw.transaction(fn).deferred()`/`.immediate()` (the `sqlite.ts` house
  idiom; nesting is SAVEPOINT-safe natively) and refactor
  `source-repository.ts` ledger helpers to accept `WriteTx`.
- [ ] **Step 3:** Add `logical-schema.test.ts` asserting the exact tables listed
  in Appendix A and activation `{schemaVersion:1,state:'never_activated',
  lastActivatedAt:null,lastReconciledAt:null}` with no journal row.
- [ ] **Step 4:** Add the exact folded rev 4 types (boolean
  `classification.personal`/`.federated`, three evidence levels,
  `resetGeneration` journal metadata) and schema migration; run
  `npm test -w core -- logical-database logical-schema && npm run typecheck -w core`;
  expect PASS.
- [ ] **Step 4a:** Add a server composition assertion that
  `RSC_SOURCE_MODEL_V2=on` throws `logical-v2 runtime unavailable` before
  listening; implement that temporary fail-closed guard in `server.ts`.
- [ ] **Step 5:** Add red journal tests for generation-qualified opaque cursors, strict monotonic sequence growth without reuse, unknown/stale/future/older-generation cursor invalidity each answered by a single `reset` plus SSR refetch, ordinary `barrier` resets leaving the generation unchanged, reconstruction incrementing the generation with its initial reset in one transaction, and reset rows.
- [ ] **Step 6:** Run `npm test -w core -- logical-journal`; expect FAIL.
- [ ] **Step 7:** Implement cursor version 1 and transactional append — no retention ring, no pruning (`ponytail: no pruning; add retention when the journal table measurably matters`). Journal rows contain only sequence, kind, nullable logical ID, bounded change mask, and timestamp.
- [ ] **Step 8:** Run and commit exactly as Task 2's Appendix C row.

### Task 3: Local-origin bridge and atomic local mutations

**Files:** Create `core/src/logical/local.ts`, `core/src/logical/threading.ts`,
`core/test/logical-local.test.ts`, `core/test/logical-threading.test.ts`;
modify `core/src/domain/service.ts`, `core/src/storage/sqlite.ts`,
`core/src/logical/store.ts`.

**Interfaces:** Produces the exact local command signatures above plus
`resolveInitialParent()`. This task creates `threading.ts` and its test;
Task 7 later modifies them. Reconciliation cannot begin before this task.

- [ ] **Step 1:** Add red local tests for read-without-write synthesis,
  `logicalId === post.id`, restrictive unique local origin, atomic
  mutation+journal, remote echo protection, deleted marker, descendant edge,
  one account reset, and no tombstone FK.
- [ ] **Step 2:** Run `npm test -w core -- logical-local`; expect FAIL.
- [ ] **Step 3:** Add ancestry tests for exact permalink/scoped-opaque
  resolution, unscoped ambiguity, none/missing/ambiguous/resolved state, cycle
  and depth rejection, and initial observation-version evidence; implement
  `resolveInitialParent(tx,input)` in `local.ts`/`threading.ts`.
- [ ] **Step 4:** Move v2-on local mutations behind the exact commands while
  preserving the v1 branch. Emit only after-commit hints and local-feed push.
- [ ] **Step 5:** Run `npm test -w core -- logical-local logical-threading && npm run typecheck -w core`; expect PASS. Explicitly add `local.ts`, `threading.ts`, their tests, `service.ts`, `sqlite.ts`, and `store.ts`; commit `core: bridge local posts into logical v2` with footer.

### Task 4: Bounded acquisition, redirects, observations, and refresh command

**Files:** Create `core/src/logical/acquisition.ts`,
`core/test/logical-acquisition.test.ts`, `core/test/logical-bounds.test.ts`;
modify `core/src/domain/ingest.ts`, `core/src/domain/push-guard.ts`,
`core/src/logical/store.ts`.

**Interfaces:** Produces `acquireSource(sourceId, reason, signal)`, the
per-source in-process in-flight flag, adapter candidate records, canonical
fingerprint v1, and atomic run/observation/job commit.

- [ ] **Step 1:** Add red fixture tests for the total 10-second deadline, streaming 5 MiB decoded cap, five redirects, loop/hop SSRF/governance/ownership checks, permanent-chain aliases, effective-URL validators, 1,000 candidates, 1 MiB item evidence, 32 enclosures, operational string limits, redacted digest evidence, and inert push discovery.
- [ ] **Step 1a:** In adapter table tests assert RSS and Atom use document
  order, JSON Feed uses array order, and h-feed uses document order; assign
  ordinals before taking candidates `0..999`, and assert candidate 1000 is
  omitted even when earlier candidates were skipped.
- [ ] **Step 1b:** Add an isolation test that a feed advertising WebSub/rssCloud
  records only the inert parse-time push-capability evidence on its run row
  (nullable `push_capability_json`, validated by Vertical 3), persists no
  WebSub/rssCloud subscription or claim, and calls no push endpoint.
- [ ] **Step 2:** Add red identity tests for exact opaque IDs, normalized permalinks, fallback keys, complete first-arrival tuple, unchanged seen metadata, same-key multi-version jobs, and fingerprint-collision skip.
- [ ] **Step 3:** Run `npm test -w core -- logical-acquisition logical-bounds`; expect FAIL.
- [ ] **Step 4:** Implement streaming fetch/parsers and the two transactions (command association commits before the acquisition result, which rechecks policy and scheduling reason). Never call push endpoints and never partially parse an oversized body.
- [ ] **Step 5:** Run and commit exactly as Task 4's Appendix C row.

### Task 5: Serial poll loop, operational administration, and capability supersession

**Files:** Create `core/src/logical/scheduler.ts`,
`core/test/logical-scheduler.test.ts`, `core/test/logical-admin-api.test.ts`;
create `core/src/api/logical-routes.ts`; modify `core/src/api/app.ts`,
`core/src/server.ts`, `core/test/source-capability-api.test.ts`.

**Interfaces:** Produces scheduler `start/stop/wake`, refresh command ledger
association, run status/history/jobs, source acquisition summary, and the
superseded `/capabilities` enabled shape (spec §5.6) — this task is the first
to touch `core/src/api/app.ts` for v2 and lands the core-side supersession
before Task 11's web widening.

Exact Hono routes are:

```text
POST /admin/sources/:sourceId/refresh
GET  /admin/acquisition-runs/:runId
GET  /admin/sources/:sourceId/runs?before=&limit=
GET  /admin/acquisition-runs/:runId/jobs?before=&limit=
```

The refresh route composes the house `jsonWrite` bodyLimit guard positionally
(`jsonWrite = bodyLimit({ maxSize: MAX_JSON_BYTES })`, `core/src/api/app.ts:65`)
like every other authed JSON write. The command ID travels only as the
`commandId` JSON body field — the Vertical 1 command-ledger convention; there
is no idempotency header — and the request fingerprint inputs are exactly
`[command, sourceId, actor]`.

They return `AdminRefreshResult`, `AdminAcquisitionRun`, or
`AdminPage<AdminRunProjection|AdminReconciliationJobSummary>`.
Acquisition counters are exactly candidates/seen/observed/unchanged/skipped/
omitted/itemsTruncated/bodyLimitExceeded/notModified. Reconciliation counters
are reconciled/conflicted/pending/processing/retrying/failed plus both
failed-category counts.

- [ ] **Step 1:** Add red scheduler tests for one global serial loop in stable `sourceId` order, skip-if-recent on durable `lastPollAt` versus `RSC_POLL_SECONDS`, the per-source in-process in-flight boolean (a second acquisition is refused while one is active; an administrator command during flight associates with the active run instead of a second fetch; a crash clears the flag and startup begins with no active acquisitions), commit-time policy and scheduling-reason recheck rejecting stale results, a later run starting while an older run still has pending or retrying jobs, consecutive-failure counting with backoff deferred (`ponytail: single-lane poll + skip-if-recent; add backoff/slots only when a real feed misbehaves or feed count grows`), pause/block invalidation, manual refresh updating the same durable health, and startup running the same loop without a catch-up burst.
- [ ] **Step 2:** Add Hono route tests for the `jsonWrite` composition on the refresh route, `commandId` accepted only as the JSON body field, exact neutral 404, 409 idempotency conflict when a reused command ID varies command, source, or actor, created/joined/replayed disposition, zero-job terminal response, five-second 200/202, immutable pagination tuples (encoded and decoded through the shared `encodeCursor`/`decodeCursor` helper, with the shared invalid-cursor test table), admin-only matrix, secret redaction, and no push-capability field in any admin projection.
- [ ] **Step 3:** Run `npm test -w core -- logical-scheduler logical-admin-api`; expect FAIL.
- [ ] **Step 4:** Implement scheduler and routes using Vertical 1 authorization/ledger patterns. Do not add evidence-review endpoints.
- [ ] **Step 4a:** Widen the `/capabilities` endpoint — the V1 plan's known
  widening site (`docs/superpowers/plans/2026-07-20-rsc-source-control-plane.md`
  L88-94, L862-866; review C5): when v2 is configured on it emits the
  discriminated enabled shape
  `{sourceModelV2:true, model:'logical-v2', journalCursorVersion,
  streamProtocolVersion}` per spec §5.6; off keeps `{sourceModelV2:false}`.
  Update the exact-equality assertions
  (`toEqual({sourceModelV2:true})`) in
  `core/test/source-capability-api.test.ts` to the new shape.
- [ ] **Step 5:** Run and commit exactly as Task 5's Appendix C row.

### Task 6: Reconciliation, convergence, publishers, and presentation chains

**Files:** Create `core/src/logical/reconcile.ts`,
`core/src/logical/projector.ts`, `core/test/logical-reconcile.test.ts`,
`core/test/logical-presentation.test.ts`; modify `core/src/logical/store.ts`.

**Interfaces:** Consumes `resolveInitialParent(tx, ...)` inside the same job
transaction. Produces the in-process serial drain, pure comparators,
convergence, publisher names, and presentation.

- [ ] **Step 1:** Add red worker tests for the serial one-job-at-a-time drain in `(nextAttemptAt, jobId)` order, drain after each acquisition commit plus a startup drain of pending/retrying jobs, the `min(5s * 2^(attempt-1), 15 min)` retry formula with eight-failure exhaustion, commit-time policy-generation verification, supersession consuming no attempt, separate failure bookkeeping, version serialization in first-arrival order, and immutable terminal runs.
- [ ] **Step 2:** Add red domain tests for exact convergence keys, local-first lookup, isolated conflicts, mode-neutral claims, three evidence levels, current strongest-level stability, complete arrival/lexical ties, publisher naming normalization/ranking/reset, and per-delivery watermark/rollback/arrival fallback.
- [ ] **Step 3:** Run `npm test -w core -- logical-reconcile logical-presentation`; expect FAIL.
- [ ] **Step 4:** Implement one bounded transaction per job; all logical effects, hints, journal records, job state, and counters commit together. Reads remain authority and never repair hints.
- [ ] **Step 5:** Run and commit exactly as Task 6's Appendix C row.

### Task 7: Orphan worker and bounded thread projection

**Files:** Modify `core/src/logical/threading.ts`,
`core/test/logical-threading.test.ts` (both created in Task 3), and
`core/src/logical/store.ts`.

**Interfaces:** Consumes Task 3 initial ancestry. Produces durable late adoption,
subtree proof, `projectThread`, and `LogicalThreadEnvelope`.

- [ ] **Step 1:** Add red tests for missing-to-ambiguous terminal failures,
candidate high water, 500-node subtree proof, depth 64, reset-only adoption,
and deleted target exclusion.
- [ ] **Step 2:** Add projection tests for reserved root-to-request path, 500 structural nodes, independent truncation flags, structural-before-policy loading, placeholders, unavailable leaf 404, sibling ordering, and snapshot journal cursor.
- [ ] **Step 3:** Run `npm test -w core -- logical-threading`; expect FAIL.
- [ ] **Step 4:** Implement the continuous orphan worker and bounded recursive queries; roots are derived only.
- [ ] **Step 5:** Run and commit exactly as Task 7's Appendix C row.

### Task 8: Ordinary projector, lenses, item/history routes, and feeds

**Files:** Create `core/test/logical-projector.test.ts`,
`core/test/logical-routes.test.ts`, `core/test/logical-feeds.test.ts`; modify
`core/src/logical/projector.ts`, `core/src/api/logical-routes.ts`,
`core/src/api/app.ts`, `core/src/domain/feed.ts`.

**Interfaces:** Produces `/timeline`, `GET /post/:id`, thread, revisions, and
existing feed branches returning exact model-v2 envelopes.

- [ ] **Step 1:** Add red projector tests using stale hints for exact DTO bounds, boolean `classification.personal`/`classification.federated` (no per-item source-ID arrays; local items always `federated: false`), local echo classification, root-only river filters before LIMIT, activity author/publisher replies, Personal from current membership, Federated from any approved source, query-time `directReplyCount`/`conversationReplyCount` derived in the read snapshot with no stored counts, immutable ordering/cursors, and deterministic selection. Provenance assertions check membership, not exhaustive enum equality — Vertical 4 widens `updatedAtProvenance` with `legacy_unknown` at cutover.
- [ ] **Step 2:** Add route tests for strict selector parsing, exact invalid lens/cursor responses (cases drawn from the shared invalid-cursor test table over the shared `encodeCursor`/`decodeCursor` helper), single-item 200/404, snapshot cursors, history selected-chain rules, and v1/v2 branch rejection.
- [ ] **Step 3:** Add feed tests: firehose local replies, local-author replies, direct-only comments, no publisher feed, no placeholders, and central policy projection.
- [ ] **Step 4:** Run the three focused suites; expect FAIL. Implement batched snapshot reads and routes without ordinary writes.
- [ ] **Step 5:** Run and commit exactly as Task 8's Appendix C row, then run
  `npm test -w core -- feed threading timeline-tabs`; expect PASS.

### Task 9: Source/profile transitions and durable reply invalidation

**Files:** Create `core/test/logical-policy-events.test.ts`; modify Vertical 1
source command module, `core/src/domain/service.ts`, `core/src/logical/store.ts`.

**Interfaces:** Produces exact generation/reset rules and the single
per-reply journal effect (no fan-out to other items).

- [ ] **Step 1:** Add red tests for governance/federation/mode generation+reset, pause/resume no reset, subscription/follow/profile reset rules, no-op/replay, publisher label reset, exactly one journal effect per bounded reply mutation (the reply's own upsert/remove — no parent upsert, no root upsert, no reset fallback), content-edit no count effect, and reset-only adoption/account/source-wide changes.
- [ ] **Step 2:** Run `npm test -w core -- logical-policy-events`; expect FAIL.
- [ ] **Step 3:** Insert journal append calls inside the existing Vertical 1/local transactions; never append after commit or perform fan-out.
- [ ] **Step 4:** Run and commit exactly as Task 9's Appendix C row.

### Task 10: Durable SSE protocol and runtime isolation

**Files:** Create `core/test/logical-sse.test.ts`,
`core/test/logical-runtime.test.ts`; create `core/src/logical/runtime.ts`; modify
`core/src/api/logical-routes.ts`, `core/src/server.ts`, `core/src/domain/bus.ts`.

**Interfaces:** Produces generation-qualified SSE `upsert | remove | reset`,
buffered sequence hints, heartbeat catch-up, and v1/v2 startup isolation.

- [ ] **Step 1:** Add red SSE tests for query-to-header cursor seed, missing/invalid reset-close, stored/synthesized reset IDs, unknown/stale/older-generation cursors emitting exactly one reset then closing, listener-before-replay, coalesced hints, heartbeat comments, send-time projection attaching the `replyCounts` overlay (root ID plus authoritative ordinary-visible conversation count from the same projection snapshot) exactly when a resolved reply's bounded mutation changed its root's count, orphan adoption and policy barriers riding their single reset with no overlay, and no placeholder events.
- [ ] **Step 2:** Add runtime tests proving configured v2 fails closed before
  this task's complete runtime exists; disabled starts legacy poll/push; enabled
  installs neither; journal/projector/scheduler/reconciliation/orphan instances
  are constructed and ready before one pre-listen activation transaction;
  continuous restart preserves timestamps; local after-commit hints retain
  outbound feed push.
- [ ] **Step 3:** Run `npm test -w core -- logical-sse logical-runtime`; expect FAIL.
- [ ] **Step 4:** Implement journal-driven stream and explicit runtime composition. The bus never supplies SSE content authority.
- [ ] **Step 5:** Run and commit exactly as Task 10's Appendix C row.

### Task 11: Capability-aware Web DTOs, pages, feeds, and live reconciliation

**Files:** Create `web/src/lib/logical-types.ts`, `web/src/lib/logical-api.ts`,
`web/src/lib/logical-live.ts`, `web/src/lib/logical-api.test.ts`,
`web/src/lib/logical-live.test.ts`, `web/src/routes/p/[publisherId]/+page.server.ts`,
`web/src/routes/p/[publisherId]/+page.svelte`; modify timeline, local-author,
following, post, history, thread proxy, and stream proxy files.

**Interfaces:** Consumes exact v2 envelopes; produces capability/model validation,
shared semantic rendering, publisher page, and sorted live upsert/remove/reset.

- [ ] **Step 1:** Add red API tests for discriminated capabilities, exact envelope validation, single item, lenses, and v1 isolation — with the failure carve as two tests: a capability fetch failure (unreachable, non-200, or throw) degrades to the legacy path for that request only, retries capability on the next request, and memoizes only success (never a sticky failure); a successful v2 capability followed by a missing/malformed/mismatched envelope fails closed — discard, close, revalidate — never falling back to v1.
- [ ] **Step 2:** Add red live/proxy tests for opaque cursor forwarding/header precedence, upsert-only rendering, remove/reset passthrough, malformed close/revalidate, reset SSR reconnect, immutable insertion, river reply exclusion (a resolved-reply frame never inserts a card and never materializes an off-page parent or root), and the `replyCounts` overlay: replace a loaded root card's conversation count with the frame's authoritative value, do nothing otherwise, never increment or decrement optimistically, and applying the same frame twice is idempotent.
- [ ] **Step 3:** Add page tests for both feature states, publisher 404/empty descriptor, local `/u`, root-only rivers, activity replies, thread placeholders, history sanitizer, and no publisher follow.
- [ ] **Step 4:** Run `npm test -w web`; expect focused failures. Implement capability branches without casting between models.
- [ ] **Step 4a:** Widen the V1 web capability type to carry `model`,
  `journalCursorVersion`, and `streamProtocolVersion` — an intentional
  supersession (spec §5.6, review C5). The staged
  `web/src/lib/api.ts`/`web/src/lib/types.ts` paths carry this edit; the core
  `/capabilities` endpoint and `core/test/source-capability-api.test.ts` were
  already superseded in Task 5.
- [ ] **Step 5:** Run and commit exactly as Task 11's Appendix C row.

### Task 12: Operational admin Web and whole-vertical gate

**Files:** Create `web/src/routes/admin/sources/[sourceId]/runs/+page.server.ts`,
`web/src/routes/admin/sources/[sourceId]/runs/+page.svelte`,
`web/src/routes/admin/sources/[sourceId]/source-detail.test.ts`;
modify the Vertical 1 source-detail page and `web/src/lib/logical-api.ts`;
create `core/test/logical-vertical.test.ts`.

**Interfaces:** Produces refresh/run/job UI only and proves the complete default-off
Vertical 2 boundary.

- [ ] **Step 1:** Add admin Web tests for command ID retention, neutral refusal, 200 terminal versus success, 202 polling, health/nonterminal runs, pagination, quarantined labeling, and absence of evidence-review links.
- [ ] **Step 2:** Add integration tests for first activation, continuous restart, disabled interval/reactivation, scheduler-to-observation-to-job-to-projection-to-journal, crash recovery (the in-flight flag clears with the process; the startup drain picks up pending/retrying jobs), local/remote convergence, and every cross-model isolation rule.
- [ ] **Step 3:** Run `npm test -w web -- source-detail`; expect FAIL with the
  absent admin logical API. Implement only the run/status
  functions in `web/src/lib/logical-api.ts`, the two run page files, the
  source-detail refresh action/status panel, and the runtime wiring exercised by
  `core/test/logical-vertical.test.ts`.
- [ ] **Step 4:** Run the completion gate: `npm test -w core`, `npm run typecheck -w core`, `npm test -w web`, `npm run check -w web`, and `npm run build -w web`; expect all exit 0.
- [ ] **Step 5:** Run `git diff --check`, stage explicit paths, commit with the required footer, and stop for Vertical 2 implementation review. Do not enable v2 by default or begin Vertical 3.

## Appendix A: exact migration inventory

Task 2 adds one migration entry in `core/src/storage/sqlite.ts` calling
`installLogicalV2Schema(raw)`. All timestamps are normalized UTC `TEXT`; every
status column has the CHECK values named below; every foreign key is
`ON DELETE RESTRICT` unless explicitly stated.

```text
logical_activation_v2(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL CHECK(schema_version=1),
 state TEXT NOT NULL CHECK(state IN('never_activated','active','reconciliation_required')),
 last_activated_at TEXT, last_reconciled_at TEXT)
logical_journal_meta_v2(singleton INTEGER PRIMARY KEY CHECK(singleton=1),high_water_seq INTEGER NOT NULL,reset_generation INTEGER NOT NULL)
logical_journal_v2(sequence INTEGER PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN('upsert','remove','reset')),logical_item_id TEXT,change_mask INTEGER NOT NULL,created_at TEXT NOT NULL)
remote_publishers_v2(id TEXT PRIMARY KEY,canonical_feed_url TEXT UNIQUE,identity_level TEXT NOT NULL CHECK(identity_level IN('feed_anchored','source_scoped_fallback')),created_at TEXT NOT NULL)
publisher_names_v2(id TEXT PRIMARY KEY,publisher_id TEXT NOT NULL REFERENCES remote_publishers_v2(id),source_id TEXT NOT NULL REFERENCES remote_sources_v2(id),observation_version_id TEXT NOT NULL,evidence_level TEXT NOT NULL,normalized_name TEXT,first_seen_at TEXT NOT NULL,effective INTEGER NOT NULL CHECK(effective IN(0,1)))
logical_items_v2(id TEXT PRIMARY KEY,origin TEXT NOT NULL CHECK(origin IN('local','remote')),timeline_sort_at TEXT NOT NULL,parent_state TEXT NOT NULL CHECK(parent_state IN('none','missing','ambiguous','resolved')),parent_logical_item_id TEXT REFERENCES logical_items_v2(id),selected_delivery_id TEXT,selected_publisher_id TEXT REFERENCES remote_publishers_v2(id),created_at TEXT NOT NULL)
logical_local_origins_v2(logical_item_id TEXT PRIMARY KEY REFERENCES logical_items_v2(id),post_id TEXT NOT NULL UNIQUE REFERENCES posts(id))
logical_deleted_local_v2(logical_item_id TEXT PRIMARY KEY REFERENCES logical_items_v2(id),canonical_permalink TEXT NOT NULL UNIQUE,deleted_at TEXT NOT NULL)
logical_identity_keys_v2(kind TEXT NOT NULL,key TEXT NOT NULL,logical_item_id TEXT NOT NULL REFERENCES logical_items_v2(id),PRIMARY KEY(kind,key))
deliveries_v2(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES remote_sources_v2(id),key_kind TEXT NOT NULL,key TEXT NOT NULL,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,last_seen_run_id TEXT NOT NULL,seen_count INTEGER NOT NULL,UNIQUE(source_id,key_kind,key))
observation_versions_v2(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL REFERENCES deliveries_v2(id),fingerprint_version INTEGER NOT NULL,fingerprint TEXT NOT NULL,canonical_material BLOB NOT NULL,arrival_at TEXT NOT NULL,run_id TEXT NOT NULL,wire_ordinal INTEGER NOT NULL,last_seen_at TEXT NOT NULL,last_seen_run_id TEXT NOT NULL,seen_count INTEGER NOT NULL,raw_evidence_json TEXT NOT NULL,normalized_json TEXT NOT NULL,UNIQUE(delivery_id,fingerprint_version,fingerprint))
presentation_entries_v2(delivery_id TEXT NOT NULL REFERENCES deliveries_v2(id),sequence INTEGER NOT NULL,observation_version_id TEXT NOT NULL UNIQUE REFERENCES observation_versions_v2(id),effective_updated_at TEXT,provenance TEXT CHECK(provenance IN('explicit','arrival')),material_fingerprint TEXT NOT NULL,PRIMARY KEY(delivery_id,sequence))
publisher_claims_v2(id TEXT PRIMARY KEY,logical_item_id TEXT NOT NULL REFERENCES logical_items_v2(id),publisher_id TEXT NOT NULL REFERENCES remote_publishers_v2(id),source_id TEXT NOT NULL REFERENCES remote_sources_v2(id),observation_version_id TEXT NOT NULL REFERENCES observation_versions_v2(id),evidence_level TEXT NOT NULL,first_seen_at TEXT NOT NULL)
logical_conflicts_v2(id TEXT PRIMARY KEY,logical_item_id TEXT REFERENCES logical_items_v2(id),observation_version_id TEXT REFERENCES observation_versions_v2(id),kind TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL)
orphan_work_v2(id TEXT PRIMARY KEY,alias_kind TEXT NOT NULL,alias_key TEXT NOT NULL,candidate_high_water TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','processing','complete')),created_at TEXT NOT NULL)
acquisition_runs_v2(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES remote_sources_v2(id),reason TEXT NOT NULL CHECK(reason IN('scheduled','administrator_refresh')),status TEXT NOT NULL CHECK(status IN('processing','terminal')),started_at TEXT NOT NULL,acquisition_committed_at TEXT,completed_at TEXT,outcome TEXT NOT NULL,counters_json TEXT NOT NULL,failure_category TEXT,diagnostic TEXT,push_capability_json TEXT)
acquisition_commands_v2(actor_id TEXT NOT NULL,command_id TEXT NOT NULL,request_fingerprint TEXT NOT NULL,run_id TEXT REFERENCES acquisition_runs_v2(id),refusal_json TEXT,created_at TEXT NOT NULL,PRIMARY KEY(actor_id,command_id))
source_health_v2(source_id TEXT PRIMARY KEY REFERENCES remote_sources_v2(id),last_poll_at TEXT,last_success_at TEXT,last_failure_at TEXT,consecutive_failures INTEGER NOT NULL)
source_validators_v2(source_id TEXT NOT NULL REFERENCES remote_sources_v2(id),effective_url TEXT NOT NULL,etag TEXT,last_modified TEXT,PRIMARY KEY(source_id,effective_url))
redirect_observations_v2(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES acquisition_runs_v2(id),ordinal INTEGER NOT NULL,status INTEGER,from_evidence TEXT NOT NULL,to_evidence TEXT NOT NULL,permanent_proof INTEGER NOT NULL CHECK(permanent_proof IN(0,1)))
acquisition_findings_v2(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES acquisition_runs_v2(id),kind TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL)
reconciliation_jobs_v2(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES acquisition_runs_v2(id),observation_version_id TEXT NOT NULL UNIQUE REFERENCES observation_versions_v2(id),status TEXT NOT NULL CHECK(status IN('pending','processing','retrying','reconciled','conflicted','failed')),attempts INTEGER NOT NULL,next_attempt_at TEXT NOT NULL,failure_category TEXT,diagnostic TEXT,created_at TEXT NOT NULL)
```

Two additive obligations from the cutover spec ride the same migration:
`acquisition_runs_v2.push_capability_json` is the nullable parse-time
push-capability evidence (cutover spec §9, review WP4) — written inert by V2,
validated only by Vertical 3, exposed by no admin projection. And
`remote_sources_v2` gains source-scoped
`policy_generation INTEGER NOT NULL DEFAULT 0` via additive `ALTER TABLE`
(cutover spec §10.2): Appendix B transitions advance it and reconciliation
rechecks it at commit time. Note (VP1, refuted — keep the column):
`raw_evidence_json` is per-item (`observation_versions_v2`); feed-level
hub/cloud discovery is channel data that per-item evidence cannot reproduce,
so capture-at-parse into `acquisition_runs_v2.push_capability_json` is forced
(V3 review decision #5).

Required explicit indexes are only:

```text
logical_items_v2(timeline_sort_at DESC,id DESC)
```

Everything else rides the PK/UNIQUE auto-indexes. (`ponytail: only the
timeline ordering index ships; the dropped composites —
logical_items_v2(parent_logical_item_id,timeline_sort_at,id),
publisher_claims_v2(logical_item_id,evidence_level,first_seen_at,id),
observation_versions_v2(delivery_id,arrival_at,run_id,wire_ordinal,id),
acquisition_runs_v2(source_id,started_at DESC,id DESC),
reconciliation_jobs_v2(status,next_attempt_at,id),
orphan_work_v2(status,created_at,id) — are each added only when a real query
measurably slows.`)

## Appendix B: exact Vertical 1 integration points

Task 9 modifies only these planned Vertical 1 functions in
`core/src/domain/source-repository.ts` and their service callers in
`core/src/domain/source-service.ts`:

```text
resolveAndSubscribeSource: active creation/removal/activation appends reset
followLocalAccount/removeLocalFollow: membership change appends reset
establishFederation: governance/federation change advances generation + reset
transition(quarantine|allow|approve|reject|revoke|block|unblock|set_attribution_mode): generation + one reset
transition(pause|resume): generation retained, no reset
updateUserProfile(handle|displayName): one reset
```

Each repository function receives the existing `WriteTx` from
`DatabaseContext.write()`, calls `appendJournal(tx,effect,now)` before
`storeCommand(tx,...)`, and commits domain rows, audit, ledger result, and
journal together. Fault-injection tests throw immediately before audit, journal,
ledger, and commit and assert all four table families remain unchanged.

## Appendix C: mandatory per-task commands and commits

A task is not complete until its row passes exactly.

| Task | Red/green command | Explicit staged paths | Commit subject |
|---|---|---|---|
| 2 | `npm test -w core -- logical-database logical-schema logical-journal logical-runtime-guard && npm run typecheck -w core` | `core/src/logical/types.ts core/src/logical/schema.ts core/src/logical/database.ts core/src/logical/store.ts core/src/logical/journal.ts core/src/storage/sqlite.ts core/src/domain/source-repository.ts core/src/server.ts core/test/logical-schema.test.ts core/test/logical-database.test.ts core/test/logical-journal.test.ts core/test/logical-runtime-guard.test.ts` | `core: add logical v2 schema, transaction context, and journal` |
| 3 | `npm test -w core -- logical-local logical-threading && npm run typecheck -w core` | `core/src/logical/local.ts core/src/logical/threading.ts core/src/logical/store.ts core/src/domain/service.ts core/src/storage/sqlite.ts core/test/logical-local.test.ts core/test/logical-threading.test.ts` | `core: bridge local posts into logical v2` |
| 4 | `npm test -w core -- logical-acquisition logical-bounds && npm run typecheck -w core` | `core/src/logical/acquisition.ts core/src/logical/store.ts core/src/domain/ingest.ts core/src/domain/push-guard.ts core/test/logical-acquisition.test.ts core/test/logical-bounds.test.ts` | `core: acquire bounded logical deliveries` |
| 5 | `npm test -w core -- logical-scheduler logical-admin-api source-capability-api && npm run typecheck -w core` | `core/src/logical/scheduler.ts core/src/logical/store.ts core/src/api/logical-routes.ts core/src/api/app.ts core/test/logical-scheduler.test.ts core/test/logical-admin-api.test.ts core/test/source-capability-api.test.ts` | `core: schedule and inspect logical acquisition` |
| 6 | `npm test -w core -- logical-reconcile logical-presentation && npm run typecheck -w core` | `core/src/logical/reconcile.ts core/src/logical/projector.ts core/src/logical/store.ts core/test/logical-reconcile.test.ts core/test/logical-presentation.test.ts` | `core: reconcile logical delivery evidence` |
| 7 | `npm test -w core -- logical-threading && npm run typecheck -w core` | `core/src/logical/threading.ts core/src/logical/store.ts core/test/logical-threading.test.ts` | `core: resolve logical conversations` |
| 8 | `npm test -w core -- logical-projector logical-routes logical-feeds && npm run typecheck -w core` | `core/src/logical/projector.ts core/src/api/logical-routes.ts core/src/api/app.ts core/src/domain/feed.ts core/test/logical-projector.test.ts core/test/logical-routes.test.ts core/test/logical-feeds.test.ts` | `core: project logical ordinary reads` |
| 9 | `npm test -w core -- logical-policy-events source-federation source-lifecycle service && npm run typecheck -w core` | `core/src/domain/source-repository.ts core/src/domain/source-service.ts core/src/domain/service.ts core/src/logical/store.ts core/test/logical-policy-events.test.ts core/test/source-federation.test.ts core/test/source-lifecycle.test.ts core/test/service.test.ts` | `core: journal logical policy transitions` |
| 10 | `npm test -w core -- logical-sse logical-runtime sse push push-in && npm run typecheck -w core` | `core/src/logical/runtime.ts core/src/api/logical-routes.ts core/src/server.ts core/src/domain/bus.ts core/test/logical-sse.test.ts core/test/logical-runtime.test.ts` | `core: activate logical v2 runtime` |
| 11 | `npm test -w web && npm run check -w web && npm run build -w web` | `web/src/lib/logical-types.ts web/src/lib/logical-api.ts web/src/lib/logical-live.ts web/src/lib/logical-api.test.ts web/src/lib/logical-live.test.ts web/src/routes/p/[publisherId]/+page.server.ts web/src/routes/p/[publisherId]/+page.svelte web/src/routes/+page.server.ts web/src/routes/+page.svelte web/src/routes/u/[handle]/+page.server.ts web/src/routes/u/[handle]/+page.svelte web/src/routes/u/[handle]/following/+page.server.ts web/src/routes/u/[handle]/following/+page.svelte web/src/routes/post/[id]/+page.server.ts web/src/routes/post/[id]/+page.svelte web/src/routes/post/[id]/history/+page.server.ts web/src/routes/post/[id]/history/+page.svelte web/src/routes/post/[id]/thread.json/+server.ts web/src/routes/stream/+server.ts web/src/lib/api.ts web/src/lib/types.ts web/src/routes/page.load.test.ts web/src/routes/stream/server.test.ts` | `web: render logical v2 ordinary surfaces` |
| 12 | full completion gate in Task 12 | `core/test/logical-vertical.test.ts web/src/lib/logical-api.ts web/src/routes/admin/sources/[sourceId]/+page.server.ts web/src/routes/admin/sources/[sourceId]/+page.svelte web/src/routes/admin/sources/[sourceId]/runs/+page.server.ts web/src/routes/admin/sources/[sourceId]/runs/+page.svelte web/src/routes/admin/sources/[sourceId]/source-detail.test.ts` | `test: complete logical v2 vertical` |

Every subject is committed with this exact final paragraph:

```text
developed with the help of AI tools
```

The red invocation for each row is the same command run before implementation
and must fail on the named absent symbol or asserted behavior; the green
invocation is the same command after implementation and must exit 0.

## Appendix D: representative executable tests

Use these exact assertions in the named red suites; expand table cases without
changing the contracts:

```ts
// core/test/logical-database.test.ts
expect(() => db.write((tx) => {
  seedSource(tx, 's1')
  appendJournal(tx, {kind:'reset', changeMask:'barrier'}, NOW)
  throw new Error('fault-before-ledger')
})).toThrow('fault-before-ledger')
expect(count(raw, 'remote_sources_v2')).toBe(0)
expect(count(raw, 'logical_journal_v2')).toBe(0)

// core/test/logical-acquisition.test.ts
expect(parseOrdinals('rss', rss1001).map((x) => x.wireOrdinal))
  .toEqual(Array.from({length:1000}, (_, i) => i))
expect(parseOrdinals('jsonfeed', json1001).map((x) => x.id)).toEqual(jsonIds.slice(0, 1000))
expect(run.itemsTruncated).toBe(true)
expect(run.omitted).toBe(1)

// core/test/logical-admin-api.test.ts
// admin credential per the subscriptions-api.test.ts cookie pattern —
// without it the 401 fires before the body assertion
const cookie = await registeredSession(adminApp, 'boss@x.test', repo)
const first = await adminApp.request('/admin/sources/s1/refresh', {
  method:'POST', headers:{'content-type':'application/json', cookie}, body:'{"commandId":"c1"}'
})
expect(await first.json()).toMatchObject({model:'logical-v2',disposition:'created',status:'processing'})
// same commandId, different source: fingerprint [command, sourceId, actor] mismatches
const changed = await adminApp.request('/admin/sources/s2/refresh', {
  method:'POST', headers:{'content-type':'application/json', cookie}, body:'{"commandId":"c1"}'
})
expect(changed.status).toBe(409)
expect(await changed.json()).toEqual({model:'logical-v2',error:'idempotency conflict'})

// core/test/logical-runtime.test.ts
expect(() => compose({sourceModelV2:true,runtime:null})).toThrow('logical-v2 runtime unavailable')
const runtime = createLogicalRuntime(readyDependencies)
await runtime.ready
expect(order).toEqual(['journal','projector','scheduler','reconcile','orphan','activate','listen'])
```

Every mutation fault test repeats the first pattern with throws immediately
before audit, journal, ledger, and commit. Every HTTP test uses Hono
`app.request`; every Web test supplies both capability branches with the C1
carve: a capability fetch failure degrades to the legacy path for that request
and memoizes only success, while a model mismatch after a successful v2
capability rejects and revalidates instead of falling back.
