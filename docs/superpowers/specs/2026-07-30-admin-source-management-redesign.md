# Admin source-management UX redesign

Status: rev 3 (2026-07-30) — rev 2 folded ponytail-review findings (dropped
the invented `batchId`-derivation scheme, fixed a bulk-tombstone-unblock
contradiction, fixed bulk reap's per-row `force` shape, fixed an `?expand=`
collision). Rev 3 corrects two factual errors found while verifying
references for the implementation plan: `confirm.ts` is used outside
`/admin` too (not deletable) and the render tests never actually mocked
`confirm()` (there was nothing to remove). See Revision history.

## Motivation

`/admin/feeds` governs every remote source: federation, quarantine/pending,
allowed user sources, blocked sources, orphaned sources, and blocked/tombstoned
URLs — one 512-line page, four server actions. Dogfooding it as the actual
mechanism for day-to-day moderation surfaced a UX that fights the operator on
every routine task:

1. **The reap flow forces a pointless round trip.** `toOrphanRow`
   (`web/src/routes/admin/feeds/+page.server.ts:164`) already computes
   `retention` at load time from the exact same guard chain core's `reapSource`
   checks (`core/src/domain/source-repository.ts:250-265`:
   `has_subscribers` → `not_allowed` → `federated` → `admin_retained` →
   `audit_history` → `verified_origin_evidence`). An orphan row, by the SQL
   filter that produces the orphan list, can only ever be refused for the
   three force-liftable reasons — never `has_subscribers`/`not_allowed`/
   `federated`. So `retention !== 'reapable'` is a perfect, already-known
   predictor of whether force is needed — yet the "Reap anyway" form only
   appears *after* a plain attempt is submitted and core returns 409. One
   click today costs a submit, a 409, a full page reload, and a second click.

2. **Confirmation is doubled.** Design spec §10
   (`docs/superpowers/specs/2026-07-20-rsc-source-governance-moderation-design.md:561`)
   requires block/purge/unblock confirmations to state their distinct
   consequences — correctly implemented as inline, no-JS-safe
   `<p class="consequence">` text. `confirmSubmit()` (`web/src/lib/confirm.ts`)
   then wraps the same submit in a native `window.confirm()` that repeats
   nearly the same sentence. Reading the same warning twice, once on the page
   and once in a browser-chrome popup, is friction with no safety benefit.

3. **No bulk operations.** Every governance transition (pause, quarantine,
   block, etc.) is a full-page POST for exactly one source. Moderating ten
   sources in the same state is ten independent round trips.

4. **Source management spans three routes.** `/admin/feeds` (list) →
   `/admin/sources/[id]` (detail: refresh/status/items/purge) →
   `/admin/sources/[id]/runs` (history) for what is conceptually one task.

## Goals

1. Cut the reap flow from two round trips to one, using data the page already
   has.
2. One confirmation per destructive action, not two, with zero native popups.
3. Bulk governance transitions and bulk destructive actions (reap/purge/
   delete-user), scoped per group, with per-item outcome reporting.
4. Collapse list → detail into one route; leave history as its own route.

## Non-goals

- No change to `core/` — every fix here is a `web/` interaction-layer change
  over existing endpoints. No new core API, no new database work.
- No change to nav tabs, `design-system/rsc/MASTER.md` tokens, typography, or
  any non-admin page.
- No change to the idempotent-commandId invariant (spec §11) or the
  stated-consequence invariant (spec §10) — both are preserved, just
  re-homed into inline disclosure instead of a popup.
- No bulk variant for `establish` (federation) — it accepts a new URL each
  time, not a toggle on an existing row, so there's nothing to select in bulk.

## Components

### 1. Inline reveal-to-confirm (replaces `confirmSubmit()`)

Every destructive-action form on an admin page (`source` action's
block/unblock, `reap` plain and force, `tombstone` unblock, `purge`,
`deleteUser`) wraps its consequence text and submit button in a native
`<details>`/`<summary>` disclosure — the same primitive already used for the
mobile nav panel (`design-system/rsc/MASTER.md:515`):

- **Collapsed:** a `<summary>` styled as a plain button reading the action
  name (e.g. "Block").
- **Expanded (click, no JS required):** shows the existing consequence
  sentence and a distinct "Confirm block" submit button.
- **With JS:** `use:enhance` goes back to being a plain progressive-
  enhancement wrapper (AJAX submit, row-level update) — there is no confirm
  gate left to short-circuit.

