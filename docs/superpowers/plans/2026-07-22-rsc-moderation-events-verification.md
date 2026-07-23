# RSC Moderation, Events, and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the v2 model durably moderatable: hidden moderation with item
audit, generation-qualified policy fan-out, bounded origin verification with
the `verified_origin` rung and publisher aliases, purge with exactly two
tombstone mechanisms, tombstone-aware resolution and unblock, the bounded
admin review APIs, and the SSR review surfaces — all behind the same
startup-immutable `RSC_SOURCE_MODEL_V2=off` default.

**Architecture:** Every V3 effect extends the Vertical 2 branch: mutations are
ledger-backed `BEGIN IMMEDIATE` commands through `DatabaseContext.write()`,
hidden joins the ONE ordinary-visibility predicate in the central projector,
fan-out and verification ride the ONE reconciliation drain, and journal
effects stay the existing `upsert | remove | reset`. No new event kind, no
second scheduling loop, no second command idiom. The v2 push subsystem is
deferred out entirely (spec §3 is a forward constraint only — no push code,
schema, or test in this plan).

**Tech Stack:** Node 22 native TypeScript, Hono, better-sqlite3/Kysely,
feedsmith, Vitest, SvelteKit 2, Svelte 5.

**Revision:** 1 — initial draft against spec rev 1.

**Status:** DRAFT pending plan review; execution remains gated on the
roadmap's all-four-plans + final cross-vertical review gate.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-07-22-rsc-moderation-events-verification-design.md` rev 1.
- Prerequisites: V1 plan rev 5 and V2 plan rev 4 implemented and reviewed. Refuse execution if the two **lockstep amendments to the V2 plan** below did not land in V2's execution.
- `RSC_SOURCE_MODEL_V2` stays startup-immutable, default off. With v2 off no V3 route, worker, or write path is active and legacy behavior — including legacy push — is byte-identical.
- **Push is out of scope.** No WebSub/rssCloud code, schema, or test is touched beyond what V2 already shipped inert. `SourceSummary.push` stays deferred to V4.
- One SQLite `BEGIN IMMEDIATE` write transaction per mutation and its audit, ledger, hint, and journal effects, via the V2 `DatabaseContext.write()` idiom. Notifications after commit, sequence hints only.
- Reuse V2's exported helpers by exact name: `createDatabaseContext`, `createLogicalStore`, `LogicalReadTx`, `appendJournal`, `encodeCursor`/`decodeCursor` (+ the shared invalid-cursor test table), `AdminPage<T>`, and the house `jsonWrite` guard (`core/src/api/app.ts:65`, `MAX_JSON_BYTES` at `:63`). Command IDs travel only as the `commandId` JSON body field.
- Core stores and returns semantic content; Web alone renders HTML through `web/src/lib/server/render.ts`. Never add another sanitizer path.
- No TypeScript parameter properties in `core/src`; no new dependency.
- Core route tasks must invoke `.claude/skills/hono/SKILL.md`. Web tasks must invoke the repository UI/Svelte skills and follow `design-system/rsc/MASTER.md`.
- Stage explicit paths only. Every commit ends with `developed with the help of AI tools`.
- Test commands follow `docs/superpowers/documentation/TESTING.md`: when the dev stack is running, run in-container (`docker exec rsc-core sh -c "cd /app && npm test -w core -- <filter>"`, web with `env -u CORE_API_URL`); otherwise host commands as written below.

### Lockstep amendments to the V2 plan (pre-execution)

Both follow the established amendment mechanism (precedent: the V4 §10
CHECK-vocabulary pin amending V1's plan). Fold them into the V2 plan at the
cross-vertical review; this plan refuses execution without them.

1. **`reconciliation_jobs_v2` is created verification-ready.** Spec §4.1/§9:
   verification is a job *kind* on V2's reconciliation-job rows, and SQLite
   cannot relax `NOT NULL` after creation. V2's Appendix A DDL must create the
   table as pinned in this plan's Appendix A (nullable `run_id` /
   `observation_version_id`, `kind` + `verification_batch_key` columns, the
   two kind CHECKs). V2's code writes only `kind='observation'` rows and needs
   no behavior change.
2. **Interim last-subscription cleanup retains sources referenced by v2
   items** (spec, Open dependency 3): until V3's Task 7 lands, unsubscribing
   the last subscriber of a source whose deliveries support any logical item
   must retain the source (`sourceRemoved:false`). V2's plan currently defines
   no such rule; V1's Task 5 promised V2 would. One sentence + one test case
   in V2's cleanup coverage.

Verified present in V2's plan (no amendment needed): `remote_sources_v2.policy_generation`
(V2 Appendix A `ALTER TABLE` — spec Open dependency 1 resolved) and the wide
nine-value `source_audit_v2` CHECK (V1 plan rev 5 Task 1 — spec Open
dependency 2; the cross-vertical review re-verifies it landed). One open
identifier: V2's Appendix A names no `source_aliases_v2` table although its
Task 4 tests permanent-chain aliases — Task 6 below binds purge to "every
alias row of the purged source" by semantics, not identifier (spec §9), and
the cross-vertical review must pin the table name both plans share.

## File map and shared interfaces

Create focused modules; extend — never fork — the V2 store, projector, and
drain:

```text
core/src/logical/moderation.ts    hide/restore commands and item audit
core/src/logical/fanout.ts        generation-qualified hint fan-out batches
core/src/logical/verification.ts  check scheduling, batched fetch, outcomes, aliases
core/src/logical/tombstones.ts    purge, structural tombstones, cleanup effects, unblock
```

Modified: `core/src/logical/{schema,types,store,projector,reconcile,threading,local}.ts`,
`core/src/api/logical-routes.ts`, `core/src/domain/{types,source-service,source-repository}.ts`,
`core/src/storage/sqlite.ts`.

`core/src/domain/types.ts` re-adds the two deferred TS enum members (V1 rev 5
deferral; SQL CHECKs were created nine-wide and are untouched):

```ts
export type AuditCategory =
  | 'spam' | 'abuse' | 'illegal_content' | 'compromised_source'
  | 'operator_policy' | 'false_positive' | 'remediated' | 'other'
// 'migration_review' stays deferred to V4 with its first emitter.
```

`core/src/logical/types.ts` additions — later tasks use these names verbatim:

