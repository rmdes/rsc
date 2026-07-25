# Instance-governed members — plan review (2026-07-25)

Target: `docs/superpowers/plans/2026-07-25-instance-governed-members.md`
(rev 1, `32c0401`, 8 tasks off spec rev 3). Dual pass: ponytail PT1–PT17 +
fidelity F1–F14, adjudicated. **Verdict: NOT READY — fold as plan rev 2.
The plan's spec fidelity is strong (the reviewer verified every rev-3
mechanism carried faithfully), but it collides with two frozen contracts,
has one non-atomic data heal, and is ~30% heavier than its own design.**

## Adjudicated fold instructions (rev 2)

**Correctness (must-fix):**

1. **F1 — never emit `provenance` on web rows.** The frozen guard
   (`source-actions.test.ts:124`) fails on any row key matching
   /provenance/i, and the guard is deliberate. `toRow` computes a boolean
   (`isMember` or `viaVerification`) and the raw field never leaves the
   load. The spec requires the signal, not the field.
2. **F2 — the members/counts reads gate on `:id` having an APPROVED
   federation relationship, and the range SQL lives ONCE** as
   `memberRowsPage` in `core/src/logical/membership.ts` (the spec's
   one-exported-predicate rule; PT12's cursor-idiom reuse applies inside
   it). Without the gate, the plan's own "non-instance id returns empty"
   test expectation is false.
3. **PT16+PT17+F5 — the heal becomes `healMembers(raw)` exported from
   `membership.ts`,** called from `migrate()` under `if (fromVersion < 18)`
   and WRAPPED in one `raw.transaction(...)()` — the current placement
   runs outside any transaction after `user_version` is already bumped: a
   crash mid-heal is unrecoverable. Tests call `healMembers` directly on a
   seeded normal DB (no MIGRATIONS export, no version fixtures).
4. **PT9+F3 — the two new routes join the parametrized authz matrix**
   record in `source-admin-api.test.ts` (the suite whose name claims total
   coverage), not a bespoke "401 anonymous" pair.
5. **F6 — flag-off is tested, not asserted:** one `makeApp(false)`
   assertion in the heal task (migration 18 + heal run unconditionally;
   the claim needs evidence).
6. **PT7+F7 — the EXPLAIN assertion reuses `logical-fk-indexes.test.ts`'s
   `plan()` helper, keeps `not.toMatch(/SCAN/)`, and runs over the SHIPPED
   statement text** (exported), not a hand-typed twin — the shipped query's
   ORDER BY is exactly what can degrade to a temp B-tree the typed copy
   would never catch.
7. **F14 — the nested-instance edge closes in the predicate:** membership
   excludes any row that itself carries an approved federation
   relationship (generalizing not-self to not-any-instance). One clause;
   record as a dated spec-edge amendment in the same commit.
8. **PT13+F4 — one cascade signature:** the 4-param form
   (`raw, instance, action, now`) with the audit insert at both call
   sites, where `command` is in scope.

**Shape (accepted cuts/merges — 8 tasks → 6):**

- T1 stays alone (it moves `user_version` on live DBs — reviewable solo).
- T2+T4 merge (predicate + mint land with the predicate's one real
  caller; kills the dead-export window and the double-edit of
  `verification.ts` — PT2/PT4). `membership.ts` also gains
  `memberRowsPage` + `healMembers` (F2, fold item 3).
- T8 dissolves into T7 (PT1): checklist row + gates are steps, not a task.
- PT5: `logical-membership.test.ts` deleted; the one direct test
  (blocked-candidate-wins) lives in the mint suite.
- PT6: cascade tests extend `source-lifecycle.test.ts` (two optional
  params on `insertSourceRow`) and `source-federation.test.ts` — zero new
  test files.
- PT8: schema pins live in `source-schema.test.ts`; the duplicate
  user_version pin drops.
- PT10: counts return two numbers; the third is subtraction.
- PT11: `?expand=` picked in-plan; the full-reload cost stated as
  accepted.
- F9: the four admin-only leak-guard lists each gain the new field name.
- F8/F10/F11/F12/F13/PT14/PT15: mid-array warning verbatim in the
  migration comment; TESTING.md container idioms in every Run line;
  imports/compile fixes in the paste-ready snippets; the three-literals
  note; the half-sentence deleted.

## Verified clean (do not re-litigate)

Spec-rev pointer exact (rev 3 @ `8e894db`); every rev-3 mechanism carried
(action-based cascade, one factored function at both call sites,
per-member pending activation, overridden-flip exclusions, mint rule,
membership on federation status alone, one instance audit row with
moved-count, one journal reset); tail-append at 18 with all four
migrations.test pins named; DEFAULT 1 keeps every existing INSERT valid
with only the mint INSERT touched; no fingerprint/command-kind changes;
all-GET routes correctly need no jsonWrite; staged sets complete with no
missing files; prefix normalization byte-agreement verified across both
normalizers; `activatePendingSubscriptions` reachable (members are
single_publisher); write-side cascade leaves the read paths and purge
untouched.

## Handoff

Fold as plan rev 2 in one commit (spec edge-amendment F14 rides along),
then execution may start. The reviewer session spot-reviews per task as
usual; the cascade task (old T3) is the risk center and gets the deepest
look.
