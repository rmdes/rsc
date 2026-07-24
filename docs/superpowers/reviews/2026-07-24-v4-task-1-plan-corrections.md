# V4 Task 1 — plan corrections (execution findings)

Three points where `docs/superpowers/plans/2026-07-22-rsc-migration-cutover.md`
rev 2 diverges from the code as it actually stands. Recorded here rather than
silently deviating; the executed commit is `5f6cbe9`.

## 1. `installV4Schema(raw)` does not exist as described

Appendix A and Task 1 Step 4 say the migration entry "calls
`installV4Schema(raw)` in `core/src/logical/schema.ts`". `MIGRATIONS` is
`string[][]` (`core/src/storage/sqlite.ts`), and V2/V3 both ship as exported
statement arrays (`LOGICAL_V2_SCHEMA`, `LOGICAL_V3_SCHEMA`) referenced by name
at the tail. Task 1 followed that existing pattern: `LOGICAL_V4_SCHEMA` is a
`string[]` appended at the tail (migration index 15, `user_version = 15`). The
DDL is byte-for-byte Appendix A. Tasks 2–10 should read "install the V4 schema"
as "the `LOGICAL_V4_SCHEMA` array".

## 2. Appendix C's Task 1 staged-path list is incomplete

Three pre-existing suites break mechanically on the Task 1 change and are not
in its row:

- `core/test/migrations.test.ts` — pins `user_version` in four places; any
  tail-appended migration must bump it (14 → 15).
- `core/test/source-reads.test.ts` and `core/test/source-admin-api.test.ts` —
  both assert the EXACT key set of `SourceSummary` / `SourceDetail`, so
  `SourceSummary.push` and `SourceDetail.pushExpiresAt` require the expected
  key lists to grow. Both assertions stay exact (nothing was loosened).

They were staged with Task 1. Note that `source-admin-api.test.ts` is also in
Task 3's staged list — that is fine, but Task 3 must expect it already updated.

## 3. `establishFederation`'s `actorKind` widening is split across tasks

The shared-interfaces block puts the widening in Task 1, but the two
declarations live in files Task 1 does not stage: `SourceService`
(`core/src/domain/source-service.ts`, staged by Task 9, whose ops-token route
is the first caller) and `SourceRepository`
(`core/src/domain/source-repository.ts`, staged by Task 3). Task 1 widened only
the implementation it owns (`SqliteRepository.establishFederation` in
`core/src/storage/sqlite.ts`) plus `SourceAuditEvent.actorKind`. Tasks 3 and 9
must widen their two declarations, or the ops route cannot pass
`'operator_token'` through.

## Non-divergence, for the record

`SourceSummary.push` / `SourceDetail.pushExpiresAt` are emitted by
`core/src/storage/sqlite.ts` as an all-null constant (`NO_PUSH`), because Task 1
is schema+types only and `push_subscriptions_v2` stays empty until Task 2.
Task 3 ("admin push state") replaces the constant with the real read — but
`core/src/storage/sqlite.ts` is not in Task 3's staged list either, so Task 3
will need it.
