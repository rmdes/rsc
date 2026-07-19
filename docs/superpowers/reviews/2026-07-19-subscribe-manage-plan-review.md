# SP3 subscribe & manage — plan review (rev 0 → rev 1)

Plan: `docs/superpowers/plans/2026-07-19-subscribe-manage.md`
Reviewers: clean-context correctness (probes against installed tsc/Kysely/
feedsmith) + ponytail. All dispositions folded as plan rev 1.

## Correctness findings

- **C1 Critical — Task 1's typecheck gate failed as written.** The plan
  claimed `Promise<boolean>` assigns to `Promise<void>` (`ImportDeps.addFollow`
  wirings) — false; the void special case applies only to bare `void` (probe:
  TS2322 under the repo's strict tsconfig, which covers `test/`). **Folded:**
  the `ImportDeps.addFollow → Promise<boolean>` signature change moved into
  Task 1, with the `opml.test.ts` `importSetup` stub gaining `return true`.
- **I1 Important — "phantom" test file.** The reviewer found no following-page
  tests; ponytail found the real path. **Adjudicated by direct listing:**
  `web/src/routes/u/[handle]/following/following.actions.test.ts` EXISTS —
  the correctness reviewer only listed the top-level dir. **Folded:** Task 5
  extends the file at its real nested path (rev 0 staged a nonexistent
  top-level path — both reviewers contributed half the fix).
- **I2 Important — SSRF/DNS test trap.** `checkCallbackUrl` does real DNS for
  hostnames; the local-URL test's `publicUrl` must be a TEST-NET IP-literal
  origin or the request 400s before the resolve runs. **Folded** into the
  Task 1 test spec (the instance-over-HTTP test it also affected was cut —
  see ponytail).
- M1 — `opml.test.ts` unused-var is an editor hint, not a typecheck error
  (`noUnusedLocals` off). Wording fixed.
- M2 — the discovery-ordering test's helpers (`router()`, HTML fixtures) live
  in `ingest-discovery.test.ts`, not `ingest.test.ts`. Placement folded.
- M3 — `importSetup` must gain the `getRemoteUserByFeedUrl` dep and the file
  needs a `HandleTakenError` import. Folded into Task 2.
- M4 — spec's repository-contract layering note landed as a Task 1 one-line
  comment in `repository-contract.ts`.
- M5 — split-horizon-DNS caveat on the route-level local resolve added as a
  comment line.

Verified-correct highlights: every quoted before-state matches main
(service/opml/app/web regions, four `addRemote` tests at :66/:74/:81/:107);
Kysely 0.29.3 has `UpdateQueryBuilder.whereRef`; feedsmith 2.9.6 feed `title`
is a plain optional string in all four formats; `resolveUser` lowercases;
`createApp` accepts per-test `feeds.publicUrl`; the cap-free local resolve is
coherent with the uncapped-local-follows design; typecheck blast radius beyond
C1 is nil (fakes are `as unknown as` casts).

## Ponytail findings (folded)

1. "Reuse returns 200" → tighten the existing double-POST `[200,201]` test
   instead of adding a duplicate.
2. Instance-URL-over-HTTP test cut (service-level guard fully covered;
   route adds no logic).
3. `/me/follows`-on-instance re-test cut (third pass over the same guard).
4. OPML "instance winner of the Case-3 race" test cut (cross-product of the
   two kept tests).
5. Ingest test 1 sheds its no-clobber half (that's the repo test's assertion).
6. Speculative "normalize with a tiny local helper" clause deleted (feedsmith
   probe settled it).
7. Subset-then-full-suite step pairs collapsed to one full-suite line
   (Tasks 1-3).
   Plus the Task 5 path bug (see I1).

Net: one execution-blocking typecheck error fixed, one test-env trap
defused, 4 redundant tests and ~60 plan lines cut.