```ts
// widens V2's exact three-level enum — intentional supersession (spec §4.3);
// V2's ranking tests widen in Task 5, strongest first:
export type AttributionLevel =
  | 'verified_origin' | 'bound_single_publisher'
  | 'aggregate_assertion' | 'source_scoped_fallback'

export interface ItemAuditEvent {
  id:string; logicalItemId:string; commandId:string; actorId:string|null
  actorKind:'administrator'|'system'; action:string
  category:AuditCategory|null; note:string|null; resultJson:string; createdAt:string
}
export interface ModerationCommandInput {
  command:CommandEnvelope; logicalItemId:string
  category:AuditCategory; note:string|null; now:string
}
export type ItemModerationResult =
  | {kind:'applied'; logicalItemId:string; hiddenAt:string|null}
  | {kind:'unknown'|'local_origin'|'not_applicable'|'conflict'}
export interface PurgeCommandInput {command:CommandEnvelope; sourceId:string; category:AuditCategory; note:string|null; now:string}
export type PurgeResult =
  | {kind:'purged'; tombstoneId:string}
  | {kind:'unknown'|'not_blocked'|'conflict'}
export interface UnblockCommandInput {command:CommandEnvelope; tombstoneId:string; category:AuditCategory; note:string|null; now:string}
export type UnblockResult = {kind:'unblocked'} | {kind:'unknown'|'conflict'}

export interface FanoutClaim {sourceId:string; generation:number; lastItemCursor:string|null}
export type FanoutBatchResult = {kind:'progress'|'done'|'superseded'; processed:number}

// spec §7.3 verbatim; row field lists are plan-level (this plan fixes them):
export interface AdminItemDetail {
  model:'logical-v2'; logicalItemId:string; origin:'local'|'remote'
  state:'ordinary'|'hidden'|'unsupported'|'structural_tombstone'|'deleted_local'
  hiddenAt:string|null
  selected:{deliveryId:string|null; publisherId:string|null; attributionLevel:AttributionLevel|null}
  parentLogicalItemId:string|null; threadRootId:string|null
  counts:{deliveries:number; versions:number; claims:number; conflicts:number; audit:number}
  deliveries:AdminDeliveryRow[]; claims:AdminClaimRow[]; conflicts:AdminConflictRow[]
  verification:{state:'none'|'pending'|'verified'|'unverified'; attempts:number; lastCheckedAt:string|null}
}
export interface AdminVersionRow {observationVersionId:string; arrivalAt:string; wireOrdinal:number; fingerprint:string; rawEvidence:string}
export interface AdminDeliveryRow {deliveryId:string; sourceId:string; eligible:boolean; keyKind:string; key:string; firstSeenAt:string; versions:AdminVersionRow[]}
export interface AdminClaimRow {claimId:string; evidenceLevel:AttributionLevel; publisherId:string; firstSeenAt:string; observationVersionId:string; conflictIds:string[]}
export interface AdminConflictRow {conflictId:string; kind:string; disputed:string; logicalItemId:string|null; observationVersionId:string|null; createdAt:string}
export interface AdminSourceItemRow {logicalItemId:string; state:AdminItemDetail['state']; timelineSortAt:string; hiddenAt:string|null}
export interface TombstoneView {id:string; canonicalUrl:string; action:'block'|'purge'; category:AuditCategory; note:string|null; createdAt:string; aliases:string[]}
```

`createLogicalStore(db)`'s returned object gains exactly (implementations
live in the four new modules; the factory wires them):

```ts
hideItem(input:ModerationCommandInput):ItemModerationResult
restoreItem(input:ModerationCommandInput):ItemModerationResult
purgeSource(input:PurgeCommandInput):PurgeResult
unblockTombstone(input:UnblockCommandInput):UnblockResult
scheduleFanout(tx:WriteTx, input:{sourceId:string; generation:number; now:string}):void
claimFanout(now:string):FanoutClaim|null
processFanoutBatch(input:{claim:FanoutClaim; now:string}):FanoutBatchResult
scheduleVerification(tx:WriteTx, input:{logicalItemId:string; sourceId:string; publisherFeedUrl:string; now:string}):void
resolveVerificationBatch(input:ResolveVerificationInput):void
isTombstoned(url:string):boolean
removeSourceEvidence(tx:WriteTx, input:{sourceId:string; now:string}):{ordinaryAffected:boolean}
```

`ReconciliationClaim` widens to a discriminated union — an intentional
supersession of V2's single shape, dispatched by the one drain:

```ts
export type ReconciliationClaim =
  | {kind:'observation'; jobId:string; runId:string; observationVersionId:string}
  | {kind:'verification'; jobId:string; batchKey:string}
export interface ResolveVerificationInput {
  claim:{kind:'verification'; jobId:string; batchKey:string}
  outcome:
    | {kind:'fetched'; parsedItems:VerificationFeedItem[]; publisherRedirect:PermanentRedirectProof|null}
    | {kind:'operational_failure'; category:string; diagnostic:string|null}
  now:string
}
export interface VerificationFeedItem {normalizedPermalink:string|null; opaqueId:string|null; evidence:NewObservationVersion}
export interface PermanentRedirectProof {fromUrl:string; toUrl:string}
```

`LogicalReadTx` gains the review reads:

```ts
getAdminItemDetail(id:string):AdminItemDetail|undefined
listItemAudit(logicalItemId:string, cursor:{createdAt:string;id:string}|undefined, limit:number):AdminPage<ItemAuditEvent>
listSourceItems(sourceId:string, cursor:{timelineSortAt:string;logicalItemId:string}|undefined, limit:number):AdminPage<AdminSourceItemRow>
listTombstones():TombstoneView[]
```

Constants in the owning modules (plan-adjustable, spec §4.1/§7.3):

```ts
FANOUT_BATCH_SIZE = 100
VERIFICATION_MAX_NEW_PER_RESPONSE = 25
VERIFICATION_MAX_PENDING_PER_PUBLISHER = 50
VERIFICATION_MAX_PENDING_PER_SOURCE = 200
VERIFICATION_RESPONSE_REUSE_MS = 10 * 60 * 1000
ADMIN_SECTION_CAP = 100
```

Pinned command fingerprints and fixed bodies (spec §7.1, §1.1, §5.2; notes
are excluded from every fingerprint, category is included):

| Command | Fingerprint | Route |
|---|---|---|
| `hide` / `restore` | `[command, logicalItemId, actor, category]` | `POST /admin/items/:logicalItemId/{hide,restore}` |
| `purge` | `['purge', sourceId, actor, category]` | `POST /admin/sources/:sourceId/purge` |
| `tombstone-unblock` | `['tombstone-unblock', tombstoneId, actor, category]` | `POST /admin/tombstones/:tombstoneId/unblock` |

