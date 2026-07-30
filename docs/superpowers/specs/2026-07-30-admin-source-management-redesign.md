# Admin source-management UX redesign

Status: rev 4 (2026-07-30) — IMPLEMENTED. Rev 2 folded ponytail-review
findings (dropped the invented `batchId`-derivation scheme, fixed a
bulk-tombstone-unblock contradiction, fixed bulk reap's per-row `force`
shape, fixed an `?expand=` collision). Rev 3 corrected two factual errors
found while verifying references for the implementation plan: `confirm.ts` is
used outside `/admin` too (not deletable) and the render tests never actually
mocked `confirm()` (there was nothing to remove). Rev 4 aligns this document
with what actually shipped: the bulk request shape (self-describing candidate
strings, not parallel arrays) and Goal 4's framing (an added inline
quick-view panel, not three routes collapsing into two). See Revision
history.

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
4. Add an inline source-detail quick view to the list, so the routine
   look-at-this-source case needs no route change; leave the full-fidelity
   standalone detail route and history route as they are.

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

**Toolbar:** a ruled action bar occupies each group's static-blurb position
(`<p class="subnav">{group.blurb}</p>`) — no floating element, no reflow of
the row list below. Orphans and tombstones get the same bar over their own
section blurb, offering bulk reap / bulk unblock respectively.

