# V4 Task 2 — plan corrections (execution findings)

Four points where `docs/superpowers/plans/2026-07-22-rsc-migration-cutover.md`
rev 2 diverges from the code as it actually stands. Recorded here rather than
silently deviating; the executed commit is `6f52a6c`.

## 1. `run.pushCapabilityJson` does not exist — the claim is read, not passed

Task 2's Interfaces paragraph says the poll loop calls
`maybeRegister(sourceId, parsePushCapability(run.pushCapabilityJson))`.
`AcquisitionRun` (`core/src/logical/types.ts`) is
`{runId, sourceId, status, outcome}` — the capability JSON is written to the
run ROW by `commitAcquisition` and never returned. Widening `AcquisitionRun`
would touch `acquisition.ts`/`types.ts`, neither of which is in Task 2's
Appendix C staged set.

So `createLogicalPush` gained one method beyond the File-map list:

```ts
latestClaim(sourceId: string): PushClaim | null
```

It reads the source's newest run and parses its `push_capability_json`, which
is where spec §1.1's "registration acts only on the latest successful run's
claim" now lives as a property of the read rather than of the caller. The
scheduler calls `push.maybeRegister(sourceId, push.latestClaim(sourceId))`;
`maybeRegister` keeps its pinned `(sourceId, claim)` signature.

**"Latest successful run" is scoped to runs that PARSED a document**
(`outcome IN ('parsed','completed_truncated')`). A conditional-request 304 saw
no document and records no claim, so if 304 runs could supersede, a stable feed
whose lease lapsed could never re-register — a hole the narrower reading (only
a newer parse supersedes an older parse) closes while keeping stale claims
inert. Pinned by a test.

## 2. The scheduler holds no `DatabaseContext`, so the purge needs a wrapper

`purgeExpiredPushRows(tx, now)` takes a `WriteTx` as pinned, but
`SchedulerDeps` carries only `store` — it cannot open a transaction. The
factory therefore also returns `purgeExpired(now: string): void`, a one-line
`db.write` wrapper, and the pass tail is
`await push.renewDue(); push.purgeExpired(now)` exactly as the plan describes.

## 3. `SchedulerDeps.push` is OPTIONAL — deliberately, and only for now

Unlike `drainVerification` (required, `| undefined`, left untouched), the new
`push` dep is `push?: PushLifecycle`. The only non-test caller of
`createScheduler` is `core/src/logical/runtime.ts`, which is **not** in Task 2's
staged set — it is in Task 3's. Task 3 wires `createLogicalPush` into the
runtime composition; it should decide then whether to promote `push` to the
same required-but-nullable posture as `drainVerification`. Until it is wired,
a scheduler without it simply polls at the base cadence.

## 4. `createLogicalPush` deps omit `sourceRepository`

The File map lists `sourceRepository: SourceRepository` in the factory's deps.
Task 2 needs nothing from it: registration eligibility is exactly V2's
schedulability predicate (`store.listSchedulableSources()`, which already
composes enabled + not-blocked + subscribed-or-federated), reused rather than
re-expressed, and the topic/endpoint come from the claim. The dep was left out;
Task 3's callback handlers can add it when they have a caller.

## Non-divergence, for the record

- No migration was needed or added — Task 1 shipped `push_subscriptions_v2`
  (`user_version` stays 15).
- `deletePushRow` is pinned by the File map and has no production caller yet
  (Task 3's `hub.mode=denied` is the first); it ships covered by a store test
  rather than as untested surface.
- The five pinned store methods keep their exact pinned names and signatures.
