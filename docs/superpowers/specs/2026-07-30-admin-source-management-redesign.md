# Admin source-management UX redesign

Status: rev 1 (2026-07-30), pending ponytail-review

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
- No bulk variant for `establish` (federation) or tombstone-unblock — neither
  is naturally batchable the way governance transitions are, and each is
  already a single, deliberate act.

## Components

### 1. Inline reveal-to-confirm (replaces `confirmSubmit()`)

Every destructive-action form (`source` action's block/unblock, `reap`,
`purge`, `deleteUser`) wraps its consequence text and submit button in a
native `<details>`/`<summary>` disclosure — the same primitive already used
for the mobile nav panel (`design-system/rsc/MASTER.md:515`):

- **Collapsed:** a `<summary>` styled as a plain button reading the action
  name (e.g. "Block").
- **Expanded (click, no JS required):** shows the existing consequence
  sentence and a distinct "Confirm block" submit button.
- **With JS:** `use:enhance` goes back to being a plain progressive-
  enhancement wrapper (AJAX submit, row-level update) — there is no confirm
  gate left to short-circuit.

`web/src/lib/confirm.ts` and every `use:enhance={consequence ? confirmSubmit(...) : undefined}`
call site are deleted. `feeds.render.test.ts` / `source-actions.test.ts` /
`item-review.test.ts` / `source-detail.test.ts` lose their `confirm()`-mock
setup and gain an assertion that the consequence text is reachable without a
popup.

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

**New server action — `bulkSource`:** one hidden `batchId`
(`crypto.randomUUID()`), minted once per group at page load exactly like
every existing `commandId`. The bulk form posts `batchId`, the checked
`sourceId[]`, and the chosen `action`. `bulkSource` loops over the selected
ids and calls the same per-source core endpoint `source` already calls,
deriving each item's commandId as `` `${batchId}:${sourceId}` `` — an opaque
string; core's idempotency store has no format constraint on commandId
(confirm against `core/src/domain/source-repository.ts` command-ledger schema
during planning). A browser resubmit of the exact rendered form (same
`batchId`, same checked set) therefore replays every item instead of
double-executing — the same guarantee single-item forms already have, fanned
out rather than reinvented. No new core endpoint, no cross-source
transaction, no atomicity claim: partial success is expected and reported.

**Outcome reporting:** `bulkSource` returns `{sourceId, ok, error?}[]`. The
page renders a per-row outcome list under the (now-cleared) toolbar — "3
quarantined · 2 refused: has audit history" — naming each failing row, not
just a count. Rows that failed stay checked so a retry doesn't require
re-selecting.

**Destructive bulk ops** (bulk reap, bulk purge, bulk delete-user) use the
same `<details>` reveal-to-confirm as §1, scoped to the toolbar instead of a
row: expanding shows a pluralized consequence ("Reaping 3 sources permanently
deletes...") and a "Confirm reap" submit.

`users/+page.svelte` gets the same treatment for `deleteUser` (checkbox per
row, one bulk-delete bar) — the only other page with a per-row destructive
action.

### 4. Route consolidation — inline source detail

Extends the existing `?expand=` pattern (currently only used for federation-
instance members, `web/src/routes/admin/feeds/+page.svelte:188-221`) to
ordinary rows: clicking "Details" adds `?expand={sourceId}` and the row
inlines the detail panel (refresh button, status `dl`, items list, purge
form) by reusing `/admin/sources/[sourceId]`'s existing `load` logic from the
list page's own `load`, instead of navigating to a separate route. No-JS
safe — it's a link + re-render, same mechanism the member-expand already
uses.

**Run history stays a separate route** (`/admin/sources/[sourceId]/runs`).
It's an independently-paginated log, not source state; embedding it would put
an unbounded list inside every expanded row. The link stays one hop away.

Net: three routes become two — `/admin/feeds` (list + inline detail) and
`/admin/sources/[id]/runs` (history, visited only when wanted).

## Testing

- Delete `confirm()`-mock scaffolding from `feeds.render.test.ts`,
  `source-actions.test.ts`, `item-review.test.ts`, `source-detail.test.ts`;
  add assertions that consequence text is present in the `<details>` markup
  without JS.
- New tests for retention-driven reap button selection (reapable vs. each of
  the three force-liftable reasons) replacing the old two-step-refusal test.
- New tests for `bulkSource`: mixed-outcome batch (some ok, some refused),
  commandId derivation stability across a resubmit of the same batch, and
  empty-selection submit (no-op, no error).
- New test for inline-expand detail panel rendering the same fields the
  standalone `/admin/sources/[sourceId]` page renders (shared load logic, not
  a re-derivation — same posture as the existing member-panel sharing note in
  `feeds/+page.svelte:230-236`).

## Rollout

Web-only change, no data migration, no core change — ships as an ordinary
release. No feature flag: the old popup/round-trip/single-item behavior has
no users depending on its specific shape (it's an operator-facing admin
surface, not user-facing).

## Open questions

- Exact commandId-format confirmation against core's command ledger (does it
  accept an arbitrary opaque string, or does it validate UUID shape?) —
  verify during planning before committing to the `` `${batchId}:${sourceId}` ``
  derivation; if core validates format, fall back to a per-item
  `crypto.randomUUID()` seeded deterministically some other way, or accept
  minting fresh per-item ids on every batch submit (losing exact-resubmit
  idempotency for bulk only, single-item forms unaffected).

## Revision history

- rev 1 (2026-07-30): initial design, from dogfooding `/admin/feeds` as the
  live moderation surface across 4 running instances.
