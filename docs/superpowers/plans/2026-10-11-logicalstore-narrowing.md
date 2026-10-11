# `LogicalStore` Narrowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every consumer of the 52-member `LogicalStore` is typed against exactly the members it calls, and the 7 store wrappers nothing calls are deleted.

**Architecture:** Spec `docs/superpowers/specs/2026-10-11-logicalstore-narrowing-design.md` (**rev 2**). Each consumer declares a `Pick<LogicalStore, …>` alias beside itself and types its parameter with it (types only, zero runtime change). Then the dead wrappers and the imports they orphan go. `createLogicalStore` is not split.

**Tech Stack:** TypeScript on Node 22+ native type stripping (no build; no TS parameter properties in `core/src`), vitest.

## Global Constraints

- **Task 1 is types only.** No statement that runs changes. The core suite stays at **1218 passed**.
- **Task 2 deletes only the 7 store wrapper methods.** The same-named free functions in `acquisition.ts`, `verification.ts`, `threading.ts`, `tombstones.ts` and `fanout.ts` stay. `deleteLocalPost` and `getHealth` stay.
- **These stay typed `LogicalStore`:** `store.ts`, `logical/runtime.ts`, `server.ts`, `LogicalRouteDeps` in `write.ts`, and `domain/repository-contract.ts`, which is a test harness.
- **tsconfig has no `noUnusedLocals`.** Remove every import a change orphans by hand, and grep to confirm it's gone.
- **All gates run in the containers.** The dev stack must be up, and host `node_modules` is stale.
  - Core typecheck: `docker compose exec -T core npm run typecheck -w core`
  - Core tests: `docker compose exec -T core npm test -w core`
- **Git:** shared checkout. Stage explicit paths only. Commit messages carry no attribution trailer.

## File Structure

| File | Change | Task |
|---|---|---|
| `core/src/logical/store.ts` | add `LogicalReader`; delete 7 wrappers and their orphaned imports and comments | 1, 2 |
| `core/src/domain/service.ts` | `LocalWriteStore` | 1 |
| `core/src/api/logical-routes/read.ts`, `personal.ts`, `core/src/domain/push.ts` | `LogicalReader` | 1 |
| `core/src/api/logical-routes/write.ts` | `OpsStore`; the mount narrows | 1 |
| `core/src/logical/push.ts` | `PushRowStore` | 1 |
| `core/src/logical/scheduler.ts` | `SchedulerStore` | 1 |
| `core/src/domain/repository.ts`, `core/src/storage/sqlite.ts`, `core/src/housekeeping.ts` | `AccountDeleter` | 1 |
| `docs/superpowers/ideas.md` | the deferred-split entry | 2 |

---

### Task 1: Narrow every consumer to a `Pick` of what it calls

**Files:** the Task 1 rows above.

**Interfaces:**
- Produces:
  - `export type LogicalReader = Pick<LogicalStore, 'snapshot'>` in `store.ts`
  - `export type AccountDeleter = Pick<LogicalStore, 'deleteLocalAccount'>` in `repository.ts`
  - `LocalWriteStore`, `OpsStore`, `PushRowStore` and `SchedulerStore`, each exported from its consumer module.

There is no new failing test. This task is types only, and its gate is the typecheck: a too-narrow alias fails tsc at the call that needs the missing member.

- [ ] **Step 1: `store.ts` — add `LogicalReader`**

Directly after the last line, `export type LogicalStore = ReturnType<typeof createLogicalStore>`, add:

```ts

// The read seam alone — what a consumer that only projects needs (the pulled feed
// routes, the personal API routes, push's fat-ping bodies).
export type LogicalReader = Pick<LogicalStore, 'snapshot'>
```

- [ ] **Step 2: `domain/service.ts` — `LocalWriteStore`**

Replace line 5, `import type { LogicalStore } from '../logical/store.ts'`, with:

```ts
import type { LogicalStore } from '../logical/store.ts'

// The local-write commands the service drives — all it calls on the store.
export type LocalWriteStore = Pick<LogicalStore,
  'createLocalPost' | 'replyTargetVisible' | 'editLocalPost' | 'removeLocalPost'
  | 'deleteLocalAccount' | 'addLocalFollow' | 'removeLocalFollow' | 'updateUserProfile'>
```

Then in `createService(...)` (line ~23), change the last parameter from `logical: LogicalStore` to `logical: LocalWriteStore`.

- [ ] **Step 3: `read.ts`, `personal.ts`, `domain/push.ts` — `LogicalReader`**

