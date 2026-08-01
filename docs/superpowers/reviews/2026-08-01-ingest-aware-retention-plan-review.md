# Review — Ingest-Aware Retention Phase 1 *Plan* (2026-08-01)

Reviewer: clean-context. Plan under review:
`docs/superpowers/plans/2026-08-01-ingest-aware-retention-phase1.md`
(spec Rev 2 + spec-review folded). Code read at current `main` (post-`00bc235`).

## Verdict

The core mechanism is correct and verified against the real code: Task 1's
`raw_evidence.published` read restores content-date sort, Task 2's gate on the
`!existing` branch (before line 633) genuinely suppresses delivery+version+job,
the `pub && pub <= arrival ? pub : arrival` formula is identical in both tasks,
all ISO-string comparisons are format-compatible (`normalizeUtc` and
`committedAt` are both `.toISOString()`), the required scopes (`obs.rawEvidenceJson`,
`committedAt`, mutable `counters`) are present at the gate, and the TDD red/green
is valid on the existing `acquire`+`drain` harness. **But the plan is NOT
executable as-is: it under-counts the `commitAcquisition` call sites, so adding a
required `maxAgeDays` to `CommitAcquisitionInput` breaks `tsc` at two sites the
plan never touches (MF1).** One correctness gap (verification's `EMPTY_COUNTERS`
drift, I-A) and one over-scoped/under-specified task (Task 3 getSetting plumbing,
I-B) must also be settled. Fix MF1 and I-A, trim I-B, and Tasks 1–2 are ready.

## Findings

### Critical

**MF1 — `CommitAcquisitionInput.maxAgeDays` breaks `tsc` at two un-named call
sites. (must-fix-before-executing)**
The plan (Task 2 Step 3) makes `CommitAcquisitionInput` gain `maxAgeDays: number`
(required) and names **three** constructing call sites: `acquisition.ts:767`
(real commit) + `:828`/`:831` (terminal). There are **five**: also
`acquisition.ts:835` (`not_modified`) and `:841` (`bodyLimitExceeded`). Both
construct a full input literal; with a required field, `tsc` fails at 835 and 841
at the end of Task 2 — exactly the class of silent break the plan's own "always
run tsc" note is guarding against. (`store.ts:428` forwards a typed `input`, no
literal; grep confirms no test constructs `CommitAcquisitionInput`, so tests are
unaffected.)
Fix — pick one:
- **(A, lazier, recommended)** make it optional: `maxAgeDays?: number`; gate reads
  `(input.maxAgeDays ?? 0) > 0`. Touches only site 767 (the one that carries
  observations); the four terminal sites carry empty observations so the gate
  never runs there — leave them untouched. Smallest diff, immune to the
  enumeration trap.
- **(B)** keep it required and add `maxAgeDays: 0` to **all four** terminal sites
  (828/831/835/841).

### Important

**I-A — `verification.ts` `EMPTY_COUNTERS` is dropped; counter shape drifts across
run kinds. (must-fix-for-correctness, not tsc-blocking)**
The plan adds `retentionFiltered` only to `ZERO_COUNTERS` (`acquisition.ts:460`)
and the `AdminAcquisitionCounters` type. The spec review's M1 explicitly flagged a
**second** literal: `EMPTY_COUNTERS` (`verification.ts:239`), a `JSON.stringify({…})`
of the same nine fields written into the synthetic verification run's
`counters_json`. Because it is an untyped `JSON.stringify` argument (not
`: AdminAcquisitionCounters`), `tsc` will **not** catch the omission — but every
verification-origin run then stores a `counters_json` missing `retentionFiltered`
while acquisition runs have it, so any admin projection reading the field across
run kinds gets `undefined` for verification runs. Add `retentionFiltered: 0` to
`EMPTY_COUNTERS`. The plan should name it; today it is silently dropped.

**I-B — Task 3's `getSetting` plumbing into the verification runner is
under-specified and likely disproportionate. (must-decide-before-executing Task 3)**
Confirmed: the `verification.ts` insert (~345–360) **can** create a new delivery
(`if (existingDelivery) bump … else INSERT deliveries_v2`). But two facts the plan
omits change the calculus:
1. It runs in the **async** `runVerificationBatch` path — a different construction
   site than `createAcquisition`. Its input object
   (`{itemId, sourceId, publisherId, match, commandId, batchKey, now}`) has no
   `maxAgeDays` and no `getSetting`; "plumb `maxAgeDays` here the same way" is real
   wiring the plan hand-waves, not the one-liner Task 2's site is.