Fixed non-success bodies: `404 {"model":"logical-v2","error":"item unavailable"}`
(unknown item), `409 …"local origin"`, `409 …"not applicable"` (state
conflict), `409 …"source not blocked"`, `409 …"idempotency conflict"`,
`400 …"invalid cursor"`. The state-conflict bodies are distinct from the
idempotency body; an identical retry replays the stored ledger result even if
state has since changed.

---

### Task 1: V3 schema, re-added audit categories, and item-audit primitives

**Files:** Modify `core/src/logical/schema.ts`, `core/src/logical/types.ts`,
`core/src/domain/types.ts`, `core/src/storage/sqlite.ts`,
`core/src/logical/store.ts`; create `core/src/logical/moderation.ts`,
`core/test/logical-v3-schema.test.ts`.

**Interfaces:** Produces the Appendix A tables/columns, the widened
`AuditCategory` TS enum, `ItemAuditEvent`, `appendItemAudit(tx, event)` in
`moderation.ts`, and `LogicalReadTx.listItemAudit` (cursor-paginated exactly
like V1 source audit, via the shared `encodeCursor`/`decodeCursor`). No
command, worker, or route yet.

- [ ] **Step 1:** Add `logical-v3-schema.test.ts` asserting: the exact
  Appendix A tables and `logical_items_v2` columns exist after migration;
  `reconciliation_jobs_v2` accepts a `kind='verification'` row with null
  `run_id`/`observation_version_id` and rejects one with a null
  `verification_batch_key` (proves lockstep amendment 1 landed — refuse the
  task if this cannot pass without a table rebuild); an `item_audit_v2`
  insert with `category='false_positive'` and one with `'remediated'`
  succeed (the runtime trap spec §1.2 names) while a made-up category fails
  the CHECK; `source_audit_v2` is untouched (no rebuild: same `sql` text in
  `sqlite_master` before/after).
- [ ] **Step 2:** Add red audit-primitive tests: `appendItemAudit` inside a
  `db.write()` that throws rolls back with the item row (fault-injection per
  the V2 Appendix D pattern); `listItemAudit` pages newest-first over
  immutable `(createdAt, id)` tuples through the shared codec, default 50 /
  max 100, and the shared invalid-cursor table cases return null decode.
- [ ] **Step 3:** Run `npm test -w core -- logical-v3-schema`; expect FAIL.
- [ ] **Step 4:** Append ONE migration entry at the END of the
  `user_version`-indexed `MIGRATIONS` array (`core/src/storage/sqlite.ts:566`,
  applied ascending at `:706-709` — mid-array insertion renumbers applied
  migrations) calling `installLogicalV3Schema(raw)` in `schema.ts` with the
  exact Appendix A DDL. Widen the TS enum, add the types-block additions this
  task owns, implement the audit primitives.
- [ ] **Step 5:** Run `npm test -w core -- logical-v3-schema && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 2: Hidden moderation — hide/restore commands, the one predicate, journal effects

**Files:** Modify `core/src/logical/moderation.ts`,
`core/src/logical/projector.ts`, `core/src/logical/store.ts`,
`core/src/logical/types.ts`; create `core/test/logical-moderation.test.ts`.

**Interfaces:** Produces `hideItem`/`restoreItem` (each one ledger-backed
`BEGIN IMMEDIATE` committing state change + one item-audit record + inline
hint recompute + the §6 journal effect atomically) and the hidden predicate
in the central projector. Domain-level only; routes arrive in Task 8.

- [ ] **Step 1:** Add red command tests: hide sets `hidden_at`, appends one
  audit row (actor kind `administrator`, required category, optional note)
  and — only when the item was ordinarily visible — that item's journal
  `remove`; hide of an already-ordinarily-absent item appends no journal
  record; restore clears `hidden_at` only and appends the item's `upsert`
  only when an eligible delivery currently exists (never publishes
  previously ineligible evidence — hand-seed a hidden item whose only
  delivery is quarantined and assert restore yields no upsert and no
  visibility); local-origin → `{kind:'local_origin'}`; unknown →
  `{kind:'unknown'}`; hide-on-hidden / restore-on-visible →
  `{kind:'not_applicable'}`; identical command retry replays the stored
  result; each fingerprint input varied (`command`, `logicalItemId`,
  `actor`, `category`) → `{kind:'conflict'}`; a changed note alone replays.
- [ ] **Step 2:** Add red surface tests reusing the V2 projection/SSE
  helpers: hidden is absent from every lens, publisher view, and feed
  branch; single-item and history routes' projections return undefined
  (neutral ordinary 404 at the route layer); a hidden node with visible
  descendants projects the existing `placeholderKind:'unavailable'` (no new
  kind), a hidden leaf is absent, empty branches prune; SSE send-time
  projection converts a now-hidden historical upsert to an effective remove
  (V2 §5.4 machinery, no new code); hide/restore of a resolved reply rides
  its journal frame with the V2 `ReplyCountOverlay` (root ID + authoritative
  count from the send-time snapshot — V2 §5.5 verbatim); poll/edit/replay of
  a hidden item keeps it hidden across redelivery and new versions.
- [ ] **Step 3:** Run `npm test -w core -- logical-moderation`; expect FAIL.
- [ ] **Step 4:** Implement: add `hidden_at IS NULL` (and
  `structural_tombstone = 0`, consumed by Task 6) to the ONE
  ordinary-visibility predicate in `projector.ts` — no surface-local checks
  anywhere; implement both commands over the V1 ledger helper
  (`checkCommand`/`storeCommand`) with inline single-item hint recompute
  through the shared comparator.
- [ ] **Step 5:** Run `npm test -w core -- logical-moderation logical-projector logical-sse && npm run typecheck -w core`; expect PASS (the two V2 suites prove no ordinary regression). Commit per Appendix C.

### Task 3: Policy fan-out on the reconciliation drain

**Files:** Create `core/src/logical/fanout.ts`,
`core/test/logical-fanout.test.ts`; modify `core/src/logical/store.ts`,
`core/src/logical/reconcile.ts`, `core/src/domain/source-repository.ts`.

**Interfaces:** Produces `scheduleFanout`/`claimFanout`/`processFanoutBatch`
and wires the generation-advancing V1 transitions (governance, federation,
attribution mode — the V2 Appendix B rows that advance `policy_generation`)
to upsert the source's `policy_fanout_v2` row inside their existing
transaction. The V2 drain processes fan-out rows after each transition
commit and once at startup — no second loop.

- [ ] **Step 1:** Add red tests: a transition upserts `{generation, cursor:
  null, state:'pending'}` in the same transaction as its reset (fault
  injection rolls back both); a newer transition overwrites the row and a
  running batch whose stored source generation no longer matches marks the
  row `superseded` and writes nothing (rapid `quarantined -> allowed ->
  blocked` leaves only current-generation hint writes); batches process 100
  items per transaction in ascending logical-item ID over items holding any
  delivery from the source, recompute hints through the shared comparator
  only, and persist the cursor; restart resumes from the durable cursor
  mid-fan-out; fan-out appends NO journal records and touches no
  visibility/audit; pause/resume schedules no fan-out.
- [ ] **Step 2:** Run `npm test -w core -- logical-fanout`; expect FAIL.
- [ ] **Step 3:** Implement `fanout.ts` and the drain hook in `reconcile.ts`
  (`ponytail: one drain in the one Core process; leases/fences only if work
  ever leaves the process`). Bounded single-item mutations (hide, restore,
  verification success, purge reselection) never enqueue fan-out.
- [ ] **Step 4:** Run `npm test -w core -- logical-fanout logical-policy-events && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 4: Verification scheduling, caps, and the drain job kind