- `core/src/api/logical-routes/read.ts`: the import `import type { LogicalStore } from '../../logical/store.ts'` becomes `import type { LogicalReader } from '../../logical/store.ts'`. In `LogicalReadDeps`, `store: LogicalStore` becomes `store: LogicalReader`.
- `core/src/api/logical-routes/personal.ts`: make the same import change. In `PersonalApiDeps`, `store: LogicalStore` becomes `store: LogicalReader`.
- `core/src/domain/push.ts`: the import `import type { LogicalStore } from '../logical/store.ts'` becomes `import type { LogicalReader } from '../logical/store.ts'`. `export function createPush(deps: PushDeps & { store: LogicalStore }): Push {` becomes `export function createPush(deps: PushDeps & { store: LogicalReader }): Push {`.

- [ ] **Step 4: `write.ts` — `OpsStore`; the mount narrows, `LogicalRouteDeps` stays full**

In `core/src/api/logical-routes/write.ts`, directly after the `LogicalRouteDeps` interface (which **keeps** `store: LogicalStore`, because `app.ts:345` passes `deps.logical` whole and `app.ts:584` calls `schedulerStats` on it), add:

```ts

// What the write/ops routes call on the store — the mount's own view of it.
export type OpsStore = Pick<LogicalStore,
  'checkAcquisitionCommand' | 'getAdminItemDetail' | 'getRun' | 'getRunProjection'
  | 'hideItem' | 'ledgerRefusal' | 'listItemAudit' | 'listJobs' | 'listRuns'
  | 'listSourceItems' | 'listTombstones' | 'purgeSource' | 'recordHealth'
  | 'restoreItem' | 'unblockTombstone'>
```

Change `export function mountLogicalRoutes(app: Hono, deps: LogicalRouteDeps): void {` to:

```ts
export function mountLogicalRoutes(app: Hono, deps: Omit<LogicalRouteDeps, 'store'> & { store: OpsStore }): void {
```

- [ ] **Step 5: `logical/push.ts` — `PushRowStore`**

Directly after the imports (after the last `import` line), add:

```ts

// The push-row bookkeeping push's lifecycle calls on the store.
export type PushRowStore = Pick<LogicalStore,
  'findPushRow' | 'upsertPushRow' | 'deletePushRow' | 'listRenewablePushRows'
  | 'purgeExpiredPushRows' | 'listSchedulableSources'>
```

In `createLogicalPush(deps: { … })`, change `store: LogicalStore` to `store: PushRowStore`.

- [ ] **Step 6: `logical/scheduler.ts` — `SchedulerStore`**

Directly after the imports, add:

```ts

// What the scheduler calls on the store.
export type SchedulerStore = Pick<LogicalStore, 'recordHealth' | 'countSchedulableSources' | 'listDueSources'>
```

In `SchedulerDeps`, change `store: LogicalStore` to `store: SchedulerStore`.

- [ ] **Step 7: `AccountDeleter` — `repository.ts`, `sqlite.ts`, `housekeeping.ts`**

`core/src/domain/repository.ts`: after the line `import type { LogicalStore } from '../logical/store.ts'`, add:

```ts

// The one store call the auth-user sweeps make (cascading account deletion).
export type AccountDeleter = Pick<LogicalStore, 'deleteLocalAccount'>
```

In `Repository`, `sweepUnverifiedUsers(ttlDays: number, logical?: LogicalStore)` and `sweepAnonymousUsers(ttlDays: number, logical?: LogicalStore)` each take `logical?: AccountDeleter` instead.

`core/src/storage/sqlite.ts`:
- The import `import type { LogicalStore } from '../logical/store.ts'` becomes `import type { AccountDeleter } from '../domain/repository.ts'`. Merge it into the existing `../domain/repository.ts` import if there is one; check with `grep -n "domain/repository.ts" core/src/storage/sqlite.ts`.
- `logical?: LogicalStore` becomes `logical?: AccountDeleter` in three places: `sweepAuthUsers` (~L337), `sweepAnonymousUsers` (~L387) and `sweepUnverifiedUsers` (~L407).

`core/src/housekeeping.ts`:
- The import `import type { LogicalStore } from './logical/store.ts'` becomes `import type { AccountDeleter } from './domain/repository.ts'`. Merge it into the existing `import type { Repository } from './domain/repository.ts'` as `import type { Repository, AccountDeleter } from './domain/repository.ts'`.
- In `sweepHousekeeping`, `logical?: LogicalStore` becomes `logical?: AccountDeleter`.

- [ ] **Step 8: Typecheck, test, completion grep**

Run the core typecheck. Expected: exit 0. If tsc reports a member missing from an alias, a consumer calls it and the spec's table missed it. **Stop and report it** with the error; don't widen the alias silently.

Run the core suite. Expected: `1218 passed`.