**`web/src/lib/confirm.ts` is NOT deleted** — `confirmSubmit()` is also used
outside `/admin`, by the timeline's own admin-only "Remove this post"
affordance (`web/src/routes/+page.svelte:231`,
`web/src/routes/post/[id]/+page.svelte:104`), which is a non-admin page and
out of scope for this redesign. Only the five admin call sites stop
importing it: `feeds/+page.svelte`'s `source`-action block/unblock form, its
two `reap` forms, its `tombstone` form, `sources/[sourceId]/+page.svelte`'s
`purge` form, and `users/+page.svelte`'s `deleteUser` form — each drops its
`import { confirmSubmit } from '$lib/confirm'` line once its own
`use:enhance={confirmSubmit(...)}` is replaced by the `<details>` markup.
`feeds.render.test.ts` / `source-actions.test.ts` / `source-detail.test.ts`
lose their `confirm()`-mock setup for these forms and gain an assertion that
the consequence text is reachable without a popup. (`item-review.test.ts`
covers hide/restore, neither of which uses `confirmSubmit` today — no change
there.)

### 2. Reap flow — `web/src/routes/admin/feeds/+page.svelte` + `+page.server.ts`

`toOrphanRow` already returns `retention`. The template branches on it
directly instead of on a failed-attempt response:

- `retention === 'reapable'` → one "Reap" button, reveal-to-confirm, the
  existing generic `REAP_CONSEQUENCE` text, plain (non-force) form.
- `retention !== 'reapable'` → one "Reap anyway" button *from first render*,
  reveal-to-confirm showing `FORCE_REAP_CONSEQUENCE[retention]`, form already
  carries `force: true`.

Deleted: `showForceConfirm`, `reapFail`, `forceReason`, `GENERIC_FORCE_CONSEQUENCE`
(no longer reachable — the retention-driven branch always has a reason-specific
string), the dual `commandId`/`forceCommandId` per orphan row (one command id
per row is enough once there's one form, not two). The `reap` server action is
unchanged — it already treats `force` as an opaque flag.

### 3. Bulk actions

**Selection scope:** checkboxes are always visible, one per row, scoped to the
row's group (`federation`/`review`/`user`/`blocked`/orphans/tombstones) —
groups don't combine, since `availableActions()` is already governance-state-
dependent and a cross-group selection would have no coherent action set.

**Toolbar:** checking any row in a group swaps that group's static blurb
(`<p class="subnav">{group.blurb}</p>`) for a ruled action bar in the same
document position — no floating element, no reflow of the row list below:
`N selected · [action buttons for the intersection of checked rows'
availableActions] · Clear`. Orphans and tombstones get the same bar swapped
in over their own section blurb, offering bulk reap / bulk unblock
respectively.

**New server action — `bulkSource`, reusing existing per-row commandIds
(no `batchId`, no derivation):** every row already carries its own
`commandId` per action (`toRow`, `+page.server.ts:151`) or, for orphans,
`commandId`/`forceCommandId` (`toOrphanRow`, `:168-169`). The checkbox for
each row is paired with hidden fields carrying that row's *own already-minted*
id(s), so the bulk form submits parallel `sourceId[]`/`commandId[]` arrays
built entirely from what's already rendered — the same commandId a lone
submit of that row would have used. `bulkSource` loops over the pairs and
calls the same per-source core endpoint `source` already calls, one
commandId per source, exactly as today. A browser resubmit of the exact
rendered form replays every item (each id is stable for the life of that
render, same as any single-item form today) instead of double-executing. No
new core endpoint, no cross-source transaction, no atomicity claim, no
idempotency scheme invented beyond what already exists per row: partial
success is expected and reported.

Bulk tombstone-unblock uses the same reuse pattern: each tombstone row
already carries its own `commandId` (`+page.server.ts:241`), so a bulk
unblock submits those unchanged.

Bulk reap carries **per-row `force`**, not a single action-wide flag: each
checked orphan row already resolved, in §2, whether it renders as plain
"Reap" or "Reap anyway" (`force: true`) — the bulk form submits
`{sourceId, commandId, force}` triples built from each row's own already-
decided state, never a user-supplied bulk force toggle. The confirm text
reflects the mix: "Reaping 3 sources — 1 plain, 2 override retained
evidence permanently. This cannot be undone."

**Outcome reporting:** `bulkSource` returns `{sourceId, ok, error?}[]`. The
page renders a per-row outcome list under the (now-cleared) toolbar — "3
quarantined · 2 refused: has audit history" — naming each failing row, not
just a count. Rows that failed stay checked so a retry doesn't require
re-selecting.

**Destructive bulk ops** (bulk reap, bulk purge, bulk delete-user) use the
same `<details>` reveal-to-confirm as §1, scoped to the toolbar instead of a
row: expanding shows a pluralized consequence and a "Confirm" submit.

`users/+page.svelte` gets the same treatment for `deleteUser` (checkbox per
row, one bulk-delete bar) — the only other page with a per-row destructive
action. `deleteUser` has no commandId today (verified:
`web/src/routes/admin/users/+page.server.ts:14-25` reads no `commandId`
field at all) — bulk delete-user matches that exactly and invents no
idempotency scheme for it either; it's a plain loop over checked handles.

### 4. Route consolidation — inline source detail

Adds a **second, distinct** query param, `?detail={sourceId}`, alongside the
existing `?expand=` (federation-member-list toggle only,
`web/src/routes/admin/feeds/+page.svelte:188-221`) — the two can't share a
name: every row, including federation ones, already renders its own
"Details" link (`:186`), so a federation row needs `expand=` (member list)
and `detail=` (its own panel) to mean different things at once, not one
param overloaded to mean both. Clicking "Details" adds `?detail={sourceId}`
and the row inlines the detail panel (refresh button, status `dl`, items
list, purge form) by reusing `/admin/sources/[sourceId]`'s existing `load`
logic from the list page's own `load`, instead of navigating to a separate
route. No-JS safe — it's a link + re-render, same mechanism the member-expand
already uses, just a different param.

**Run history stays a separate route** (`/admin/sources/[sourceId]/runs`).
It's an independently-paginated log, not source state; embedding it would put
an unbounded list inside every expanded row. The link stays one hop away.

Net: three routes become two — `/admin/feeds` (list + inline detail) and
`/admin/sources/[id]/runs` (history, visited only when wanted).

## Testing

- `feeds.render.test.ts` and `source-detail.test.ts` are SvelteKit SSR render
  tests (`svelte/server`'s `render()`, `$app/forms`'s `enhance` stubbed to a
  no-op) — they never execute `confirmSubmit()`'s `confirm()` call today, so
  there is no mock to remove. What changes: assert the consequence text and
  "Confirm <action>" button are present inside a `<details>` element in the
  static markup (reachable with zero JS), instead of asserting on
  `use:enhance={confirmSubmit(...)}` prop wiring, which goes away.
- `feeds.render.test.ts`'s reap-refusal loop (`for (const reason of [...])`,
  currently asserting a `form` prop simulating a 409 drives which force-confirm
  form appears — `feeds.render.test.ts:371-404`) is deleted and replaced:
  the new tests assert the button choice comes from `row.retention` alone, no
  `form` prop involved — one test per reason plus `reapable`, checking each
  orphan row renders exactly one reap form (plain or force, never both) with
  the reason-specific consequence text already present. The adjacent
  `has_subscribers`-refusal test (`:406-411`) is deleted outright — an
  orphan row can never carry that retention value (Motivation §1), so there
  is no refusal-display path left to test for it.
