# Admin /admin/feeds action-surface redesign

Status: rev 2 (2026-07-30) — folds ponytail-review + ponytail-audit findings:
cut the shared note field (scope creep against this spec's own Goals), fixed
a real correctness gap in Component 1 (`bulkActions()` must fold in
`data.expandedMembers`, not just `group.rows`, once members share the
selection), made the deletion's full blast radius explicit (a now-unused
type alias, dead CSS, three now-invalid tests to replace rather than leave
in place), and folded in a cheap in-passing dedup of three duplicated
outcome-list blocks since this redesign already restructures that area. See
Revision history.

## Motivation

Live use of `/admin/feeds` (dogfooded right after the source-management redesign
shipped) surfaced a real interaction problem the previous redesign introduced
without noticing: every governance verb (pause/resume/quarantine/allow/
approve/reject/revoke/block/unblock) is now reachable from **two** separate,
simultaneously-visible surfaces per group:

1. An always-visible top "bulk bar" offering the union of verbs across every
   row in the group, plus a shared category `<select>` and (for block/unblock)
   a confirm-gate.
2. Every single row's own "Manage" `<details>` disclosure, containing the
   *same* verbs again as separate per-row forms, each with its own category
   select, optional note field, and confirm-gate.

The bulk bar was new in the source-management redesign; the per-row Manage
panel pre-dates it. Layering one on top of the other without reconsidering
whether both should coexist produced exactly the effect reported: for the
common case (acting on one row), the page shows a full button wall at the top
of the group *and* requires opening Manage to find the same verbs again per
row. Busy, noisy, and redundant.

## Goals

1. One surface for triggering any governance verb, for one row or many — not
   two copies of the same button set.
2. That surface is collapsed by default, so the page's resting state is quiet
   (rows + a collapsed disclosure), not a permanent wall of buttons.
3. Preserve the no-JS invariant this session already had to fix once: the
   surface's buttons/candidates must be reachable and functional with
   JavaScript off — a native disclosure, not JS-gated visibility.
4. Preserve moderation parity for nested federation-member rows (the C1 fix
   from an earlier review: a member is moderated through the exact same
   mechanism as an ordinary row, never a read-only view) — this redesign must
   not silently regress that.

## Non-goals

- Orphans' and tombstones' sections are untouched. They never had the
  Manage-panel-plus-toolbar duplication (each row already has exactly one
  plain confirm-gated form, no separate disclosure) — this redesign is scoped
  to the ordinary governance groups (federation/quarantine/allowed/blocked)
  where the duplication actually exists.
