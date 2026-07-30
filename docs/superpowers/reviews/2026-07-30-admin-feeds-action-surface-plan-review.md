# Admin /admin/feeds action-surface redesign — plan review (2026-07-30)

Target: `docs/superpowers/plans/2026-07-30-admin-feeds-action-surface-redesign.md`
(`badec29`, 905 lines, 4 tasks, off spec rev 2 `6441931`). Dual pass:
ponytail PT1–PT12 + fidelity F1–F16, adjudicated.

**Verdict: NOT READY — fold as plan rev 2.** Spec fidelity is otherwise
good (both rev-2 folds honored; the `bulkActions` correction is coded
correctly), but three findings are hard blockers an implementer hits inside
the first task — two of them PROVEN by rendering the page and measuring
offsets, one by reading the installed Svelte compiler's error list — plus
one undeclared contract regression the plan's "no server changes" framing
hides.

## Blockers (fix before execution)

1. **F1 — Task 2 Step 3 test 1 can never pass.** It anchors its chunk at
   `body.indexOf(memberRow().url)`, but post-`c17a3a6` the checkbox renders
   BEFORE the url (measured: url@1638, checkbox value@1546, form attr@1582),
   so the slice excludes everything it asserts. Anchor on the checkbox
   value (or `'Select ' + url`).
2. **F2 — Task 2 Step 3 test 3 can never pass.** `indexOf('</form>')` with
   no `fromIndex` finds the GET search form's close (@463) before the bulk
   form even starts (@540) → empty slice. Every existing test in the file
   passes `formStart`; match them.
3. **F3 — Task 2 Step 6 is a compile error.** The `{@const}` is placed as a
   child of `<section class="detail-panel">`; Svelte requires `{@const}` be
   the immediate child of a block/snippet (this file already documents the
   same trap at `+page.svelte:46-49`). Hoist it into the `{#if detail ===
   row.id && data.detail}`. Step 7's is legal.
4. **F5 — the spec's ordinary-row deliverable ships untested.** Spec
   Testing bullet 3 requires a render test for the mode-change form in the
   inline panel; Step 6 has no red test in an otherwise TDD plan. Same for
   bullet 1's "no Manage markup remains anywhere" (only the member-scoped
   assertion exists). Fixture note F11: `baseRow()` has no
   `attribution-mode` action, so the new test must extend it.

## Maintainer decision (do not let this be decided by silence)

**F4 — deleting `managePanel` unpins commandId retry for 9 of the 10
verbs.** The deleted snippet pinned per-action retry ids
(`+page.svelte:448`); the surviving checkbox path always carries a FRESHLY
MINTED id from `toRow()`, and `enhance`'s `invalidateAll()` re-runs `load()`
on every submit. So a retry after a lost response submits a DIFFERENT
command id — precisely the regression `source-actions.test.ts:184-213` and
design §11 exist to prevent. Only `attribution-mode` keeps pinning.
Choose explicitly and record it:
- **(a) Pin it:** carry `retryFail`'s id into the checkbox value for the
  failed row (small; keeps the contract intact), or
- **(b) Declare it:** state at spec level that bulk-path retries are
  deliberately unpinned, with the consequence written down (a retried bulk
  action can double-apply where the command was already ledgered).
My recommendation is (a) — this contract cost a Critical to establish, and
"the bulk path is the only path" makes it the ONLY retry story, not a
secondary one.

## Shape (accepted cuts — 4 tasks → 2)

- **PT1 — merge Tasks 2 and 3.** The plan's ordering rationale is factually
  false: they touch zero overlapping lines (2 = row/member/snippet region,
  3 = bulk-bar form body); the only coupling is one stale comment. The
  split buys two extra full-suite + svelte-check runs for nothing.
- **PT2 — Task 4 becomes the merged task's last step** (net ~11 lines, no
  new assertions by its own admission).
- **PT3 — Task 1 keeps the fix, drops the ceremony:** CSS-only, no test
  reads `app.css`; edit → commit, ideally landed before the plan starts.
- **PT4 — do not re-create the duplication being deleted.** Steps 6 and 7
  hand-write the same ~18-line attribution form twice, right after deleting
  `managePanel` for exactly that. Collapse to one
  `{#snippet attributionForm(row: Row)}` — and therefore KEEP `type Row`
  (Step 5 currently deletes it).
- **PT5 + F6 (independent convergence) — one mandated test is mistitled**:
  `selected` is client `$state`, unreachable from SSR, so the narrowing
  branch rev 2 targets is never exercised. Retitle honestly and delete the
  comment claiming coverage — or extract `bulkActions` as a plain function
  and unit-test both branches (preferred: it is the rev-2 correction's only
  real proof).
- **PT6 + F14 — Task 3's two tests collapse to one**; `not.toContain('open')`
  is a bare 4-char substring scan over arbitrary blurb text — assert
  `not.toContain('<details class="panel" open')` instead.
- **F9 + PT8 — Task 4's type-widening fallback is wrong as written**:
  needs `Partial<Record<'sourceId' | 'tombstoneId', string>>` (both keys
  required breaks all three call sites).

## Process and design-system gaps

- **F10 — no review gates.** No per-task checkpoint, no final whole-plan
  review; CLAUDE.md's flow requires both (the `## Self-Review` section is
  the author's checklist, not a gate). Add them.
- **F8 — MASTER.md is the UI source of truth and was never consulted.**
  Task 1 rewrites the exact `input, textarea, select` rule MASTER.md:323-337
  documents, without updating it; the plan never invokes the mandatory
  `ui-ux-pro-max` skill. Update MASTER.md in the same commit.
- **F7 — four identically-named `Actions` disclosures** with no
  distinguishing accessible name (a regression from the deleted panel's
  `aria-label="Manage {row.url}"`). Add a group-scoped label.
- **F16 — hit target:** 16×16 checkbox with 2px padding under MASTER.md's
  44px floor for action-row controls; pad the label, don't just size the box.
- **PT7 — Task 4 deletes a load-bearing comment** (why the empty-results
  branch exists, for the no-JS silent-page case). Move it into the snippet.
- **PT9/PT10/PT12/F12/F13/F15** — dead CSS after the collapse, two dead
  declarations in the new checkbox rule, stale comments surviving their
  subject (`+page.svelte:710-712`, `:739-742`, `feeds.render.test.ts:10-16`,
  `source-actions.test.ts:494-499`), the intra-task non-compiling window in
  Step 5, and the deliberate one-of-two test-deletion read (fine — flag it
  as intentional).

## Verified clean (do not re-litigate)

The staleness premise in the review brief was WRONG and is closed: the plan
sits on top of `c17a3a6` and every quoted snippet matches the post-fix tree
verbatim (both reviewers confirmed independently). Spec-rev pointer exact;
both rev-2 folds honored; the `bulkActions` fix itself correct (no
double-count — a blocked member already renders flat in `group.rows`).
No-JS contract preserved (submits and the `required` select both move inside
the same `<details>`; checkboxes stay outside, reaching the form by `form=`).
View-param forwarding and stale-selection clearing preserved. Server
untouched, so the per-row action-list equalities and the row-key guard need
no change. Staged paths right, no missing file. No new component, prop,
config, flag, or dependency. Baseline re-run in-container and confirmed:
**372/372 web, 41/41 in the render suite.**

## Handoff

Fold as plan rev 2 in one commit: blockers F1–F3 + F5, the F4 decision
recorded, the 4→2 task merge, PT4's shared snippet, and the process/design
gaps. Execution starts after the fold; this session reviews per task, with
the merged core task getting the deepest look.