Run:

```bash
grep -rnw LogicalStore core/src
```

Expected hits:
- `store.ts`: the definition, its use inside `LogicalReader`, and the header comment at ~L41 ("no LogicalStore interface").
- `runtime.ts`: its import and `store: LogicalStore`.
- `write.ts`: its import, `LogicalRouteDeps`, and inside `OpsStore`.
- The `Pick<LogicalStore, …>` lines of `service.ts`, `push.ts` (logical), `scheduler.ts` and `repository.ts`, plus their imports.

Nothing else is expected: `server.ts` and `repository-contract.ts` do not name the type. In particular, `read.ts`, `personal.ts`, `domain/push.ts`, `sqlite.ts` and `housekeeping.ts` must not mention it.

- [ ] **Step 9: Commit**

```bash
git add core/src/logical/store.ts core/src/domain/service.ts core/src/api/logical-routes/read.ts core/src/api/logical-routes/personal.ts core/src/domain/push.ts core/src/api/logical-routes/write.ts core/src/logical/push.ts core/src/logical/scheduler.ts core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/housekeeping.ts
git commit -m "refactor(core): narrow every LogicalStore consumer to a Pick of what it calls"
```

---

### Task 2: Delete the 7 dead store wrappers; record the deferred split

**Files:**
- Modify: `core/src/logical/store.ts`
- Modify: `docs/superpowers/ideas.md`

**Interfaces:**
- Consumes: Task 1's aliases (unchanged).
- Produces: `LogicalStore` without `claimAcquisition`, `commitAcquisition`, `failAcquisition`, `scheduleVerification`, `scheduleOrphanWork`, `removeSourceEvidence` and `scheduleFanout`.

- [ ] **Step 1: Prove each wrapper has no store caller**

Run:

```bash
for m in claimAcquisition commitAcquisition failAcquisition scheduleVerification scheduleOrphanWork removeSourceEvidence scheduleFanout; do echo "$m: $(grep -rnE "\b(store|logical|logicalStore|s|deps\.store|input\.store)\.$m\b|\{[^}]*\b$m\b[^}]*\}\s*=\s*(store|logical)" core/src core/test mcp/src | grep -v 'core/src/logical/store.ts' | wc -l)"; done
```

Expected: every count is `0`. A non-zero count means that method stays: report it and leave it out of Step 2.

- [ ] **Step 2: Delete the wrappers and reword their comments** (all in `core/src/logical/store.ts`)

- **Acquisition.** Delete the 4-line comment that begins `// Acquisition write seam (Task 4).` and the three methods `claimAcquisition(...)`, `commitAcquisition(...)` and `failAcquisition(...)` under it (~L456-468).
- **`scheduleVerification`.** Delete the method `scheduleVerification(tx: WriteTx, input: …): void { scheduleVerification(tx, input) },` (~L492-494). Replace the comment block above it, which starts `// scheduleVerification takes the caller's WriteTx…`, with:

```ts
    // The verification enqueue (verification.ts scheduleVerification) is called
    // directly from reconcile.ts inside V2 reconciliation's aggregate-claim
    // transaction. deferVerification lets the SYNC drain un-claim a verification
    // job (async fetch belongs to the async drain). resolveVerificationBatch is the
    // Task-5 outcome-handling stub — Task 4 performs the fetch and hands the parsed
    // response here; today a no-op.
```

- **`scheduleOrphanWork`.** Delete the method `scheduleOrphanWork(tx: WriteTx, input: NewOrphanWork): void { scheduleOrphanWork(tx, input) },` (~L509-511). Replace the two comment lines under `// --- orphan-work write seam (Task 7) ---` with:

```ts
    // The enqueue (threading.ts scheduleOrphanWork) commits inside its caller's
    // write, atomically with the alias mint that triggers it (spec §4.2); claim +
    // adopt run the continuous worker (driven by Task 10's runtime), each its own
    // transaction.
```

- **`removeSourceEvidence`.** Delete the method `removeSourceEvidence(tx: WriteTx, input: …): { ordinaryAffected: boolean } { return removeSourceEvidence(tx, input) },` (~L574-576). In the purge comment above `purgeSource(...)` (~L567-569), one line ends `…commit atomically. removeSourceEvidence` and the next line begins `// is the shared step-4 helper (Task 7's cleanup reuses it inside its own write);`. Cut ` removeSourceEvidence` from the first line so that it ends `…commit atomically.`, and replace the second line with:

```ts
    // tombstones.ts removeSourceEvidence is the shared step-4 helper (Task 7's
    // cleanup calls it directly inside its own write);
```