Rev 4, corrected to what shipped: the bar's buttons and category `<select>`
are **always in the server output**, not swapped in once a row is checked.
Hiding them behind client state would make the only reachable submit path
JS-only, which the plan's mid-execution correction identified and fixed. What
a checked row contributes comes from the checkbox itself (see the request
shape below), so client state is never load-bearing. `N selected` and the
blurb↔toolbar text swap are the JS-only cosmetics that remain; there is no
"Clear" button (unchecking is the browser's job). The narrowing to the
*intersection* of checked rows' `availableActions` is likewise a JS
enhancement — the server renders the union, and a verb a checked row doesn't
offer is silently skipped server-side rather than being unrepresentable.
Destructive verbs are gated per §1: `block`/`unblock` in a bulk bar sit behind
the same reveal-to-confirm disclosure, keyed on the same consequence text, as
their single-row counterparts.

**New server action — `bulkSource`, reusing existing per-row commandIds
(no `batchId`, no derivation):** every row already carries its own
`commandId` per action (`toRow`, `+page.server.ts:151`) or, for orphans,
one `commandId` (`toOrphanRow` — rev 4: §2's retention-driven change dropped
`forceCommandId`, so it is one id per row, not two). Each row's *own
already-minted* id(s) ride on the row's checkbox itself, so the bulk form
submits exactly the checked rows with the same commandId a lone submit of
that row would have used. `bulkSource` loops over them and calls the same
per-source core endpoint `source` already calls, one commandId per source,
exactly as today. A browser resubmit of the exact rendered form replays every
item (each id is stable for the life of that render, same as any single-item
form today) instead of double-executing. No new core endpoint, no
cross-source transaction, no atomicity claim, no idempotency scheme invented
beyond what already exists per row: partial success is expected and reported.

**Request shape (rev 4 — corrected to what shipped).** Parallel
`sourceId[]`/`commandId[]` arrays, as rev 2-3 described them, were NOT built:
they need index-alignment between two independent repeated fields, and
nothing but JS could keep the two lists in step, since a row's hidden inputs
would have to be added and removed as boxes are checked. What shipped instead
is a **self-describing candidate string**: each row's checkbox carries its
own `name="candidate"` value encoding everything that row's action needs, so
a checked box alone — with zero JS, no client state, nothing index-aligned —
carries the whole request, and the browser's own "only checked boxes are
submitted" rule IS the selection mechanism. The encoding differs per action,
each carrying exactly what that action needs and no more:

| action          | candidate value                          |
| --------------- | ---------------------------------------- |
| `bulkSource`    | `sourceId\|action:commandId\|action:…`   |
| `bulkReap`      | `sourceId:commandId:force`               |
| `bulkTombstone` | `tombstoneId:commandId`                  |
| `bulkDelete`    | `handle` (no commandId — see below)      |

The four encodings are deliberately NOT unified behind a generic encoder:
each is one line at the point of use, and a shared codec would be more code
than the thing it replaces. They assume an id never contains `:` or `|` —
true for core's UUIDs and for handles.

Bulk tombstone-unblock uses the same reuse pattern: each tombstone row
already carries its own `commandId` (`+page.server.ts:241`), so a bulk
unblock submits those unchanged.

Bulk reap carries **per-row `force`**, not a single action-wide flag: each
checked orphan row already resolved, in §2, whether it renders as plain
"Reap" or "Reap anyway" (`force: true`) — the bulk form submits that row's
own already-decided `force` in its candidate string, never a user-supplied
bulk force toggle. The confirm text reflects the mix: reaping the selected
sources states the generic permanence, plus a distinct sentence when any of
them override retained evidence.

**Outcome reporting:** `bulkSource` returns `{sourceId, ok, error?}[]`. The
page renders a per-row outcome list naming each failing row, not just a count.
Rev 4, corrected to what shipped: the selection is cleared wholesale after a
submit, failures included, rather than leaving failed rows checked — because
`use:enhance`'s `invalidateAll()` re-runs `load()` without remounting, so a
retained selection keeps ids of rows that have since MOVED GROUP (a
just-quarantined row leaves "Allowed user sources"), producing a stale count
over rows the next click can't act on. Re-checking the few failures is
cheaper than that trap. An empty result array (nothing effectively selected,
or no checked row offered the clicked verb) renders an explicit "Nothing
selected." rather than silence, since with JS off there is no live count to
contradict.

**Destructive bulk ops** (bulk reap, bulk purge, bulk delete-user) use the
same `<details>` reveal-to-confirm as §1, scoped to the toolbar instead of a
row: expanding shows a pluralized consequence and a "Confirm" submit.

`users/+page.svelte` gets the same treatment for `deleteUser` (checkbox per
row, one bulk-delete bar) — the only other page with a per-row destructive
action. `deleteUser` has no commandId today (verified:
`web/src/routes/admin/users/+page.server.ts:14-25` reads no `commandId`
field at all) — bulk delete-user matches that exactly and invents no
idempotency scheme for it either; it's a plain loop over checked handles.

### 4. Inline source detail (rev 4: an added quick view, not a consolidation)

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

Net (rev 4, corrected to what shipped): **all three routes still exist.** The
inline panel is an explicitly reduced-fidelity quick view — refresh, latest-run
status, item ids, purge — living alongside the still-present full-fidelity
`/admin/sources/[id]` route, which additionally shows the run id, fetch
outcome and diagnostic, the full acquisition/reconciliation counter
breakdown, the inbound-push lease block, item state badges and item
pagination, and the neutral refusal/polling notices. `/admin/sources/[id]/runs`
is untouched. So the win is one fewer navigation for the routine
look-at-this-source case, not a route count going down; nothing was removed,
and both surfaces read through the same shared `loadSourceDetail` (and, since
the final-review pass, the same shared `refreshAction`/`purgeAction`), so the
quick view can never drift from the full one.

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
- rev 4 (2026-07-30): post-implementation alignment — the nine tasks are
  built, and the whole-branch review found this document still describing two
  things that never shipped. Neither is a design change; both are the spec
  catching up to the code.
  1. **§3's request shape.** "Parallel `sourceId[]`/`commandId[]` arrays" fed
     by per-row hidden inputs was replaced during execution (the plan's
     "Mid-execution correction") by a self-describing candidate string on the
     checkbox itself, because the array form needed JS to keep two repeated
     fields index-aligned and so had no no-JS submit path at all. §3 now
     documents the four shipped encodings and why they are deliberately not
     unified. The surrounding toolbar and outcome-reporting paragraphs are
     corrected the same way: the bar's buttons ship visible rather than
     appearing on selection, there is no "Clear" button, the
     intersection-narrowing is a JS enhancement over a server-rendered union,
     and the selection is cleared wholesale after a submit instead of keeping
     failed rows checked (a retained selection goes stale the moment a row
     changes group). `toOrphanRow`'s `forceCommandId` reference is dropped —
     §2's own retention-driven change removed that field.
  2. **Goal 4 / §4's framing.** "Collapse list → detail into one route" and
     "Net: three routes become two" overstate what shipped and what was ever
     wanted: all three routes still exist, and the inline panel is a
     deliberately reduced-fidelity quick view beside the full-fidelity
     standalone route (which still owns run/fetch diagnostics, the counter
     breakdown, the push-lease block and item pagination), not a replacement
     for it. Reframed as "adds an inline quick-view panel" — the win is one
     fewer navigation for the routine case, with both surfaces sharing one
     loader so they cannot drift.