2. **Task 2 already covers the common case upstream.** `scheduleVerification`
   fires only from `reconcileClaim` (reconcile.ts:342-343). An out-of-window
   aggregate item gated by Task 2 is never reconciled → verification is never
   scheduled for it. The only residual is "in-window at ingest, aged out before the
   batch runs," which creates a *different* origin-keyed delivery — precisely
   review I2's low-risk, non-looping case.
Recommendation: the executor should strongly favor the plan's own
"**no code change + a comment/test asserting current behavior + close**" branch,
and must NOT build the getSetting-into-the-verification-runner wiring unless a real
loop is demonstrated. Do not extract the shared helper on spec (see M-C).

### Minor

**M-A — after Task 1, `material` is a dead parameter of `createRemoteItem`; the
plan's rationale for keeping it is false.**
`material.published` (reconcile.ts:378) is the **only** use of `material` inside
`createRemoteItem` (verified: title/content are handled in `applyPresentation`,
not here). The plan says "Leave `material` for its other uses (title/content)" —
there are none in this function. It is harmless for `tsc` (`noUnusedParameters`
is **not** set; base tsconfig only enables `strict`), so leaving it compiles, but
the justification is wrong and the param is genuinely dead. Either drop it and
update call sites reconcile.ts:300 and :307, or leave it and correct the comment.
Not blocking.

**M-B — `counters.candidates`/`seen` are incremented before the gate.**
`acquisition.ts:629-630` run `counters.candidates++; counters.seen++` *before* the
`findDelivery` lookup (632) where the gate inserts. A gated item is therefore
counted in `candidates`, `seen`, **and** `retentionFiltered`. `candidates` = "what
the feed served" is defensible; `seen` = "deliveries seen" is arguably wrong for an
item that creates no delivery. Decide deliberately and note it; not blocking.

**M-C — `isWithinAgeWindow` shared-helper extraction is premature (YAGNI).**
The plan couples extracting/exporting `isWithinAgeWindow` to Task 3. If Task 3
makes no change (likely, per I-B), the helper has exactly one caller and the
export is dead abstraction. Inline the 4-line gate in Task 2; extract only if
Task 3 actually adds the second caller.

### Nit

**N-A — the stale reconcile test (spec-review C2) stays green after the fix and
remains dead.** `seedJob` (reconcile test:66,70) hand-builds *both*
`canonical_material` and `raw_evidence` with `published`, so the existing
`timelineSortAt` test (324-334) passes before **and** after the change while still
exercising a shape production no longer emits. The plan's new real-pipeline test
(Task 1 Step 1) is the correct fix; optionally also drop `published` from
`seedJob`'s `canonical_material` since it is now never read.

## Correct as written — don't churn

- **Gate placement** — `!existing && input.maxAgeDays > 0` inserted after
  `findDelivery.get` (632) and before `const deliveryId` (633), `continue` skips
  `insertDelivery`/`insertVersion`/`insertJob`. Verified against 627-658: no other
  path re-creates the row within the loop.
- **Date-string comparison** — `committedAt` = `now()` = `.toISOString()`;
  `normalizeUtc` returns `new Date(t).toISOString()` or `null` (and `null`/`''`
  ⇒ dateless ⇒ arrival, preserving today's behavior); cutoff = `.toISOString()`.
  All three are canonical UTC ISO, so `<`/`<=` string compares are valid. No
  timezone/format mismatch.
- **One-content-date consistency** — Task 1 (reconcile) and Task 2 (gate) use the
  identical `pub && pub <= arrival ? pub : arrival`, `pub` from
  `raw_evidence.published`. Matches the runtime trim's date source.
- **Plumbing** — mirrors `runtime.ts:421`
  (`Number((await getSetting('max_remote_item_age_days')) ?? '0')`) exactly: same
  key, same `repo.getSetting` (`repository.ts:15`, `Promise<string|undefined>`,
  already consumed by the runtime at `server.ts:44`). `server.ts:37`
  `createAcquisition({ db, getSetting })` is feasible and idiomatic.
- **TDD red/green (Task 1)** — driving a `<pubDate>`-bearing RSS item through the
  real `acquire` helper (test lines 48-52) + `drain` is achievable:
  `canonicalMaterialFor` omits `published`, so current code reads
  `material.published === undefined → arrival` (RED), and the fix reads
  `raw_evidence.published` (GREEN). The neighboring `acquire` helper shows the
  harness.
- **Scope** — deferring the count-cap gate + `content_sort_at` schema to Phase 2 is
  the correct minimal cut for the age-driven live incident; nothing in Phase 1 is
  heavier than needed (modulo M-C).
- **`maxAgeDays = 0` inert / existing-delivery edits never gated** — both hold by
  the `!existing && … > 0` guard.