- **`scheduleFanout`.** Delete the method `scheduleFanout(tx: WriteTx, input: …): void { scheduleFanout(tx, input) },` (~L593-595). Replace the comment lines `// scheduleFanout takes the caller's WriteTx so the enqueue commits atomically` through `// sqlite.ts, next to advancePolicyGeneration, calling the free fn directly).` with:

```ts
    // The enqueue (fanout.ts scheduleFanout) commits atomically with the
    // transition's reset + generation advance — storage/source-sqlite.ts calls it
    // directly, next to advancePolicyGeneration.
```

- **Header comment (~L44).** `// write methods (claimAcquisition, commitAcquisition, reconcileClaim, …).` becomes `// write methods (reconcileClaim, purgeSource, …).`

- [ ] **Step 3: Drop the imports the deletions orphan** (`store.ts` head)

- The `./types.ts` multi-line type import (store.ts:2-8): remove `ClaimAcquisitionInput`, `ClaimAcquisitionResult`, `CommitAcquisitionInput`, `FailAcquisitionInput` and `AcquisitionRun`. Line 3 becomes `  LogicalReadTx, SourceModelV2Activation, LogicalItemDto,`. Line 4 (`  CommitAcquisitionInput, FailAcquisitionInput, AcquisitionRun,`) is deleted whole.
- `import { claimAcquisition, commitAcquisition, failAcquisition, BOUNDS } from './acquisition.ts'` becomes `import { BOUNDS } from './acquisition.ts'`.
- `import { scheduleVerification, resolveVerificationBatch } from './verification.ts'` becomes `import { resolveVerificationBatch } from './verification.ts'`.
- `import { scheduleOrphanWork, claimOrphanWork, adoptOrphans, projectThread } from './threading.ts'` becomes `import { claimOrphanWork, adoptOrphans, projectThread } from './threading.ts'`.
- `import type { NewOrphanWork, OrphanClaim, AdoptOrphansInput, AdoptOrphansResult } from './types.ts'` becomes `import type { OrphanClaim, AdoptOrphansInput, AdoptOrphansResult } from './types.ts'`.
- `import { scheduleFanout, claimFanout, processFanoutBatch } from './fanout.ts'` becomes `import { claimFanout, processFanoutBatch } from './fanout.ts'`.
- `import { purgeSource, removeSourceEvidence, isTombstoned, unblockTombstone } from './tombstones.ts'` becomes `import { purgeSource, isTombstoned, unblockTombstone } from './tombstones.ts'`.

Then confirm:

```bash
for t in claimAcquisition commitAcquisition failAcquisition scheduleVerification scheduleOrphanWork removeSourceEvidence scheduleFanout ClaimAcquisitionInput ClaimAcquisitionResult CommitAcquisitionInput FailAcquisitionInput AcquisitionRun NewOrphanWork; do echo "$t: $(grep -cw $t core/src/logical/store.ts)"; done
```

Expected: every name is `0`, except the names that now appear only in the reworded comments: `scheduleVerification`, `scheduleOrphanWork`, `removeSourceEvidence` and `scheduleFanout`, at `1` each. `WriteTx` and `BOUNDS` remain in use; leave them.

- [ ] **Step 4: Record the deferred split in `docs/superpowers/ideas.md`**

Read the file's existing entry format first: entries are a `## Title` heading followed by bold `**Field:**` paragraphs. Append one entry in that format, using **Name** as the `##` heading:

- **Name:** Split `createLogicalStore` by consumer.
- **Mechanism:** after the 2026-10-11 narrowing, every consumer's `Pick` alias shows near-disjoint groups: 8 local-write (`LocalWriteStore`), 15 ops (`OpsStore`), 6 push-row (`PushRowStore`), 3 scheduler (`SchedulerStore`), plus `snapshot` and the runtime-wired `Reconciler`, orphan and verification members. Each group could be its own factory over the same `DatabaseContext`.
- **Grounding:** `docs/superpowers/specs/2026-10-11-logicalstore-narrowing-design.md`.
- **Tradeoff:** a pure move with no behaviour gain. The debt review's stopping rule says to do it only when a concrete need appears, for example a group gaining its own lifecycle or tests wanting one group without the rest.
- **Status:** deferred, not specced.

- [ ] **Step 5: Gates**

Run the core typecheck. Expected: exit 0. A tsc error naming one of the 7 means a caller was missed: restore that method and its imports, and report it.
Run the core suite. Expected: `1218 passed`.

- [ ] **Step 6: Commit**

```bash
git add core/src/logical/store.ts docs/superpowers/ideas.md
git commit -m "refactor(core): delete the 7 LogicalStore wrappers nothing calls; record the deferred split"
```
