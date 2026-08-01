# Logical Pipeline Simplification Roadmap — clean-context review

**Reviewed:** `docs/superpowers/specs/2026-08-01-logical-pipeline-simplification-roadmap.md`
**Against:** the real `core/` code (HEAD includes the public firehose `868760a` and the
retention age gate `f3bbf98`), the audit (`2026-08-01-logical-pipeline-audit.md`), and the
parked prior-art design (`2026-07-31-remote-content-simplification-design.md`).
**Method:** verified every load-bearing claim against source; nothing implemented, nothing changed.

## Verdict

**Not sound to execute as written — Phase A is mis-premised and must be re-scoped before it starts.**
The roadmap's keystone claim — "`convert.ts` is dead code; retiring it dissolves Critical 1 and
unlocks C" — is **false in two independent ways**, both provable from the code:

1. `core/src/migration/convert.ts` (`runConversion`) is **live on every fresh install's first
   boot**, not dead. `runtime.ts:250-258` carries a capitalized "LIVE ON THE FRESH-INSTALL PATH —
   do not retire" warning, and `core/test/fresh-install.test.ts` is a standing green guard that
   exists specifically to stop this deletion. A prior effort (V4 Task 11/13, referenced in that
   test) already retired *most* of the migration machinery and deliberately stopped here.
2. The converter→verification "tangle" the whole A→C dependency rests on is **one JSON string
   constant** (`EMPTY_COUNTERS`), not a structural knot. Relocating it (its natural home is beside
   `ZERO_COUNTERS` in `acquisition.ts:461`) unblocks Phase C completely — with or without touching
   the converter. **C does not depend on A.**

The good news: the *simplification intent* behind A is still valid (the converter does zero real
work on every existing instance and on fresh installs), and Phases B, C, D, F and the 5-Criticals
mapping are otherwise well-reasoned and correctly assigned. The fix is to re-scope A and cut the
spurious A→C edge, not to abandon the program.

## Findings

### Critical

**C1 — Phase A's "dead code" premise is false; `convert.ts` runs on every fresh install.**
`must-fix-before-starting-Phase-A.`
`runtime.ts:295 activateLogicalV2` → `:310` calls `convertLegacy` on the `never_activated` branch,
which is **every brand-new install's first boot** (`runtime.ts:264-281` → `runConversion`). The
explicit warning block at `runtime.ts:250-258` and the guard test `core/test/fresh-install.test.ts`
(comment: "convertLegacy is NOT dead code … must stay green through the migration-machinery
retirement") both exist to prevent exactly the deletion Phase A proposes. There is **no separate
"migration entrypoint"** to remove — the converter is fused into the ordinary pre-listen activation
transaction. **Fix:** re-scope A from "remove dead converter" to "collapse the fresh-install
activation path": on `never_activated` there are zero legacy rows (`users WHERE kind='remote'`,
`posts WHERE source='remote'` are all empty on a fresh DB), so `convertLegacy` can be replaced by
the trivial marker-write it already does over zero rows, letting `convert.ts` + `preflight.ts` +
`preflight-cli.ts` be deleted. This is a **startup-path behavior change, not dead-code removal** —
re-label the risk **Medium**, and keep `fresh-install.test.ts` green as the acceptance gate.

**C2 — Phase A lists `logical_activation_v2` for removal, but it is the live v2 activation-state
singleton.** `must-fix-before-starting-Phase-A.`
The Phase A table (roadmap line 49) and brief say to retire "`logical_activation_v2` and the
conversion-findings bookkeeping." But `logical_activation_v2` is read on **every** startup
(`runtime.ts:189 readActivation`, `store.ts:64`) and written on every activation
(`runtime.ts:221 writeActivation`); it drives the `never_activated → active →
reconciliation_required` state machine. Dropping the table breaks all boot. Only its two
**columns** `converted_at` / `conversion_findings_json` (`schema.ts:310-311`) are conversion
bookkeeping and droppable. **Fix:** Phase A drops the two columns, never the table. Correct the
roadmap table and brief wording ("retire `convert.ts`, `logical_activation_v2`…") — it currently
reads as "delete the activation singleton."

### Important

**I1 — The A→C dependency is spurious; C's real prerequisite is relocating `EMPTY_COUNTERS`.**
`not a hard blocker, but fixes the sequencing.`
Critical 1 in both the parked spec and the roadmap is "deleting `verification.ts` breaks
`convert.ts` via `EMPTY_COUNTERS`." Verified: `convert.ts:9` imports it, uses it once at
`convert.ts:490`. But `EMPTY_COUNTERS` (`verification.ts:239`) is a plain `JSON.stringify({…})`
counters string, and it is the **twin** of `ZERO_COUNTERS` (`acquisition.ts:461`) — `f3bbf98`'s
message even notes the `retentionFiltered` field was "mirrored into both." When Phase C deletes
`verification.ts`, `EMPTY_COUNTERS` must move somewhere **regardless** (it's used inside
`verification.ts:359` too). Its natural home is beside `ZERO_COUNTERS` in `acquisition.ts` (or a
shared constants module), collapsing the two twins into one. **Consequence:** Phase C can run
**independently of Phase A** once that one constant is relocated. The roadmap over-couples C to the
entire fresh-install refactor. **Fix:** move the "relocate/merge `EMPTY_COUNTERS`" step into Phase
C's own footprint and drop the "C depends on A" edge (roadmap lines 51, 90). A and C become
independent; each still stands alone.