**Files:** Create `core/src/logical/verification.ts`,
`core/test/logical-verification.test.ts`; modify `core/src/logical/store.ts`,
`core/src/logical/reconcile.ts`, `core/src/logical/types.ts`.

**Interfaces:** Produces `scheduleVerification` (called from V2
reconciliation when a valid publisher URL is first seen in an aggregate
claim), the widened `ReconciliationClaim` union, the verification job rows
(`kind='verification'`, batch key = normalized publisher feed URL), and the
bounded batched fetch. Outcome handling arrives in Task 5.

- [ ] **Step 1:** Add red scheduling tests: reconciling an aggregate claim
  with a previously unseen valid publisher URL creates one
  `verification_checks_v2` row per (logical item, publisher URL) in state
  `pending` plus at most one active drain job per batch key (dedup is an
  app-level check inside the write transaction — single process); the caps
  hold exactly — at most 25 previously unseen publisher URLs per aggregate
  response (the rest dropped as bounded evidence), 50 pending per publisher
  URL, 200 per source; a URL failing normalization/SSRF creates nothing;
  re-seeing a known URL creates nothing.
- [ ] **Step 2:** Add red drain/fetch tests: the one drain claims
  verification jobs in the same `(nextAttemptAt ASC, jobId ASC)` order as
  observation jobs and dispatches on `claim.kind`; one bounded fetch (the V2
  §1.5 profile reused from `acquisition.ts` — 10 s deadline, five
  redirects, 5 MiB cap, SSRF/governance on every hop) serves ALL pending
  checks for that publisher URL; a response fetched within the last 10
  minutes serves newly queued checks without refetching (in-memory,
  `ponytail: in-process response cache; persist it only if verification ever
  outlives the process`); paused, blocked, and tombstoned targets are never
  fetched.
- [ ] **Step 3:** Run `npm test -w core -- logical-verification`; expect FAIL.
- [ ] **Step 4:** Implement scheduling, the union widening (V2's drain code
  path keeps `kind:'observation'` untouched), and the batched fetch. Attempt
  counts and next-attempt times live ONLY on the job rows.
- [ ] **Step 5:** Run `npm test -w core -- logical-verification logical-reconcile && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 5: Verification outcomes, the verified rung, and publisher aliases

**Files:** Modify `core/src/logical/verification.ts`,
`core/src/logical/projector.ts`, `core/src/logical/store.ts`,
`core/src/logical/types.ts`, `core/test/logical-verification.test.ts`,
`core/test/logical-presentation.test.ts`.

**Interfaces:** Produces `resolveVerificationBatch`, the four-level
comparator, and `publisher_feed_aliases_v2` writes. Widening V2's exact
three-level enum and its ranking tests is the intentional supersession spec
§4.3 states.

- [ ] **Step 1:** Add red outcome tests: containment matches ONLY by exact
  normalized permalink or resolved publisher + exact explicit opaque ID;
  match → check `verified`, a direct-origin delivery and its evidence
  persisted under a find-or-created source (`provenance:
  'origin_verification'`, `single_publisher + enabled + federation none`,
  governance inherited from the asserting source), one system-actor
  item-audit entry, inline hint recompute, and the item's journal `upsert`
  only when ordinary selection/author/classification changed; successful
  fetch with no match → terminal `unverified`, never contradicted, no
  retry; operational failure → the shared drain backoff, eight-attempt
  exhaustion → `unverified`; verification changes no
  governance/federation/subscription/moderation/ancestry and a hidden item
  stays hidden through verification success.
- [ ] **Step 2:** Add red ranking tests (widening the V2 suites in place):
  comparator order `verified_origin > bound_single_publisher >
  aggregate_assertion > source_scoped_fallback`, strongest-first so the
  addition is purely additive; a verified delivery participates in ordinary
  comparators only while its source is ordinary-eligible — quarantined
  verified evidence is in NEITHER ordinary comparator (administrator-visible
  only), the V2 §3.2 single rule.
- [ ] **Step 3:** Add red alias tests: a verified direct-origin publisher
  redirect with the V2 §1.6 permanent-chain proof writes one
  `publisher_feed_aliases_v2` row (URL → publisher); an aggregate redirect
  never merges publishers; an alias collision records a conflict row and
  merges nothing.
- [ ] **Step 4:** Run `npm test -w core -- logical-verification logical-presentation`; expect FAIL.
- [ ] **Step 5:** Implement outcomes, the rung, and aliases. Run
  `npm test -w core -- logical-verification logical-presentation logical-projector && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 6: Purge and structural tombstones

**Files:** Create `core/src/logical/tombstones.ts`,
`core/test/logical-purge.test.ts`; modify `core/src/logical/store.ts`,
`core/src/logical/reconcile.ts`, `core/src/logical/threading.ts`,
`core/src/logical/local.ts`, `core/src/logical/projector.ts`.

