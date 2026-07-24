# Cross-vertical contract COMPLETION gate — RSC source-governance milestone (2026-07-24)

V4 plan Task 12 in its **completion-gate form**: the counterpart to the
2026-07-23 plan-stage gate (which verified the four PLAN documents before code
existed, verdict GATE OPEN). This instance verifies the same frozen
cross-vertical contracts hold in the **shipped code of V1+V2+V3+V4 as a unified
whole** — proving each against file:line in source, not plan text. Motivated by
two facts: no prior review checked all four verticals' code *together*, and V4
landed the live-path h-feed keying fix AFTER its own whole-vertical review.

- **HEAD reviewed:** `9175947` ("plan: record the live-path keying correction")
  — one docs-only commit past the assigned `8302eb3` ("core: converge h-feed and
  converted delivery keys"); the code is byte-identical to `8302eb3`, only the
  V4 plan doc advanced. `8302eb3` is an ancestor of HEAD.
- **Controller-verified (not re-run here):** core 97 files / 1063 pass + 2
  expected-fail; typecheck 0; lockstep canary green. This is a contract/document
  review; each contract is spot-grepped and cited.

## Verdict: GATE CLOSED — contracts hold in code.

No contract is violated in shipped source. One Minor documentation follow-up
(F1 below: the two `test.fails()` comments name the wrong flip point). It is a
comment correction, not a code contract violation, so it does not hold the gate;
folding it is a numbered follow-up.

## Checklist walked against code

**1. Wide SQL CHECKs / narrow TS enums — re-verified IN CODE (carried item C).**
This is the milestone's dominant historical defect class, so it was re-confirmed
at the schema source, not merely inherited from the plan gate:

| Constraint | Code | Width |
|---|---|---|
| `source_audit_v2.category` | `sqlite.ts:1409` | nine (V1 table, in sqlite.ts not schema.ts) |
| `source_audit_v2.actor_kind` | `sqlite.ts:1407` | incl. `operator_token` |
| `command_ledger_v2.actor_scope` | `sqlite.ts:1413` | incl. `ops` |
| `item_audit_v2.category` | `schema.ts:231` | nine |
| `blocked_source_tombstones_v2.category` | `schema.ts:257` | nine |
| `presentation_entries_v2.provenance` | `schema.ts:100` | three, incl. `legacy_unknown` |
| `acquisition_runs_v2.reason` (exception, WP1) | `schema.ts:130` | two — stays narrow |
| `push_subscriptions_v2.state` (exception, WP1) | `schema.ts:299` | two — stays narrow |

The two deliberate exceptions are documented in-code at `schema.ts:276-287` with
spec refs so a future editor cannot widen them.

TS enums narrower-or-equal, with the runtime narrowness where it bites:
- `AuditCategory` (`domain/types.ts:113-115`) is now **nine** in TS —
  **not eight**. The controller's "eight in TS" example is a stale V3-era
  snapshot: progress.md:831 records AuditCategory as eight during V3 with
  `migration_review` *deferred to V4*; V4 added `migration_review`, so TS is
  correctly nine == the CHECK. This is the intended V4-final state, not a
  violation — narrowness never required TS < CHECK, only CHECK ≥ every TS enum
  ever, so no widening needs a migration.
- The remaining narrowness lives in the **runtime input allowlists**, both
  narrower than the nine-wide CHECK and both typed `AuditCategory[]` so a
  narrowed union member fails typecheck at the allowlist: the item-audit route
  allows **eight** (`logical-routes.ts:56`, excludes `migration_review`), and
  the source-audit route allows **six** (`app.ts:61`). `migration_review` is
  written by conversion and accepted by no route — exactly as designed.
- `updatedAtProvenance` = `'explicit'|'arrival'|'legacy_unknown'|null`
  (`logical/types.ts:74,144`), matching the three-wide CHECK; the web wire
  mirror agrees (`web/src/lib/logical-types.ts:43,83`).

**2. Capability supersession chain frozen.** `/capabilities` (`app.ts:155-159`)
exposes V2's exact enabled shape `{sourceModelV2:true, model:'logical-v2',
journalCursorVersion, streamProtocolVersion}` and the flag-off `{sourceModelV2:
false}`. V4 added no field to it — the V4 flip is a value change on the frozen
shape, core-only. HOLDS.

**3. Command conventions uniform.** `commandId` travels in the JSON body ONLY,
never a header — asserted in code and comment at `app.ts:384,389-390`.
Fingerprints follow `[command, resource, actor, semantic-payload]`; the V4 ops
route reuses V1's federation fingerprint verbatim —
`fingerprintRequest([FEDERATION_OPERATION, canonicalUrl, input.attributionMode])`
with `FEDERATION_OPERATION='federation'` (`source-service.ts:16,212`). `jsonWrite`
is defined once and exported (`app.ts:124`) and composed by import at every write
route including `/ops/sources/federation` (`app.ts:422`); grep finds no second
definition anywhere in `core/src`. HOLDS.

**4. Lockstep amendments landed in code.** Provenance three-wide CHECK (item 1);
`push_capability_json` is the V2 `acquisition_runs_v2` column the parse-time
claim binds to (`schema.ts:137`), not a new relation; `policy_generation` owned
by V2 as `ALTER TABLE remote_sources_v2` inside the V2 block (`schema.ts:186`,
before the V3 block at :219). HOLDS.

**5. Declared supersessions are declared, not silent drift.**
`AttributionLevel` four-level (`logical/types.ts:23-25`); `ReconciliationClaim`
observation|verification union (`logical/types.ts:526-528`);
`establishFederation` actor-kind widened to `'administrator'|'operator_token'`
in **both** `SourceRepository` (`source-repository.ts:132` decl) **and**
`SourceService` (`source-service.ts:46` interface + `:201` impl), each carrying
the "widened with the audit vocabulary (V4 §6)" comment; `updatedAtProvenance` +
`legacy_unknown` as above; the capability shape as item 2. HOLDS.

**6. No vertical leaks in code.** Flag-OFF isolation is behavioral, not
load-level (v2 modules statically load with the flag off — expected; behavior is
gated by `if (deps.logical)` / `if (sources)` composition). Push renewal rides
the single existing scheduler tick (`scheduler.ts:31-46` comment; the only timer
is the self-rescheduling poll `setTimeout` at `scheduler.ts:65,110`) — **no third
scheduling loop**. `push: PushLifecycle | undefined` is required-but-nullable so
the flag-off runtime passes `undefined`. **No findings relation**: conversion
findings are the `conversion_findings_json` COLUMN on `logical_activation_v2`
(schema grep), not a table. **No new sanitizer path** (V4 touched
convert/acquisition/discovery/ingest — none is a sanitizer; the markdown/render
twins are untouched and the lockstep canary is green). **No new dependency**:
`core/package.json` gained none in the V4 wave (Task 4's package.json diff adds
only scripts; the deps block carries no push/migration library). HOLDS.

## Carried items

### A. The document-drift class — named, split into two modes

This milestone produced ~ten dated corrections. They are one class with two
distinct failure modes, both visible in progress.md and its plan-correction
blocks:

**Mode (i) — plan text diverging from code.** The plan prescribes a symbol,
line, or behavior the shipped code does not have. Instances: `installV4Schema`
(plan Appendix A `:238,:889` — **never existed**; code spreads a
`LOGICAL_V4_SCHEMA` constant into `MIGRATIONS` at `sqlite.ts:1436`, exactly like
V2/V3, verified `grep installV4Schema core/src` → not in code); the three
incomplete Appendix-C staged lists (Tasks 8/9 landed files the rows omit —
`app.ts` not `logical-routes.ts` for the ops route, etc.); the `push-in.ts:272`
miscite; the stale `config.ts:44-45` pointer; the "lookup response gains a shape"
that was actually a NEW `GET /handles/:handle` route; "POST /users stops being
routed". **Lesson: verify before trusting.** Executed plans are historical
records (per CLAUDE.md they are not rewritten when files move), so their body
text legitimately drifts from code — a completion gate must prove each contract
at file:line in source, which is why this gate did.

**Mode (ii) — a "verified" claim that was false.** A review asserted something as
checked when it was not. Instances: **FC2's "no FK engaged — verified"** —
`run_id` is an ENFORCED foreign key (`ON DELETE RESTRICT`) in four places
(`schema.ts:141,161,167,175`); following the claim literally would have made
every converted item invisible. **V2's `AdminSourceAcquisitionSummary` recorded
as shipped** when it never was. **Lesson: "verified" in a review must carry its
evidence (a command, a file:line, an output) or it is only a stronger-sounding
assertion.** This gate treats "verified" as a citation obligation, not a word.

**Internal consistency now.** The corrections are recorded as dated plan-
correction blocks in the V4 plan and dated review docs (e.g.
`2026-07-24-v4-task-1-plan-corrections.md`). Consistency is achieved by those
correction notes, NOT by editing the historical plan bodies — so
`installV4Schema` still stands at plan `:238,:889` by design, with its correction
recorded alongside. Given the "don't rewrite executed plans" convention, the
document set is internally consistent: every drift has a dated correction, and
the code (the authority this gate used) is correct throughout.

### B. The `test.fails()` marker flip-point — pinned

The two markers (`core/test/ingest.test.ts:406`,
`core/test/federation-live.test.ts:149`) each construct a **v1** repository
flag-off and call the **v1** ingest path directly (`ingestItems` /
`ingestRemoteUser` on `createSqliteRepository` / v1 `createApp`), asserting the
known v1 duplicate-then-unthreadable bug still reproduces. The V2 logical model
fixes the same scenario but only under the flag (positive proof lives in
`logical-vertical.test.ts`).

**True flip point: Task 11 (legacy v1 retirement), NOT Task 8's cutover.** Task 8
flips the runtime default to v2 for converted databases but does not change or
remove `ingestItems`/`ingestRemoteUser`; these tests build their own flag-off v1
repos and call that path directly, so the v1 bug still reproduces after Task 8
and the markers stay expected-fail. Only Task 11 ("core: retire the legacy v1
branch", a separate release, not yet executed at this HEAD) removes the v1 ingest
path these tests exercise — at which point they can no longer reproduce the bug
and must be flipped/retired. The v1 path still exists at HEAD, so the markers are
correctly still fenced.

**Documentation finding (F1, Minor).** Both in-code comments say the marker flips
"at the V4 cutover" and name it "the V4 cutover, when this marker flips to
test()" (`ingest.test.ts:400-401`, `federation-live.test.ts:145-146`). "The V4
cutover" reads as Task 8, but the actual removal of the exercised v1 path is
Task 11. The comments should name **Task 11 / legacy-v1-branch retirement** as
the flip point, so the markers do not outlive their meaning.

### C. Wide-CHECK/narrow-enum, re-verified in CODE at completion

Stated explicitly: item 1 above was re-proven against the shipped schema
(`sqlite.ts` for the V1 tables, `schema.ts` for V2/V3/V4) at completion — not
carried over from the plan gate — because it is the milestone's dominant
historical defect class. All eight CHECK widths hold, both WP1 exceptions stay
narrow and are in-code-documented, and TS/runtime narrowness sits where the
contract places it. RE-VERIFIED, holds.

## Findings

- **Critical:** none.
- **Important:** none.
- **Minor (documentation):** F1 — the two `test.fails()` comments name the wrong
  flip point (Task 8 cutover instead of Task 11 legacy retirement). See B.

No cross-vertical contract is violated in shipped code.

## Follow-ups (fold; not code-changed by this review)

1. **F1** — correct the flip-point in both `test.fails()` comments
   (`core/test/ingest.test.ts:395-405`,
   `core/test/federation-live.test.ts:138-148`): the markers flip at **Task 11
   (legacy v1 branch retirement)**, when the v1 ingest path they exercise is
   removed — NOT at the Task 8 V4 cutover. Pin Task 11 by name.
</content>
</invoke>