**I2 — Phase C footprint must include the two `verified_origin` reap-protection heuristics and the
`LEVEL_RANK`-undefined hazard.** `fold into Phase C spec (already partly noted).`
Removing the `verified_origin` rung (`projector.ts:17,27`) leaves `LEVEL_RANK` a 3-key record; any
**surviving** `evidence_level='verified_origin'` claim row then indexes `LEVEL_RANK[undefined]` →
`undefined` in `strongestEligibleLevel`/`compareFirstArrival` (this is parked-spec Critical 3, real
and correctly assigned to C). Additionally, two heuristics read those rows directly and must be
repointed the same migration: `source-repository.ts:264-265` (reap refusal reason
`verified_origin_evidence`) and `sqlite.ts:617` (`retentionFor` priority rung). The audit's proposed
replacement — the existing `admin_retained` flag — is confirmed present at `sqlite.ts:619` /
`source-repository.ts` reap chain, so the down-migration + fallback is viable. Also mirror
`retentionFiltered` when relocating `EMPTY_COUNTERS` so `counters_json` stays complete on every
commit path (`f3bbf98`). Enumerate all of these in the Phase C spec footprint; the roadmap's
Critical-4 "under-removed footprint" bucket covers this in spirit but should name these three sites.

### Minor

**M1 — Re-label Phase A risk Low→Medium.** Given C1/C2 it is a startup-path refactor guarded only by
`fresh-install.test.ts`, not "dead-code removal." `not a blocker, honesty fix.`

**M2 — Phase B ↔ retention age gate: independent, but state it.** `f3bbf98`'s gate acts on **new
deliveries** in `commitAcquisition` (age filter); Phase B's version-collapse acts on
`observation_versions_v2` rows **per existing delivery**. They don't interact, and an existing
delivery is explicitly never gated (a real edit still records) — so B's "overwrite in place on a
real change" stays compatible. Worth a one-line note in the Phase B spec so the plan reviewer
doesn't re-derive it. `not a blocker.`

**M3 — Firehose (parallel session `868760a`) is NOT a missed dependency — confirmed safe.**
`no action.` `logical-routes.ts:740` emits `origin==='local'` upserts only; `firehoseEntry`
(`:636`) projects `entry.author.displayName`/handle and the safe-wire `itemContentFields`, never
`observation_versions` history, `verified_origin`, or the publisher-claims graph (all remote-item
concerns). Remove frames are origin-blind but content-free. So Phases B/C/D do not touch the
firehose's read set. Byline on the firehose is the local account's, untouched by C/D. (This directly
answers task item 3: no missed dependency.)

## Correct as written — don't churn

- **Critical 2 (FK-RESTRICT delete order) → Phase B.** Verified: `presentation_entries_v2` is
  `observation_version_id … UNIQUE … ON DELETE RESTRICT` (`schema.ts:98`), and
  `publisher_claims_v2` (`:110`), `logical_conflicts_v2` (`:116`), `reconciliation_jobs_v2` (`:176`)
  all RESTRICT-reference `observation_versions_v2`. Real hazard, right owner.
- **Critical 3 (live `verified_origin` rows) → Phase C, Critical 5 (survivor selection) → Phase B.**
  Both real, both correctly placed.
- **Phase B independent of A.** Correct — version-collapse shares nothing with the converter/
  activation path.
- **D "cleanest after C" and F after A stated as soft, not hard.** Honest — D subsumes the evidence
  ranking anyway; F's table drops are separable. No false hard edges there.
- **Deferring Phase E (reconciliation inline).** Right call — it touches the spine's concurrency
  model (`store.ts` drains, `reconciliation_jobs_v2`), highest risk, correctly out of scope.
- **~1,100 LOC / ~6 tables estimate.** Plausible: verification ~417 LOC + runner/wiring, version-
  history ~250, publisher-graph ~300, plus `convert.ts` ~630 once A is (correctly) re-scoped to
  delete it — the estimate is if anything conservative, not inflated.
- **Byline-preservation contract (C drops `verified_origin` rung, D defers the bar to its own
  brainstorm).** The comparator stays author-producing at 3 levels; local/firehose bylines are
  unaffected; the only byline change is the accepted `verified_origin` tiebreak drop. Consistent.

## Must-fix-before-starting-Phase-A

1. **C1** — re-scope A from "remove dead converter" to "collapse the fresh-install activation path
   over zero rows"; keep `fresh-install.test.ts` green as the gate.
2. **C2** — Phase A drops only the `converted_at` / `conversion_findings_json` **columns**, never
   the `logical_activation_v2` **table**; fix the roadmap wording.
3. **I1** — cut the A→C dependency; move "relocate/merge `EMPTY_COUNTERS` beside `ZERO_COUNTERS`"
   into Phase C. A and C become independent.