**Interfaces:** Produces `purgeSource`, the shared `removeSourceEvidence`
step-4 helper (reused verbatim by Task 7's cleanup), the
structural-tombstone terminal state, and its descendant-deletion sweep.

- [ ] **Step 1:** Add red purge tests: purge of a non-blocked source →
  `{kind:'not_blocked'}` (route: `409 …"source not blocked"`); unknown →
  `{kind:'unknown'}`; fingerprint `['purge', sourceId, actor, category]`
  replay/conflict per the shared matrix. A successful purge is ONE
  transaction (`ponytail: one transaction, no chunked purge; a single-user
  instance's worst source fits comfortably in one SQLite write transaction`)
  committing atomically: the tombstone row (canonical URL, terminal
  block+purge facts) plus one tombstone-alias row per alias of the purged
  source; deletion of the source's deliveries, observation versions, claims
  of those deliveries, verification checks, redirect evidence, validators,
  runs/jobs, and fan-out rows; deletion of the source row with its cascades;
  per affected logical item — reselect hints when other deliveries remain,
  delete when unsupported and unreferenced, convert to structural tombstone
  when a surviving descendant references it, delete fully unreferenced
  publishers; exactly ONE journal `reset` and the ledger result. Fault
  injection before the ledger write rolls back everything including the
  tombstone.
- [ ] **Step 2:** Add red structural-tombstone tests: the converted row
  retains only logical ID, parent/root edges, and the immutable sort key —
  content, author, source, publisher, and evidence gone; it serializes only
  through `placeholderKind:'unavailable'`; it is not a valid reply or
  adoption target and offers no reply/edit/feed/source action; it is swept
  when deletion of its last referencing descendant finds no remaining child
  edge (`ponytail: swept at descendant-deletion time only; no background
  reaper`) — exercised through local delete and through purge itself;
  reconciliation treats an arriving delivery for a structural tombstone as
  administrator-only evidence and never resurrects it; it stays distinct
  from `deleted_local` (which keeps its permalink anchor and is never
  swept — assert both behaviors side by side); exact thread edges survive
  restart.
- [ ] **Step 3:** Run `npm test -w core -- logical-purge`; expect FAIL.
- [ ] **Step 4:** Implement `tombstones.ts` (tombstone + alias writes,
  `removeSourceEvidence`, sweep hook called from the existing
  descendant-deletion paths in `local.ts`/`threading.ts`) and the
  reconciliation guard. The single reset is the uniform barrier — block
  already made this evidence ineligible, so purge changes no ordinary
  visibility.
- [ ] **Step 5:** Run `npm test -w core -- logical-purge logical-local logical-threading && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 7: Tombstone resolution, unblock, and last-subscription cleanup

**Files:** Modify `core/src/logical/tombstones.ts`,
`core/src/domain/source-service.ts`, `core/src/domain/source-repository.ts`,
`core/src/logical/acquisition.ts`, `core/src/logical/verification.ts`,
`core/test/source-cleanup.test.ts`; create
`core/test/logical-tombstones.test.ts`.

**Interfaces:** Produces `isTombstoned`, the resolution branches (V1's
permanently-empty-table branches become live), `unblockTombstone`, and the
cleanup item effects V1 deferred here.

- [ ] **Step 1:** Add red resolution tests: subscribe, OPML import,
  federation establishment, and every redirect hop in acquisition and
  verification check tombstones AND tombstone aliases and return the
  existing generic unavailable result — same body as today's unavailable, no
  oracle distinguishing a tombstoned URL.
- [ ] **Step 2:** Add red unblock tests: unblock deletes the tombstone and
  its alias rows, creates NO source, and the next resolution of that URL is
  an ordinary fresh creation; requires a category (`remediated` is its first
  emitter — carried in the ledger row's `result_json` with action, note,
  and tombstone identity; assert NO `item_audit_v2`/`source_audit_v2` row is
  written: `ponytail: the ledger row is the audit; a standalone FK-less
  audit table adds nothing`); fingerprint
  `['tombstone-unblock', tombstoneId, actor, category]` replay/conflict.
- [ ] **Step 3:** Add red cleanup tests extending `source-cleanup.test.ts`:
  removing an allowed self-service source (no subscription, federation,
  retention reason) applies the same `removeSourceEvidence` step-4 rules —
  shared items reselect, unsupported items delete, descendant-referenced
  items become structural tombstones, unreferenced publishers delete — but
  writes NO block tombstone and appends one `reset` only when any ordinary
  item was affected (zero-effect cleanup appends nothing); a source whose
  deliveries are current verification evidence for any logical item is never
  removed (hand-seeded — such sources have no subscriptions, the condition
  is the guard), replacing V2's interim retained-if-referenced rule and
  V1's deferred `provenance = 'origin_verification'` branch.
- [ ] **Step 4:** Run `npm test -w core -- logical-tombstones source-cleanup`; expect FAIL. Implement.
- [ ] **Step 5:** Run `npm test -w core -- logical-tombstones source-cleanup source-subscribe opml source-federation && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 8: Administrative review APIs

**Files:** Modify `core/src/api/logical-routes.ts`,
`core/src/logical/store.ts`, `core/src/logical/types.ts`; create
`core/test/logical-review-api.test.ts`.

**Interfaces:** Invoke `.claude/skills/hono/SKILL.md` first. Produces the
four mutation routes and four reads from the shared-interfaces table, all
under the house `app.use('/admin/*', authed, requireAdmin())` composition,
every envelope carrying `model:'logical-v2'`.

- [ ] **Step 1:** Add red route tests: every mutation route composes
  `jsonWrite` positionally and accepts `commandId` only as the JSON body
  field; disposition mapping — `applied` 200, `unknown` the neutral 404,
  `local_origin`/`not_applicable`/`not_blocked` their fixed 409 bodies,
  ledger conflict the fixed idempotency 409, replay the stored 200 body;
  one mutation, one audit record, and one journal effect per command
  (assert counts across a retry).
- [ ] **Step 2:** Add red detail/read tests: `GET /admin/items/:id` returns
  `AdminItemDetail` with bounded inline sections capped at
  `ADMIN_SECTION_CAP` newest-first and TRUE totals in `counts` (seed 101
  deliveries → 100 rows, `counts.deliveries === 101`; `ponytail: inline
  caps, no cursors; paginate a section only when a real item ever exceeds
  100`); rows expose bounded normalized fields plus raw evidence as bounded
  escaped text under the V2 §1.5 digest rules — no secrets, no unbounded
  blobs, no rendered HTML from Core; `state` covers all five values
  (including `deleted_local` and `structural_tombstone`);
  `verification.attempts` reads from job rows. `GET /admin/items/:id/audit`
  and `GET /admin/sources/:id/items` paginate via the shared codec + the
  shared invalid-cursor table (`400 …"invalid cursor"`); `GET
  /admin/tombstones` lists `TombstoneView[]` unpaginated (spec: only audit
  and source→items page). `AdminSourceAcquisitionSummary` gains
  `conflictCount` (no `push` field — V4's).
- [ ] **Step 3:** Add the authz/redaction matrix: for EVERY new route,
  `[unauthenticated, anonymous, registered, administrator]` →
  `[401, 403, 403, 200]`; a request bearing only `Authorization: Bearer
  <RSC_TOKEN>` has no better-auth session → **401** from `sessionAuth`
  (`core/src/api/auth.ts:64-66`) before `requireAdmin`'s 403
  (`core/src/api/auth.ts:82`) is reachable; no auth material in any list,
  detail, error, ledger-replay, or audit body. Use the
  `registeredSession`/`anonSession` cookie fixtures
  (`core/test/auth-helper.ts`, pattern per `core/test/admin.test.ts`).
- [ ] **Step 4:** Run `npm test -w core -- logical-review-api`; expect FAIL.
  Implement routes and the `LogicalReadTx` review reads; hand-rolled
  validators, `c.json({error}, status)`, no `HTTPException`.
- [ ] **Step 5:** Run `npm test -w core -- logical-review-api logical-admin-api && npm run typecheck -w core`; expect PASS. Commit per Appendix C.

### Task 9: Web review surfaces

**Files:** Create `web/src/routes/admin/items/[id]/+page.server.ts`,
`web/src/routes/admin/items/[id]/+page.svelte`,
`web/src/routes/admin/items/[id]/item-review.test.ts`; modify
`web/src/lib/logical-api.ts`, `web/src/lib/logical-types.ts`,
`web/src/routes/admin/sources/[sourceId]/+page.server.ts`,
`web/src/routes/admin/sources/[sourceId]/+page.svelte`,
`web/src/routes/admin/sources/[sourceId]/source-detail.test.ts`,
`web/src/routes/admin/feeds/+page.server.ts`,
`web/src/routes/admin/feeds/+page.svelte`,
`web/src/routes/admin/feeds/source-actions.test.ts`.

**Interfaces:** Invoke the repository UI/Svelte skills first; follow
`design-system/rsc/MASTER.md`. All pages SSR/no-JS-capable with
server-generated command IDs retained across ambiguous retry (the V2
admin-form convention). No ordinary page changes anywhere.

- [ ] **Step 1:** Add red item-review tests: the page loads
  `AdminItemDetail` + first audit page; hide and restore forms post
  category (required `<select>` over the eight TS enum values), optional
  note, and the retained command ID; raw evidence renders as escaped text;
  any content preview goes through `web/src/lib/server/render.ts` only —
  assert no second sanitize path; bounded sections render their cap with
  the true totals visible.
- [ ] **Step 2:** Add red source/tombstone tests: source detail shows
  `conflictCount` and an items link (`/admin/items/…` navigation from
  `GET /admin/sources/:id/items`); blocked sources alone show the purge
  form, whose confirmation states purge's distinct consequence (evidence
  permanently deleted, URL stays blocked by tombstone); the admin sources
  page gains the reserved blocked/tombstoned group listing canonical URL +
  terminal facts with an unblock form whose confirmation states the other
  consequence (URL becomes creatable again, nothing is restored); no
  evidence-review link renders for non-admin/off states.
- [ ] **Step 3:** Run `npm test -w web -- item-review source-detail source-actions`; expect FAIL.
- [ ] **Step 4:** Implement loaders, actions, and markup — tokenized colors
  only, 42rem editorial layout, native forms. Hidden items need no ordinary
  page work: the projector-backed loads and V2 §5.7 stream handling already
  drop them.
- [ ] **Step 5:** Run `npm test -w web && npm run check -w web && npm run build -w web`; expect PASS. Commit per Appendix C.

### Task 10: Cross-model isolation, mandatory scenarios, and the vertical gate

**Files:** Create `core/test/logical-v3-vertical.test.ts`.

**Interfaces:** Proves spec §10 and §11 end to end. Passing does NOT
authorize enabling v2 by default or beginning Vertical 4.

- [ ] **Step 1:** Add the foundation's mandatory moderation scenario as one
  integration test: hide an item from an approved aggregate peer; verify
  absence from rivers, profiles, history, feeds, and live/replay state plus
  the neutral thread placeholder; poll, edit, restart, replay, and
  origin-verify it hidden; restore and verify eligible reselection. Add the
  shared-delivery variant: quarantine one approved source while an allowed
  source keeps the item public — it leaves Federated, reselects, and hint
  convergence follows via fan-out.
- [ ] **Step 2:** Add the mandatory purge scenario: purge a blocked source
  sharing an item with another remote source and converged on a local item;
  local origin and other eligible deliveries survive; unsupported items
  delete; ancestors of visible descendants become structural tombstones
  preserving exact thread edges across restart; the tombstone URL and its
  aliases block direct subscription and every redirect hop; terminal audit
  facts and the reset survive restart. Repeat the structural-tombstone
  assertions through last-subscription cleanup.
- [ ] **Step 3:** Add isolation tests: with v2 OFF, no V3 route exists (404),
  no fan-out or verification work is ever scheduled, and legacy moderation
  and legacy push behavior are byte-identical (reuse V2's off-flag
  regression fixtures); with v2 ON, the capability payload is UNCHANGED —
  V3 adds no field and ordinary contracts are untouched (exact-equality
  against V2's enabled shape).
- [ ] **Step 4:** Run `npm test -w core -- logical-v3-vertical`; expect FAIL, then wire nothing new — fix only what the scenarios expose.
- [ ] **Step 5:** Run the completion gate (V2 §7.5 unchanged): `npm test -w core`, `npm run typecheck -w core`, `npm test -w web`, `npm run check -w web`, `npm run build -w web`; all exit 0. Run `/ponytail-review` on the branch diff, commit per Appendix C, and stop for the whole-vertical review.

## Appendix A: exact migration inventory

Task 1 appends ONE entry at the tail of `MIGRATIONS`
(`core/src/storage/sqlite.ts:566`) calling `installLogicalV3Schema(raw)`.
Timestamps are normalized UTC `TEXT`; FKs default `ON DELETE RESTRICT`.
`source_audit_v2` is untouched.

```text
ALTER TABLE logical_items_v2 ADD COLUMN hidden_at TEXT
ALTER TABLE logical_items_v2 ADD COLUMN structural_tombstone INTEGER NOT NULL DEFAULT 0 CHECK(structural_tombstone IN(0,1))
item_audit_v2(id TEXT PRIMARY KEY,logical_item_id TEXT NOT NULL REFERENCES logical_items_v2(id),command_id TEXT NOT NULL,actor_id TEXT,actor_kind TEXT NOT NULL CHECK(actor_kind IN('administrator','system')),action TEXT NOT NULL,category TEXT CHECK(category IS NULL OR category IN('spam','abuse','illegal_content','compromised_source','migration_review','operator_policy','false_positive','remediated','other')),note TEXT,result_json TEXT NOT NULL,created_at TEXT NOT NULL)
policy_fanout_v2(source_id TEXT PRIMARY KEY REFERENCES remote_sources_v2(id),generation INTEGER NOT NULL,last_item_cursor TEXT,state TEXT NOT NULL CHECK(state IN('pending','running','done','superseded')),updated_at TEXT NOT NULL)
verification_checks_v2(id TEXT PRIMARY KEY,logical_item_id TEXT NOT NULL REFERENCES logical_items_v2(id),source_id TEXT NOT NULL REFERENCES remote_sources_v2(id),publisher_feed_url TEXT NOT NULL,batch_key TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','verified','unverified')),created_at TEXT NOT NULL,resolved_at TEXT,UNIQUE(logical_item_id,publisher_feed_url))
publisher_feed_aliases_v2(url TEXT PRIMARY KEY,publisher_id TEXT NOT NULL REFERENCES remote_publishers_v2(id),created_at TEXT NOT NULL)
blocked_source_tombstones_v2(id TEXT PRIMARY KEY,canonical_url TEXT NOT NULL UNIQUE,action TEXT NOT NULL CHECK(action IN('block','purge')),category TEXT NOT NULL CHECK(category IN('spam','abuse','illegal_content','compromised_source','migration_review','operator_policy','false_positive','remediated','other')),actor_id TEXT,note TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)
tombstone_aliases_v2(url TEXT PRIMARY KEY,tombstone_id TEXT NOT NULL REFERENCES blocked_source_tombstones_v2(id) ON DELETE CASCADE,created_at TEXT NOT NULL)
CREATE INDEX item_audit_v2_page ON item_audit_v2(logical_item_id,created_at DESC,id DESC)
```

`item_audit_v2` defines its OWN nine-value CHECK (spec §1.2 + the wide-CHECK
pin) — never a mirror of the narrowed TS enum; a six-value mirror would fail
restore at runtime. The V1 rev-5 deferral removed the reviewed
`blocked_source_tombstones_v2` DDL from the live plan text, so the DDL above
IS the binding form of the spec's column description (canonical URL, terminal
block|purge action, category, actor, note, timestamps); the spec binds columns
and semantics, not identifiers. Only the audit page index ships
(`ponytail: source→items pagination rides the existing timeline index via a
deliveries join; add a composite only when it measurably slows`).

**Lockstep amendment 1 (created by V2, pinned here):**

```text
reconciliation_jobs_v2(id TEXT PRIMARY KEY,
 kind TEXT NOT NULL DEFAULT 'observation' CHECK(kind IN('observation','verification')),
 run_id TEXT REFERENCES acquisition_runs_v2(id),
 observation_version_id TEXT UNIQUE REFERENCES observation_versions_v2(id),
 verification_batch_key TEXT,
 status TEXT NOT NULL CHECK(status IN('pending','processing','retrying','reconciled','conflicted','failed')),
 attempts INTEGER NOT NULL,next_attempt_at TEXT NOT NULL,
 failure_category TEXT,diagnostic TEXT,created_at TEXT NOT NULL,
 CHECK((kind='observation') = (observation_version_id IS NOT NULL AND run_id IS NOT NULL)),
 CHECK((kind='verification') = (verification_batch_key IS NOT NULL)))
```

For verification jobs the terminal statuses map: `reconciled` = batch
resolved, `failed` = exhaustion (which also writes `unverified` on the
checks). SQLite UNIQUE admits multiple NULL `observation_version_id` rows.

## Appendix B: exact V1/V2 integration points

V3 modifies only these existing seams; everything else is additive:

```text
projector.ts single visibility predicate     + hidden_at IS NULL AND structural_tombstone = 0 (Task 2)
source-repository.ts generation-advancing    upsert policy_fanout_v2 row in the same
  transitions + establishFederation           transaction as their reset (Task 3)
reconcile.ts drain loop                      fan-out processing after commit + at startup;
                                              claim dispatch on ReconciliationClaim.kind (Tasks 3-5)
reconcile.ts aggregate-claim path            scheduleVerification on first-seen publisher URL (Task 4)
projector.ts comparator                      verified_origin prepended, strongest-first (Task 5)
local.ts / threading.ts descendant deletion  structural-tombstone sweep hook (Task 6)
reconcile.ts arrival guard                   structural-tombstone deliveries are admin-only,
                                              never resurrect (Task 6)
source-service.ts subscribe/OPML/federation  isTombstoned branch → generic unavailable (Task 7)
acquisition.ts + verification.ts hops        isTombstoned on every redirect hop (Task 7)
source-repository.ts unsubscribe cleanup     removeSourceEvidence + verification-evidence
                                              retention condition (Task 7)
logical-routes.ts + AdminSourceAcquisition-  V3 admin routes; conflictCount (Task 8)
  Summary
```

Fault-injection tests for every V3 command follow the V2 Appendix D pattern:
throw immediately before audit, journal, ledger, and commit; assert all
affected table families unchanged.

## Appendix C: mandatory per-task commands and commits

A task is not complete until its row passes exactly. Red = same command
before implementation failing on the named absent symbol/behavior; green =
exit 0 after.

| Task | Red/green command | Explicit staged paths | Commit subject |
|---|---|---|---|
| 1 | `npm test -w core -- logical-v3-schema && npm run typecheck -w core` | `core/src/logical/schema.ts core/src/logical/types.ts core/src/logical/moderation.ts core/src/logical/store.ts core/src/domain/types.ts core/src/storage/sqlite.ts core/test/logical-v3-schema.test.ts` | `core: add logical v3 moderation schema and item audit` |
| 2 | `npm test -w core -- logical-moderation logical-projector logical-sse && npm run typecheck -w core` | `core/src/logical/moderation.ts core/src/logical/projector.ts core/src/logical/store.ts core/src/logical/types.ts core/test/logical-moderation.test.ts` | `core: hide and restore logical items` |
| 3 | `npm test -w core -- logical-fanout logical-policy-events && npm run typecheck -w core` | `core/src/logical/fanout.ts core/src/logical/store.ts core/src/logical/reconcile.ts core/src/domain/source-repository.ts core/test/logical-fanout.test.ts` | `core: converge hints with policy fan-out` |
| 4 | `npm test -w core -- logical-verification logical-reconcile && npm run typecheck -w core` | `core/src/logical/verification.ts core/src/logical/store.ts core/src/logical/reconcile.ts core/src/logical/types.ts core/test/logical-verification.test.ts` | `core: schedule bounded origin verification` |
| 5 | `npm test -w core -- logical-verification logical-presentation logical-projector && npm run typecheck -w core` | `core/src/logical/verification.ts core/src/logical/projector.ts core/src/logical/store.ts core/src/logical/types.ts core/test/logical-verification.test.ts core/test/logical-presentation.test.ts` | `core: verify origins and rank verified evidence` |
| 6 | `npm test -w core -- logical-purge logical-local logical-threading && npm run typecheck -w core` | `core/src/logical/tombstones.ts core/src/logical/store.ts core/src/logical/reconcile.ts core/src/logical/threading.ts core/src/logical/local.ts core/src/logical/projector.ts core/test/logical-purge.test.ts` | `core: purge blocked sources into tombstones` |
| 7 | `npm test -w core -- logical-tombstones source-cleanup source-subscribe opml source-federation && npm run typecheck -w core` | `core/src/logical/tombstones.ts core/src/domain/source-service.ts core/src/domain/source-repository.ts core/src/logical/acquisition.ts core/src/logical/verification.ts core/test/logical-tombstones.test.ts core/test/source-cleanup.test.ts` | `core: resolve tombstones and extend cleanup` |
| 8 | `npm test -w core -- logical-review-api logical-admin-api && npm run typecheck -w core` | `core/src/api/logical-routes.ts core/src/logical/store.ts core/src/logical/types.ts core/test/logical-review-api.test.ts` | `core: expose logical v3 review APIs` |
| 9 | `npm test -w web && npm run check -w web && npm run build -w web` | `web/src/routes/admin/items/[id]/+page.server.ts web/src/routes/admin/items/[id]/+page.svelte web/src/routes/admin/items/[id]/item-review.test.ts web/src/lib/logical-api.ts web/src/lib/logical-types.ts web/src/routes/admin/sources/[sourceId]/+page.server.ts web/src/routes/admin/sources/[sourceId]/+page.svelte web/src/routes/admin/sources/[sourceId]/source-detail.test.ts web/src/routes/admin/feeds/+page.server.ts web/src/routes/admin/feeds/+page.svelte web/src/routes/admin/feeds/source-actions.test.ts` | `web: render moderation review surfaces` |
| 10 | full completion gate in Task 10 | `core/test/logical-v3-vertical.test.ts` | `test: complete logical v3 vertical` |

Every subject is committed with this exact final paragraph:

```text
developed with the help of AI tools
```

## Appendix D: representative executable tests

Use these exact assertions in the named red suites; expand table cases
without changing the contracts:

```ts
// core/test/logical-moderation.test.ts — command matrix over the ledger
const hide = (id:string, commandId:string, category:AuditCategory='spam') =>
  store.hideItem({command: env(commandId, fp(['hide', id, admin.id, category])),
    logicalItemId: id, category, note: null, now: NOW})
expect(hide('item-1', 'c1')).toMatchObject({kind:'applied', hiddenAt: NOW})
expect(hide('item-1', 'c1')).toEqual(first)                    // identical retry replays
expect(hide('item-1', 'c2')).toEqual({kind:'not_applicable'})  // already hidden — distinct 409 body
expect(hide('item-1', 'c1', 'abuse')).toEqual({kind:'conflict'}) // changed category, reused ID
expect(hide(localItem, 'c3')).toEqual({kind:'local_origin'})
expect(journalKindsFor('item-1')).toEqual(['remove'])          // visible→hidden: one remove, once

// core/test/logical-purge.test.ts — atomicity incl. the tombstone
expect(() => db.write((tx) => {
  runPurgeSteps(tx, blockedSource, NOW)
  throw new Error('fault-before-ledger')
})).toThrow('fault-before-ledger')
expect(count(raw, 'blocked_source_tombstones_v2')).toBe(0)
expect(count(raw, 'logical_journal_v2')).toBe(preCount)

// core/test/logical-fanout.test.ts — stale batches never write
transition(tx, src, 'quarantine'); transition(tx, src, 'allow'); transition(tx, src, 'block')
const claim = store.claimFanout(NOW)!
expect(store.processFanoutBatch({claim: {...claim, generation: claim.generation - 1}, now: NOW}))
  .toEqual({kind:'superseded', processed: 0})

// core/test/logical-presentation.test.ts — four-level ranking (supersession)
expect(rankAttribution(['aggregate_assertion','verified_origin','bound_single_publisher']))
  .toBe('verified_origin')

// core/test/logical-review-api.test.ts — cookie fixture per admin.test.ts
const cookie = await registeredSession(adminApp, 'boss@x.test', repo)
const res = await adminApp.request('/admin/items/li-1/hide', {
  method:'POST', headers:{'content-type':'application/json', cookie},
  body:'{"commandId":"c1","category":"spam"}'
})
expect(await res.json()).toMatchObject({model:'logical-v2'})
const bearer = await adminApp.request('/admin/items/li-1/hide', {
  method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${RSC_TOKEN}`},
  body:'{"commandId":"c2","category":"spam"}'
})
expect(bearer.status).toBe(401) // sessionAuth 401 before requireAdmin — core/src/api/auth.ts:64-66

// core/test/logical-tombstones.test.ts — resolution is oracle-free
const tombstoned = await service.subscribeByUrl(owner, purgedAliasUrl, 'sub-1')
expect(tombstoned).toEqual({kind:'unavailable'}) // byte-identical to the ordinary unavailable result
```

Every mutation fault test repeats the purge pattern with throws immediately
before audit, journal, ledger, and commit. Every HTTP test uses Hono
`app.request`.
