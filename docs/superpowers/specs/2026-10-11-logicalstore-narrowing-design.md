# `LogicalStore` narrowing — Design

**Status:** Rev 1, 2026-10-11. Approved section-by-section in brainstorming
(scope: narrow + prune; approach A of three: consumer-owned
`Pick<LogicalStore, …>` aliases).
**Origin:** item 5 of the recommended order in
`docs/superpowers/reviews/2026-08-06-architecture-debt-review.md` ("do not
split by file — split by consumer… If narrowing alone kills the coupling pain,
stop there").

## Problem

`createLogicalStore` (`core/src/logical/store.ts:377`) returns one object of
52 members (`snapshot` + 51 methods); `LogicalStore` is its inferred type
(`store.ts:843`). Thirteen `src` modules are typed against the whole thing (`grep -rln "LogicalStore\b" core/src`, excluding `store.ts`) although each calls
a handful of methods, so the type system cannot say which consumer depends on
what, and no method can be removed or moved without a whole-repo audit.

## What exploration established (verified 2026-10-11)

Per-file store calls (`grep` for `store.|logical.|logicalStore.X(` per file):

| Consumer | Calls |
|---|---|
| `domain/service.ts` | `createLocalPost replyTargetVisible editLocalPost removeLocalPost deleteLocalAccount addLocalFollow removeLocalFollow updateUserProfile` |
| `api/logical-routes/read.ts`, `personal.ts`, `domain/push.ts` | `snapshot` |
| `api/logical-routes/write.ts` | `checkAcquisitionCommand getAdminItemDetail getRun getRunProjection hideItem ledgerRefusal listItemAudit listJobs listRuns listSourceItems listTombstones purgeSource recordHealth restoreItem unblockTombstone` |
| `logical/push.ts` | `deletePushRow findPushRow listRenewablePushRows listSchedulableSources purgeExpiredPushRows upsertPushRow` |
| `logical/scheduler.ts` | `countSchedulableSources listDueSources recordHealth` |
| `storage/sqlite.ts`, `housekeeping.ts` (via `repository.ts:29-30`) | `deleteLocalAccount` |
| `logical/runtime.ts` | `snapshot claimOrphanWork adoptOrphans`, and passes the store on to drain / verification / push / scheduler |
| `server.ts` | composition root |

Already narrow (precedents, left as-is): `Reconciler` (`reconcile.ts:526`),
`{ resolveVerificationBatch }` (`verification.ts:120`), `{ schedulerStats }`
(`admin.ts:26`), `{ isTombstoned }` (`source-service.ts:84`), and item 3's
`SourceStore = Pick<…>` (`source-service.ts:14`).

Called through the store by **nothing** (`src` or tests): `claimAcquisition
commitAcquisition failAcquisition scheduleVerification scheduleOrphanWork
removeSourceEvidence scheduleFanout`. Acquisition takes the database directly
(`createAcquisition({ db })`), so its three wrappers have no caller. Called
**only by tests**: `deleteLocalPost` (2 files), `getHealth` (3 files).

## Design

### 1. Consumer-owned narrow types

Each consumer declares, beside itself, a `Pick<LogicalStore, …>` alias of
exactly what it calls, and types its parameter with it. Signatures stay
single-sourced in `store.ts`; no runtime change.

| Alias | Declared in | Members |
|---|---|---|
| `LocalWriteStore` | `domain/service.ts` | the 8 service calls above |
| `LogicalReader` | `logical/store.ts` (three users) | `snapshot` |
| `OpsStore` | `api/logical-routes/write.ts` | the 15 write-route calls above |
| `PushRowStore` | `logical/push.ts` | the 6 push-row calls + `listSchedulableSources` |
| `SchedulerStore` | `logical/scheduler.ts` | `countSchedulableSources listDueSources recordHealth` |
| `AccountDeleter` | `domain/repository.ts` (imported by `sqlite.ts`, `housekeeping.ts`) | `deleteLocalAccount` |

Retyped sites: `service.ts:17` → `LocalWriteStore`; `read.ts:19`,
`personal.ts:27`, `domain/push.ts:198` → `LogicalReader`; the write-route mount
parameter → `OpsStore`; `logical/push.ts:118` → `PushRowStore`;
`scheduler.ts:21` → `SchedulerStore`; `repository.ts:29-30`,
`sqlite.ts:337,387,407`, `housekeeping.ts:15` → `AccountDeleter`.

**Stay `LogicalStore`** (they pass the store on, they don't call it):
`server.ts`; `runtime.ts:351` (its need is the union of drain, verification,
push and scheduler); `LogicalRouteDeps` (`write.ts:18`) — app.ts's composition
type that hands the store to the read, personal and admin routes. Only the
write-route mount's own parameter narrows.

`core/test/` needs no change: tests pass a real store, which satisfies every
alias structurally. `repository-contract.ts` (a test harness) stays full.

### 2. Prune

Delete the 7 store **wrapper** methods nothing calls through the store. The
same-named free functions in other modules stay — they are internal callees.
`tsc` over `src` + `test` is the proof: any caller the grep missed
(destructuring, indirect access) becomes a compile error, in which case that
method stays and this spec is revised. `deleteLocalPost` and `getHealth` stay
(tests are real consumers).

### 3. The split question

Not split. The narrowed types record the evidence — 8 local-write, 15 ops,
7 push, 3 scheduler, plus `snapshot`, with near-zero overlap — and the split
goes to `docs/superpowers/ideas.md` as a not-yet-justified option, to be
promoted only on a concrete need (the debt review's own stopping rule).

## Order and verification

Two commits, each with every gate green (core tsc, core suite, in the
containers):

1. **Narrow** (§1). Types only — core suite unchanged at 1218, tsc 0.
2. **Prune** (§2) + the `ideas.md` entry (§3). tsc 0, suite still 1218.

Done when the only `src` files still typed `LogicalStore` are `store.ts`,
`server.ts`, `runtime.ts` and the `LogicalRouteDeps` composition type in
`write.ts` (`grep -rn "LogicalStore\b" core/src`), and every other consumer's
alias lists exactly what it calls.

## Risks

- A store member reached by something other than a `.name(` call (bracket
  access, spread, destructuring) is invisible to the grep — the prune's tsc
  gate catches it; the narrowing's tsc gate catches a consumer whose alias is
  missing a member.
