# `LogicalStore` narrowing — Design

**Status:** Rev 2, 2026-10-11. Rev 1 was approved section-by-section in
brainstorming (scope: narrow + prune; approach A of three: consumer-owned
`Pick<LogicalStore, …>` aliases). Rev 2 folds a clean-context review (READY WITH
CHANGES; 2 Important) — each finding re-verified against the code. See "Rev 2
changes".
**Origin:** item 5 of the recommended order in
`docs/superpowers/reviews/2026-08-06-architecture-debt-review.md` ("do not
split by file — split by consumer… If narrowing alone kills the coupling pain,
stop there").

## Problem

`createLogicalStore` (`core/src/logical/store.ts:377`) returns one object of
52 members (`snapshot` + 51 methods); `LogicalStore` is its inferred type
(`store.ts:843`). Eleven `src` modules are typed against the whole thing (`grep -rlw LogicalStore core/src`, excluding `store.ts`) although each calls
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
| `api/app.ts` | `schedulerStats` (`:584`, `/admin/overview`, via `deps.logical.store`) |
| `server.ts` | composition root; calls `snapshot` itself (`:106`) |

**Reached only through the composition roots** — a future pruner must not read
these as dead: `claimOrphanWork`/`adoptOrphans` (runtime.ts only), the six
`Reconciler` members (reconcile.ts, wired by runtime.ts), `resolveVerificationBatch`
(verification.ts, wired by runtime.ts), `isTombstoned` (source-service, wired via
`createSourcePlane` from server.ts).

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
| `PushRowStore` | `logical/push.ts` | the 6 calls above (5 push-row + `listSchedulableSources`) |
| `SchedulerStore` | `logical/scheduler.ts` | `countSchedulableSources listDueSources recordHealth` |
| `AccountDeleter` | `domain/repository.ts` (imported by `sqlite.ts`, `housekeeping.ts`) | `deleteLocalAccount` |

Retyped sites: `service.ts:17` → `LocalWriteStore`; `read.ts:19`,
`personal.ts:27`, `domain/push.ts:198` → `LogicalReader`; the write-route mount
`mountLogicalRoutes(app, deps)` (`write.ts:106`) → `deps: Omit<LogicalRouteDeps, 'store'> & { store: OpsStore }`
(`LogicalRouteDeps` itself stays full — `app.ts:345` passes `deps.logical` whole); `logical/push.ts:118` → `PushRowStore`;
`scheduler.ts:21` → `SchedulerStore`; `repository.ts:29-30`,
`sqlite.ts:337,387,407`, `housekeeping.ts:15` → `AccountDeleter`.

**Stay `LogicalStore`** (they pass the store on, they don't call it):
`server.ts`; `runtime.ts:351` (its need is the union of drain, verification,
push and scheduler); `LogicalRouteDeps` (`write.ts:18`) — app.ts's composition
type that hands the store to the read, personal and admin routes and calls
`schedulerStats` itself (`app.ts:584`). Only the write-route mount's own parameter
narrows.

`core/test/` needs no change: tests pass a real store, which satisfies every
alias structurally. `repository-contract.ts` (a test harness) stays full.

### 2. Prune

Delete the 7 store **wrapper** methods nothing calls through the store. The
same-named free functions in other modules stay — they are internal callees.
`tsc` over `src` + `test` is the proof: any caller the grep missed
(destructuring, indirect access) becomes a compile error, in which case that
method stays and this spec is revised.

**Dead imports are on you, not tsc** (no `noUnusedLocals`): drop what the
deletions orphan in `store.ts` — the value imports `claimAcquisition`,
`commitAcquisition`, `failAcquisition` (`store.ts:16`), `scheduleVerification`,
`scheduleOrphanWork`, `scheduleFanout`, `removeSourceEvidence`, and the type
imports only those wrappers used (`ClaimAcquisitionInput/Result`,
`CommitAcquisitionInput`, `FailAcquisitionInput`, `NewOrphanWork`, and
`AcquisitionRun` if nothing else in `store.ts` uses it) — each grep-checked. Reword
the `store.ts:44` comment that cites `claimAcquisition, commitAcquisition` as
store methods.

`deleteLocalPost` and `getHealth` stay: each is a one-line pass-through that 5 test
call sites use (`logical-purge`, `logical-sse`; `logical-admin-api`,
`logical-scheduler`, `logical-v4-vertical`); rewriting those to raw `db.write`/SQL
trades a public seam for test-only plumbing.

### 3. The split question

Not split. The narrowed types record the evidence — 8 local-write, 15 ops,
6 push, 3 scheduler, plus `snapshot`, with near-zero overlap — and the split
goes to `docs/superpowers/ideas.md` as a not-yet-justified option, to be
promoted only on a concrete need (the debt review's own stopping rule).

## Order and verification

Two commits, each with every gate green (core tsc, core suite, in the
containers):

1. **Narrow** (§1). Types only — core suite unchanged at 1218, tsc 0.
2. **Prune** (§2) + the `ideas.md` entry (§3). tsc 0, suite still 1218.

Done when `grep -rnw LogicalStore core/src` shows only: its definition and
`LogicalReader` in `store.ts`; `runtime.ts`; `LogicalRouteDeps` in `write.ts`;
and each alias's own `Pick<LogicalStore, …>` — and every alias lists exactly what
its consumer calls. (`-w` matters: a plain `LogicalStore\b` also matches
`createLogicalStore`.)

## Risks

- A store member reached by something other than a `.name(` call (bracket
  access, spread, destructuring) is invisible to the grep — the prune's tsc
  gate catches it; the narrowing's tsc gate catches a consumer whose alias is
  missing a member.

## Rev 2 changes

From a clean-context review of rev 1; each re-verified before folding:

1. The write-route mount's narrowed type is now spelled out
   (`Omit<LogicalRouteDeps, 'store'> & { store: OpsStore }`) — `LogicalRouteDeps`
   is shared with `app.ts:345` and must stay full.
2. §2 now lists the imports the prune orphans (tsc won't flag them) and the
   stale `store.ts:44` comment.
3. Minor: `app.ts:584` `schedulerStats` added to the consumer table; a
   "reached only through composition roots" note; push count corrected to 6;
   the done-grep uses `-w` (and the module count is 11, not 13); the reason
   `deleteLocalPost`/`getHealth` stay is stated.
