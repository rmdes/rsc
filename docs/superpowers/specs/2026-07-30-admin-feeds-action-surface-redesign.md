# Admin /admin/feeds action-surface redesign

Status: rev 1 (2026-07-30)

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

**Gains a shared, optional note field.** `bulkSource` already reads and
forwards a `note` form field (found during this session's earlier
whole-branch review — nothing in the UI ever sent one). Adding one input to
the shared panel, applied uniformly to every row in the current selection,
is a pure UI addition — no server-action change, since the field is already
read and forwarded today.

### 3. `attribution-mode` moves to the inline detail panel

`attribution-mode` cannot join the shared panel — changing it needs a
per-row value (single_publisher vs aggregate), not a bulk toggle; it was
already excluded from bulk in the source-management redesign for exactly
this reason. It moves into the row's existing inline `?detail=` panel
(refresh/status/items/purge, from the prior redesign's Task 9) — the panel
that already exists specifically for single-row-only extras. This gives the
whole page exactly two homes for actions: the shared panel for anything
bulk-eligible, the detail panel for anything that structurally can't be.

## Testing

- Render tests: the shared panel is collapsed by default (`<details>` with
  no `open` attribute) in every fixture; expanding it reveals the same verb
  set the current bulk bar tests already pin. No per-row Manage disclosure
  markup remains anywhere in the ordinary-groups output.
- A federation-member row (`data.expandedMembers`) carries a checkbox wired
  to the same group's `form=`, and submitting its group's shared panel with
  only the member checked posts the member's own id — same assertion shape
  the existing "member row carries a working governance action" test already
  uses, adapted to the new selection mechanism instead of a per-row form.
- `attribution-mode`'s new home in the detail panel: a render test confirming
  the mode-change form appears in the inline panel and posts to the existing
  `source` action with `action=attribution-mode`.
- The shared note field: `bulkSource` already has test coverage for
  forwarding a non-empty `note` — no new server-action test needed, only the
  render test confirming the new input posts to the `note` field name
  `bulkSource` already reads.
- No-JS regression coverage: reuse the existing chunk-isolation pattern to
  confirm the shared panel's buttons/checkboxes are present in the collapsed
  `<details>`'s content (not stripped from server output just because it's
  visually collapsed) — collapsed `<details>` content is still real DOM,
  same principle every `.confirm-gate` on this page already relies on.

## Rollout

Web-only, markup-only change confined to `web/src/routes/admin/feeds/
+page.svelte` — no server-action changes (`bulkSource` already reads
`note`; every other field this redesign uses already exists). No migration,
no feature flag — this is an operator-facing admin surface, ships as an
ordinary change.

## Revision history

- rev 1 (2026-07-30): initial design, from live dogfooding feedback on the
  source-management redesign that shipped earlier the same day.