- `/admin/users`'s bulk-delete UI is untouched.
- The checkbox-sizing bug (`web/src/app.css:771`'s global `input, textarea,
  select` rule has no `type="checkbox"` exclusion, stretching every checkbox
  to `width:100%; min-height:36px`) is a separate, already-diagnosed CSS fix,
  unrelated to this redesign. Fixed alongside this work, not as part of the
  design.
- No change to `bulkSource`'s server-side shape, candidate encoding, or any
  other bulk/reap/tombstone/delete server action from the prior redesign —
  this is a `web/`-side markup/interaction reorganization over the same
  actions.
- No change to the single-row `reap`/`tombstone`/`purge`/`deleteUser` forms
  outside `feeds/+page.svelte`'s ordinary groups.

## Components

### 1. Remove the per-row "Manage" disclosure

`managePanel` (the shared snippet rendering `<details class="panel"><summary>
Manage</summary>...`) is deleted for ordinary rows. The row itself becomes:
checkbox, URL + badges, "Details (run history, items, purge)" / "Run history"
links, and (for federation rows) the member-count rollup line. No per-row
action forms remain.

**Nested federation-member rows keep parity, per Goal 4:** members
(`data.expandedMembers`) gain the same checkbox the ordinary rows have,
wired to the *same* group's shared panel form (`form="bulk-{group.key}"`) —
their `commandId`/action shape from `toRow()` is already identical to an
ordinary row's, so they compose into the same selection and the same shared
panel without a separate code path. A member is selected and acted on
exactly like any other row in its group; nothing about being nested changes
how it's moderated.

**Correction (rev 2):** `bulkActions(group)` (`+page.svelte:163-167`) computes
the verb union/narrowing by reading `group.rows` alone — `data.expandedMembers`
is a separate array, so a checked member wouldn't be seen when the shared
panel narrows its offered verbs to "only what every checked row has in
common." `bulkActions` needs to fold `expandedMembers` into that computation
wherever a member is checked, not just filter `group.rows`. Without this fix,
checking a member and only a member would either narrow to nothing (if the
filter treats an unmatched selection as empty) or silently ignore the
member's selection — either way, not what Goal 4 requires.

**Full deletion scope, made explicit so nothing is left half-removed:**
`type Row` (`+page.svelte:173`, whose only consumer is `managePanel`'s
parameter), the C1/N1 explanatory comments (`:169-172`, `:434-440`) that
exist solely to justify `managePanel`'s sharing/scoping, and the
`.source-actions` (plural) CSS rule (`:819-823`, whose only consumer is
`managePanel`'s wrapper `<div>`) all go with it. `.source-action` (singular)
stays — it's shared by the orphan-reap and tombstone-unblock forms, both
out of scope per this spec's Non-goals.

### 2. The shared panel: single surface, collapsed by default

The existing "bulk bar" (buttons + category select + block/unblock
confirm-gates) becomes the *only* place any of these verbs is triggered, for
a selection of one row or many — same mechanism, same code path, just a
different count of checked boxes.

It wraps in a native `<details class="panel"><summary>▸ Actions</summary>
...</details>`, collapsed by default — the same disclosure primitive already
used for the mobile nav panel and every `.confirm-gate` on this page. This is
the actual fix for "busy/noisy," not just de-duplication: the resting page
shows rows and a collapsed one-line disclosure per group, not a permanent
button wall. Expanding needs no JavaScript (native `<details>`), so nothing
about the no-JS invariant changes — the buttons and self-describing checkbox
`value`s inside stay exactly as reachable as they are today once expanded.

**Cut in rev 2: no shared note field.** The original rev 1 draft proposed
adding one because `bulkSource` happens to already read a `note` form field
— but none of this spec's Goals call for it, and an extra input works
against Goal 2 (a quieter resting state), not toward it. Dropped from this
redesign; if wanted later, it's a one-line follow-up in `ideas.md`, not
bundled into a noise-reduction spec.

### 3. `attribution-mode` moves to the inline detail panel

`attribution-mode` cannot join the shared panel — changing it needs a
per-row value (single_publisher vs aggregate), not a bulk toggle; it was
already excluded from bulk in the source-management redesign for exactly
this reason. It moves into the row's existing inline `?detail=` panel
(refresh/status/items/purge, from the prior redesign's Task 9) — the panel
that already exists specifically for single-row-only extras. This gives the
whole page exactly two homes for actions: the shared panel for anything
bulk-eligible, the detail panel for anything that structurally can't be.

### 4. (rev 2, in passing) One shared outcome-list snippet instead of three copies

`+page.svelte` has three structurally identical blocks rendering a bulk
action's per-row outcomes — `bulkResults` (governance), `bulkReapResults`
(orphans), `bulkTombstoneResults` (tombstones) — each the same
`{#if X?.length}<ul>…{:else if X}<p>Nothing selected.</p>{/if}` shape,
differing only in the id-field name (`sourceId`/`tombstoneId`) and the
done-word (`done`/`reaped`/`unblocked`). Since this redesign is already
restructuring the panel area these blocks sit next to, collapsing the three
into one `{#snippet bulkOutcomes(results, idKey, verb)}` (called three times)
is a cheap in-passing cleanup, not a separate effort. Orphans/tombstones stay
out of scope for everything else in this spec (Non-goals) — this snippet
covers their existing outcome-list markup unchanged in behavior, just
de-duplicated.

## Testing

- Render tests: the shared panel is collapsed by default (`<details>` with
  no `open` attribute) in every fixture; expanding it reveals the same verb
  set the current bulk bar tests already pin. No per-row Manage disclosure
  markup remains anywhere in the ordinary-groups output.
- A federation-member row (`data.expandedMembers`) carries a checkbox wired
  to the same group's `form=`, and submitting its group's shared panel with
  only the member checked posts the member's own id — same assertion shape
  the existing "member row carries a working governance action" test already
  uses, adapted to the new selection mechanism instead of a per-row form. A
  second test covers the rev-2 `bulkActions` fix directly: with only a member
  checked (no ordinary row), the panel narrows to that member's own verbs,
  not to nothing and not to the group's full union.
- `attribution-mode`'s new home in the detail panel: a render test confirming
  the mode-change form appears in the inline panel and posts to the existing
  `source` action with `action=attribution-mode`.
- No-JS regression coverage: reuse the existing chunk-isolation pattern to
  confirm the shared panel's buttons/checkboxes are present in the collapsed
  `<details>`'s content (not stripped from server output just because it's
  visually collapsed) — collapsed `<details>` content is still real DOM,
  same principle every `.confirm-gate` on this page already relies on.
- The three now-invalid tests (the C1/N1 member-manage-panel tests, and the
  two per-row confirm-gate isolation tests whose premise — "the row's own
  gate is the last one in the document" — no longer holds once there's no
  per-row gate) are **deleted, not left in place** covering markup that no
  longer exists. They're replaced by the member-checkbox/shared-panel tests
  above, not supplemented by them.
- The `bulkOutcomes` snippet (Component 4): one test confirming all three
  call sites (governance/orphans/tombstones) still render their existing
  outcome text and "Nothing selected." fallback unchanged — a pure
  refactor, so this is a behavior-preservation check, not new coverage.

## Rollout

Web-only, markup-only change confined to `web/src/routes/admin/feeds/
+page.svelte` — no server-action changes; every field this redesign uses
already exists and is already read server-side. No migration, no feature
flag — this is an operator-facing admin surface, ships as an ordinary
change.

## Revision history

- rev 1 (2026-07-30): initial design, from live dogfooding feedback on the
  source-management redesign that shipped earlier the same day.
- rev 2 (2026-07-30): folds ponytail-review + ponytail-audit findings
  (dispatched to two clean subagents, both verified their factual claims
  against the current tree before I applied anything). Cut the shared note
  field — ponytail-review correctly called it scope creep against this
  spec's own Goals, added only because `bulkSource` happens to already
  accept one, not because any stated goal needed it. Fixed a real
  correctness gap ponytail-review found: `bulkActions()` only reads
  `group.rows`, not `data.expandedMembers`, so a checked member's verbs
  wouldn't be seen when narrowing — Component 1 now calls this out
  explicitly with a test. Made the deletion's full blast radius explicit
  per ponytail-audit (a now-orphaned `type Row` alias, the C1/N1
  explanatory comments, the `.source-actions` plural CSS rule, and three
  now-invalid tests that must be deleted rather than left covering dead
  markup). Folded in ponytail-audit's cheap in-passing find: one shared
  `bulkOutcomes` snippet replacing three structurally identical outcome-list
  blocks (Component 4), since this redesign already restructures that area.
  Two ponytail-audit findings were considered and explicitly NOT folded in,
  per the audit's own calibration: deduplicating `bulkSource`/`bulkReap`/
  `bulkTombstone`'s try/catch shape (marginal win, reopens a prior
  deliberate decision to keep the three candidate encodings as separate
  one-liners) and merging the three bulk-bar blurb blocks (differ enough in
  real content that a shared snippet would trade a clear diff for a
  parameterized one).
