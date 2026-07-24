# V4 Task 3 — plan corrections

Recorded during execution of Task 3 ("v2 callbacks, the pause/block matrix, and
the admin push surface") of `../plans/2026-07-22-rsc-migration-cutover.md`.
Doc-only: the code commit is `core: serve v2 push callbacks and admin push
state`. Executed plans are historical records, so the plan text itself is left
alone — this note is the correction.

## 1. Appendix C's Task 3 staged-path row is incomplete

Five files Task 3 must change are absent from its row. Three were carried into
the task brief; two more were discovered while implementing the delivered-body
path. All five are staged in the code commit.

| File | Why Task 3 must touch it | Where it should have been staged |
|---|---|---|
| `core/src/storage/sqlite.ts` | Task 1 parked `SourceSummary.push` / `SourceDetail.pushExpiresAt` on an all-null `NO_PUSH` constant here, marked `ponytail:` and explicitly deferred to "Task 3 replaces this with the real read". Task 3 is that read. | Task 3's row (it is already in Task 1's and Task 5's) |
| `web/src/lib/logical-types.ts` | Its wire mirror of `updatedAtProvenance` is `'explicit' \| 'arrival' \| null` while core's has said `\| 'legacy_unknown'` since Task 1. **No Appendix C row anywhere in V4 stages this file**, yet it becomes wrong the moment conversion emits `legacy_unknown` (Task 6). Widened here, ahead of the first writer. | Task 3's row (Task 6 has no web path at all) |
| `core/src/domain/source-repository.ts` | Task 1 widened `establishFederation`'s `actorKind` only in the `SqliteRepository` implementation; the `SourceRepository` **declaration** still said `'administrator'`. Task 9's ops route cannot pass `'operator_token'` against that declaration. | Already in Task 3's row — the omission was in Task 1's *work*, not the staging |
| `core/src/logical/acquisition.ts` | A fat ping's delivered body must enter "the same V2 acquisition path as a poll — fetch skipped, the body is the document" (spec §1.4). Only the engine can skip its own fetch, and only `claimAcquisition` can write `delivery_mechanism` on the run row it inserts. | Task 3's row |
| `core/src/logical/types.ts` | Carries `AcquisitionReason`, which gains the `{kind:'push'; document}` variant the engine branches on. | Task 3's row |

The `AcquisitionReason` addition is a **delivery-mechanism discriminant, not a
new stored reason**: `claimAcquisition` still maps it to the `'scheduled'` value
of V2's two-value `reason` vocabulary and records `delivery_mechanism = 'push'`
in the additive nullable column. Adjudication FC1 ("no new reason value") is
intact, and `core/test/v4-schema.test.ts` still pins the two-value `reason`.

Method choice, for the record: the variant was preferred over a new
`AcquisitionEngine` method precisely because `AcquisitionEngine` is implemented
by hand-written stub objects in five test suites and by the runtime's
drain-wrapping `wrapped` engine. A new required member would have broken all of
them; the variant broke none, and the wrapper forwards the push path — with its
reconciliation drain and stream hint — for free.

## 2. `createLogicalRuntime` now takes the whole `Config`

The plan's Task 3 says the runtime composition supplies `pushInApi` from
`createLogicalPush`, but not that the runtime must therefore hold enough config
to build it. `createLogicalPush` reads `RSC_PUSH_IN` and `RSC_PUBLIC_URL`
through `pushInEffective(config: Config)` — and `push-in.ts` is byte-frozen
until Task 11, so that signature cannot be narrowed to fit. The runtime's
`config: { pollSeconds: number }` is therefore widened to `config: Config`
(`server.ts` already had one; three test suites now build one via `loadConfig`).
The runtime also gains optional `fetchFn`/`lookupFn`, used only by push's
outbound registration — production passes neither, exactly as it does for
acquisition.

## 3. The composition guard is behavioural, not typed

Task 2 left `SchedulerDeps.push` optional, so the entire push subsystem could be
omitted at the runtime call site with a fully green suite — the fourth instance
of that shape in this milestone. Task 3 promotes it to
`push: PushLifecycle | undefined`, matching `drainVerification`.

**That type change is not the guard**, and the plan should not be read as though
it were. `push: undefined` still compiles. The guard is the composition test in
`core/test/logical-push-callbacks.test.ts`, which drives a real
`createLogicalRuntime` through a real poll pass over a real acquisition engine
and asserts a `push_subscriptions_v2` row is actually written. Verified by
mutation: with the `push` argument removed from `runtime.ts`'s `createScheduler`
call, `npm run typecheck -w core` still exits 0 while exactly that test fails.

Later tasks that add a worker to the runtime should copy this shape: a required
parameter for the type, and one behavioural test that fails when the wiring —
not the type — is dropped.

## 4. Two documentation fixes

- `core/src/api/logical-routes.ts` called `AuditCategory` "the full eight-value
  TS AuditCategory". It is nine values since V4 added `'migration_review'`; the
  runtime allowlist at that site correctly excludes it, so only the comment was
  wrong.
- `2026-07-24-v4-task-1-plan-corrections.md` said the V4 schema lands at
  "migration index 15". It is array **index 14** — the 15th entry — which is why
  `user_version = 15`.

## Unchanged pins

No migration (`user_version` stays 15), `push_subscriptions_v2.state` stays
two-valued, `core/src/domain/push-in.ts` is byte-identical, both `test.fails()`
markers stay expected-fail, and the global vitest `testTimeout` and the two OPML
per-test timeouts are untouched.