- New tests for `bulkSource`: mixed-outcome batch (some ok, some refused),
  per-row commandId reuse on a resubmit of the same rendered form, mixed
  plain/force reap batch, and empty-selection submit (no-op, no error).
- New test for inline-expand detail panel rendering the same fields the
  standalone `/admin/sources/[sourceId]` page renders (shared load logic, not
  a re-derivation — same posture as the existing member-panel sharing note in
  `feeds/+page.svelte:230-236`).

## Rollout

Web-only change, no data migration, no core change — ships as an ordinary
release. No feature flag: the old popup/round-trip/single-item behavior has
no users depending on its specific shape (it's an operator-facing admin
surface, not user-facing).

## Revision history

- rev 1 (2026-07-30): initial design, from dogfooding `/admin/feeds` as the
  live moderation surface across 4 running instances.
- rev 2 (2026-07-30): folds ponytail-review findings (dispatched to a clean
  subagent, all verified against the current tree before applying).
  Dropped the invented `batchId`-derivation commandId scheme — bulk actions
  now reuse each row's own already-minted commandId(s), same as a lone
  submit of that row would use — which also removes the rev-1 open question
  about core's commandId format entirely (nothing new is minted, so nothing
  needed verifying). Fixed a self-contradiction where Non-goals excluded
  bulk tombstone-unblock while Components proposed it — kept the feature
  (tombstones already carry a per-row commandId, no reason to exclude them)
  and narrowed the exclusion to `establish` alone. Fixed bulk reap's shape
  from a single batch-wide `action` (which couldn't represent "3 sources,
  3 different force needs") to per-row `{sourceId, commandId, force}`
  triples, keeping the feature per the maintainer's explicit bulk-scope
  call rather than cutting it. Fixed an `?expand=` param collision with the
  existing federation-member-list use by introducing a distinct `?detail=`
  param for inline source detail.
- rev 3 (2026-07-30): corrects two factual errors, found while reading the
  actual referenced files to write the implementation plan. (1) `confirm.ts`
  is used by two non-admin pages (`web/src/routes/+page.svelte:231`,
  `web/src/routes/post/[id]/+page.svelte:104`, the timeline's own
  admin-remove-post affordance) — it is not deleted, only the five admin
  call sites (now including the previously-unlisted tombstone-unblock form)
  stop importing it. (2) `feeds.render.test.ts`/`source-detail.test.ts` are
  SSR render tests that never mock `confirm()` in the first place — the
  reap-refusal test loop is rewritten to assert on `retention` directly
  (no `form` prop), and the `has_subscribers`-refusal test is deleted rather
  than adapted, since that refusal path no longer exists for orphan rows.
