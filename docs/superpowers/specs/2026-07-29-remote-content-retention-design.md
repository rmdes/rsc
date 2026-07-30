# Remote content retention — design

**Status:** rev 4 (2026-07-30) — rev 2 folded a `ponytail:ponytail-audit`
pass; rev 3 fixed a sequencing bug in the trim algorithm; rev 4 replaces
the entire Hook Point section — the original design integrated with the
wrong subsystem (`commitAcquisition` never creates `logical_items_v2`
rows; reconciliation is asynchronous and job-based). Full history at the
bottom.

## Motivation

`rsc.rmdes.be`'s admin overview showed **13,105 posts** after roughly two
weeks of development. Investigated directly against the live instance
(read-only queries, `cloudron exec`), not assumed:

- `posts` (local) = 874. `logical_items_v2 WHERE origin='remote'` = 12,232.
  874 + 12,232 = 13,106 ≈ the 13,105 shown — the admin-overview count
  arithmetic is correct; this is not a counting bug.
- The oldest remote item's `timeline_sort_at` is **2005-11-30** — twenty
  years of backfilled history, not two weeks of new content.
- Distribution is heavily concentrated: 5 sources have 500+ items each
  (3,812 total — the top is an Audioboom podcast feed at 1,002 episodes,
  followed by a Project Gutenberg feed at 990), 27 more have 100–499
  (6,363 total). Those 32 sources — out of 164 total — account for **83%**
  of all remote content. 132 sources contribute the remaining 17%.

Root cause, confirmed by reading `core/src/logical/acquisition.ts`: every
poll maps `parsed.feed.items ?? []` / `.entries ?? []` in full — there is no
per-fetch item cap. A feed that exposes its entire archive (common for
podcast RSS, less common but real for blogs) gets that entire archive
ingested the first time it's subscribed or federated. This is not the same
failure mode as the 2026-07-25 observation-version churn incident (a
per-delivery re-registration bug from an identity-key collision on one
feed — see `ideas.md`'s existing entry) — this is working as designed, and
the design has no ceiling.

**Goal:** a global, admin-configurable retention policy for *remote* content
only. Local posts are never touched — an instance that wants to keep its
own posts forever should be able to, unconditionally.

## Scope

- One global setting pair (max item count per source, max item age),
  applied uniformly to every remote source. No per-source override.
- Enforced once per source, right after that source's poll commits new
  items — no new scheduled job.
- Reuses the existing per-item disposal primitives (reselect / delete /
  structural-tombstone) that `removeSourceEvidence` (purge, reap) also
  calls — these are already standalone, logical-item-id-keyed exports
  (`threading.ts`, `reconcile.ts`), not logic bundled inside
  `removeSourceEvidence` that needs extracting. `tombstones.ts` itself is
  untouched by this feature (rev 2 — see Revision History).

**Explicitly out of scope** (accepted tradeoffs, not deferred bugs):
- No periodic sweep. A paused/quarantined source already holding excess
  when the cap is introduced or lowered does not trim until its next poll.
- No per-source override of the global cap.
- No "preview what would be deleted" UI before saving a new cap value.
- The 2026-07-25 observation-version churn mechanism (a different bug,
  already tracked in `ideas.md`) is not fixed by this feature and this
  feature does not depend on it being fixed.

## Architecture

### Settings

Two new keys in the existing generic `getSetting`/`setSetting` KV store
(`core/src/domain/service.ts`, already used for `max_subs_per_user` —
no schema change):

- `max_remote_items_per_source` — non-negative integer string. `0` (and
  the unset/default state) means unlimited.
- `max_remote_item_age_days` — non-negative integer string. `0` (and the
  unset/default state) means unlimited.

Both default to unlimited, so shipping this feature never silently trims
an existing instance's content until an admin explicitly opts in by
setting a non-zero value.

### Trim mechanism (new, standalone — `core/src/logical/tombstones.ts`)

Rev 2 (ponytail-audit finding, accepted): rev 1 proposed extracting
`removeSourceEvidence`'s per-item logic into a shared `disposeDeliveries`
core. Unnecessary — the reusable per-item primitives are **already**
standalone exports, not logic bundled inside `removeSourceEvidence` that
needs extracting: `hasChildEdge`, `deleteLogicalNode`,
`convertToStructuralTombstone`, `sweepStructuralTombstones`
(`core/src/logical/threading.ts:270-317`, each `(tx, id: string)`) and
`applySelectionHints` (`core/src/logical/reconcile.ts:421`, `(tx,
itemId, currentVersionId)`). And most of `removeSourceEvidence`'s FK
deletes are genuinely **source**-scoped
(`verification_checks_v2`, `source_health_v2`, `source_validators_v2`,
`acquisition_runs_v2`, `policy_fanout_v2`, `publisher_names_v2`) — a
trim must never touch these (the source keeps polling; only its old
items go), so rewriting them to a delivery-id parameterization never
made sense. **`removeSourceEvidence`/`tombstones.ts`'s existing code is
unchanged by this feature** — zero re-verification risk to the
already-tested purge/reap suite.

```ts
export function trimSourceToCap(tx: WriteTx, input: { sourceId: string; maxCount: number; maxAgeDays: number; now: string }): { trimmedCount: number }
```

**Sequencing note (fixed after a second read of `removeSourceEvidence`
during plan-writing):** the delivery/observation-scoped DELETEs must run
*before* the per-item reselect/delete/tombstone decision, not after —
`removeSourceEvidence` checks `hasDelivery(id)` (does this item still
have a *surviving* identity key of kind `'delivery'`?) only after its own
FK deletes already removed the identity keys tied to the
deliveries being scrapped, so that check correctly reflects "is there a
delivery left" rather than always seeing the one about to be removed. An
earlier draft of this section put the reselect/dispose decision before
the deletes and skipped the reselect branch entirely — that would have
deleted/tombstoned items that actually still had a perfectly good
surviving delivery (e.g. the same content also observed via a different,
untouched source). Corrected order:

1. Fast path: if both `maxCount` and `maxAgeDays` are `0`, return
   `{ trimmedCount: 0 }` immediately — no query cost for the (default)
   unlimited case.
2. Select this source's remote logical items via
   `logical_items_v2 li JOIN deliveries_v2 d ON d.id =
   li.selected_delivery_id WHERE d.source_id = ? AND li.origin =
   'remote'`, ordered by `li.timeline_sort_at DESC`.
3. Excess by age (if `maxAgeDays > 0`): any row with `timeline_sort_at`
   older than `now - maxAgeDays`.
4. Excess by count (if `maxCount > 0`): every row ranked beyond position
   `maxCount` in the DESC order.
5. Union the two id sets → the excess logical-item ids. If empty, return
   `{ trimmedCount: 0 }`.
6. Resolve each excess item's `selected_delivery_id` → the delivery-id
   set to remove.
7. Delete delivery/observation-scoped rows for that delivery-id set —
   **never the source-scoped tables** `removeSourceEvidence` also
   touches (the source itself survives): compute `vers` = observation
   versions for those deliveries, then `reconciliation_jobs_v2` (by
   `observation_version_id IN vers`), `presentation_entries_v2` (by
   `delivery_id`), `publisher_claims_v2` (by `observation_version_id IN
   vers` — **not** `source_id`), `logical_conflicts_v2` (by
   `observation_version_id IN vers`), `observation_versions_v2` (by
   `delivery_id`), `logical_identity_keys_v2` (`kind='delivery' AND key
   IN` the delivery-id set), `deliveries_v2` (by `id IN` the delivery-id
   set) — in that order, mirroring `removeSourceEvidence`'s own FK order
   for these same tables.
8. *Now*, per excess item id (identity keys for the removed deliveries
   are already gone, so this check is accurate): if
   `hasDelivery(id)` (a `logical_identity_keys_v2` row of kind
   `'delivery'` still exists for it — some other, untouched source's
   delivery also backs this same logical item), call
   `applySelectionHints(tx, id, '')` to reselect; otherwise add it to an
   `unsupported` set.
9. Delete-to-fixpoint / tombstone the remainder — identical to
   `removeSourceEvidence`'s own loop: repeatedly delete any
   `unsupported` id with no surviving child edge
   (`hasChildEdge(tx, id)`), tracking each deleted item's
   `parent_logical_item_id`; once no more can be deleted, convert every
   remaining `unsupported` id (it has a surviving descendant edge) via
   `convertToStructuralTombstone`; finally call
   `sweepStructuralTombstones(tx, deletedParents, now)`.
10. Return `{ trimmedCount: <excess item count> }`.

Deliberately does **not** touch: `acquisition_runs_v2`,
`source_health_v2`, `source_validators_v2`, `verification_checks_v2`,
`policy_fanout_v2`, `publisher_names_v2`, or the `remote_sources_v2` row
— those belong only to a full source removal (purge/reap), never a
partial trim. Unreferenced-publisher cleanup is also skipped: a trimmed
source's publisher stays in play as long as the source does, since more
items may still arrive on its next poll.

Ordering key is the logical item's own `timeline_sort_at` (publish date),
not delivery ingestion time or `first_seen_at` — a 2005 episode discovered
today is still old regardless of when this instance happened to find it.
This directly targets the concentration pattern found in production: the
32 archive-heavy sources are exactly the ones this will visibly shrink.

### Hook point (`core/src/logical/runtime.ts`, `createLogicalRuntime`)

**Rev 4 — replaces rev 1-3's entire hook-point design.** `commitAcquisition`
(`acquisition.ts`) only ever writes `deliveries_v2`/
`observation_versions_v2`/a `'pending'` `reconciliation_jobs_v2` row — it
never creates or updates a `logical_items_v2` row. Reconciliation is a
separate, asynchronous, job-based drain (`reconcile.ts`'s
`claimReconciliation`/`reconcileClaim`, orchestrated by
`drainReconciliation`), processing pending jobs in global
`(nextAttemptAt ASC, jobId ASC)` order across *every* source's backlog —
not grouped by poll or by source. A rev-1/2/3 hook inside
`commitAcquisition` would check a count that doesn't yet reflect the
poll that just ran.

The right integration point already exists and needs no new plumbing:
`createLogicalRuntime` (`core/src/logical/runtime.ts:338-410`) wraps the
raw acquisition engine specifically so *every committed acquisition is
followed by a reconciliation drain*:

```ts
const wrapped: AcquisitionEngine = {
  inFlight: (id) => acquisition.inFlight(id),
  async acquireSource(id, reason, signal) {
    const r = await acquisition.acquireSource(id, reason, signal)
    if (!('kind' in r)) drainSync()
    return r
  },
}
```

`drainSync()` calls `drainReconciliation({ store, now })`, which drains
the *entire* eligible job backlog (including whatever job this specific
acquisition just queued) before returning — so immediately after
`drainSync()`, source `id`'s newly-arrived items are guaranteed to be
reflected in `logical_items_v2` (barring an unrelated retry/backoff on
that job, in which case there's nothing new to trim yet anyway). This
function is already `async`, so reading the two settings live needs no
special-casing at all — unlike `commitAcquisition`, which runs
synchronously inside a `db.write` callback and would have needed the
settings pre-fetched and threaded through `CommitAcquisitionInput`
(rev 1-3's now-discarded approach).

```ts
async acquireSource(id, reason, signal) {
  const r = await acquisition.acquireSource(id, reason, signal)
  if (!('kind' in r)) {
    drainSync()
    const getSetting = input.getSetting ?? (async () => undefined)
    const maxCount = Number((await getSetting('max_remote_items_per_source')) ?? '0')
    const maxAgeDays = Number((await getSetting('max_remote_item_age_days')) ?? '0')
    if (maxCount > 0 || maxAgeDays > 0) {
      db.write((tx) => trimSourceToCap(tx, { sourceId: id, maxCount, maxAgeDays, now: now() }))
    }
  }
  return r
},
```

`createLogicalRuntime`'s inline input type (`core/src/logical/runtime.ts:338-352`,
currently `{ db, store, acquisition, config, now?, notify?, trace?,
fetchFn?, lookupFn? }`) gains `getSetting?: (key: string) =>
Promise<string | undefined>` — **optional**, matching every other field.
5 test files construct `createLogicalRuntime` directly (`grep -rl
"createLogicalRuntime(" core/test/ | wc -l`) — the optional field with
an inert default means none need touching; only the one real production
call site, `core/src/server.ts` (`createLogicalRuntime({ db, store:
logicalStore, acquisition, config, notify: ... })`), needs widening —
`repo` is already constructed earlier in that file, so the wiring is
`getSetting: (key) => repo.getSetting(key)`. This entirely replaces the
need for `CommitAcquisitionInput`/`AcquisitionDeps` changes — neither
`acquisition.ts` nor `types.ts` needs to change for this feature at all.

The trim runs in its own `db.write` transaction, separate from
`drainSync()`'s reconciliation transactions and from the original
`acquireSource` commit — correct because it only needs reconciliation to
have already happened (guaranteed by running after `drainSync()`), not
to share a transaction with it.

### Admin UI (`web/src/routes/admin/settings/`)

Two more fields on the existing settings page, alongside
`maxSubsPerUser`: same integer-≥-0 form/validation pattern, same
`getAdminSettings`/`patchAdminSettings` round trip widened with the two
new keys.

## Data safety

Trimmed items go through the *same* per-item primitives purge already
calls (`hasChildEdge`/`deleteLogicalNode`/`convertToStructuralTombstone`):
a reply whose parent gets trimmed away, but which is itself still under
the cap, converts its parent into a structural tombstone rather than
losing the parent silently — thread integrity is preserved the same way
it already is for purge. No new deletion semantics are introduced; this
feature calls existing, already-tested primitives directly, and owns
only the delivery/observation-version-scoped table deletes a partial
trim needs that a whole-source purge doesn't have to distinguish.

## Testing

- `removeSourceEvidence`/`tombstones.ts` need **no changes and no new
  test runs** — rev 2's standalone design doesn't touch that file at all.
- New tests for `trimSourceToCap`: count-only cap, age-only cap, both
  together (union), a reply surviving its trimmed parent as a structural
  tombstone (mirrors purge's own such test), an excess item that still
  has a surviving delivery from a DIFFERENT, untouched source reselecting
  instead of being deleted/tombstoned (the sequencing fix above — this is
  the one case a naive implementation gets wrong), the `0`/`0` no-op fast
  path, local items never selected regardless of settings, and confirming
  the source-scoped tables (`acquisition_runs_v2`, `source_health_v2`,
  etc.) and the `remote_sources_v2` row are untouched after a trim.
- `createLogicalRuntime` integration test: a full `acquireSource` call
  that pushes a source over its configured cap trims by the time the
  call resolves (asserted after `await wrapped.acquireSource(...)`
  returns, against `repo`/`store` state directly).
- Admin settings round-trip test mirroring the existing
  `maxSubsPerUser` one.

## Rollout

Both settings default to unlimited (`0`) — this ships inert. An admin
opts in per-instance by setting non-zero values on `/admin/settings`.
Existing content is trimmed lazily (only on that source's next poll,
per the no-periodic-sweep decision above) rather than all at once on
first enabling the setting — a large existing backlog (like
`rsc.rmdes.be`'s current 12,232 remote items) shrinks gradually as
sources get repolled on their normal cadence, not in one large write.

## Revision History

**Rev 2 (2026-07-30).** A `ponytail:ponytail-audit` subagent (fresh,
clean sub-context) reviewed rev 1 against the real current source
(`tombstones.ts`, `acquisition.ts`, `types.ts`, `service.ts`, the
`/admin/settings` route) before this spec moved to writing-plans. Three
findings:

1. **`yagni` (accepted, applied).** The proposed `disposeDeliveries`
   extraction out of `removeSourceEvidence` was unnecessary — the per-item
   primitives it would "extract" (`hasChildEdge`, `deleteLogicalNode`,
   `convertToStructuralTombstone`, `sweepStructuralTombstones`,
   `applySelectionHints`) are already standalone, logical-item-id-keyed
   exports. Most of `removeSourceEvidence`'s FK deletes are also
   source-scoped, not delivery-scoped, so the proposed rewrite didn't
   even apply to them and a trim must never touch them anyway. Verified
   independently (grepped the four `threading.ts` exports + `reconcile.ts`'s
   `applySelectionHints` — all confirmed standalone) before applying.
   `trimSourceToCap` is now written standalone; `tombstones.ts` is
   unchanged by this feature; net effect is less code and zero
   re-verification risk to the already-tested purge/reap suite.
2. **`yagni` (presented, declined).** The audit noted the production
   grounding is entirely a count problem (one podcast feed with 1,002
   episodes), not a staleness problem, and proposed cutting
   `max_remote_item_age_days` from v1. Presented to the maintainer
   directly — declined: both count and age ship together, as originally
   decided. No spec change from this finding.
3. **`shrink` (accepted, applied).** `CommitAcquisitionInput`'s two new
   fields (`maxRemoteItemsPerSource`, `maxRemoteItemAgeDays`) collapsed
   into one `retentionCap: { maxCount; maxAgeDays } | null` — independent
   of finding 2's outcome, since both values still exist either way.

The settings/hook-point/`AcquisitionDeps` plumbing (optional field,
inert default, only one real call site touched) was reviewed and judged
already proportionate — no changes there.

**Rev 3 (2026-07-30).** While drafting the implementation plan, re-read
`removeSourceEvidence`'s exact body a second time (rather than trusting
rev 2's own summary of it) and found rev 2's step 6 ("for each excess
item, tombstone or delete") skipped a case `removeSourceEvidence` itself
handles: checking whether an item still has a *surviving* delivery (via
some other, untouched source) before deciding to delete or tombstone it,
and running that check only *after* the delivery-scoped rows are deleted
(so the check isn't fooled by the very identity keys about to be
removed). Fixed the Trim mechanism section to delete delivery/
observation-scoped rows first, then run the same
hasDelivery-reselect-or-dispose sequence `removeSourceEvidence` uses,
in the same order. Added a test case for the specific scenario a naive
implementation gets wrong (an item with a surviving delivery from a
different source). No other section changed.

**Rev 4 (2026-07-30).** Also found while drafting the implementation
plan, and more significant than rev 3: rev 1-3's Hook Point section
integrated with the wrong subsystem entirely. Verified by reading
`acquisition.ts`'s `commitAcquisition` (writes only `deliveries_v2`/
`observation_versions_v2`/a pending job row, never `logical_items_v2`),
then `reconcile.ts`'s `claimReconciliation`/`drainReconciliation`
(reconciliation is async, job-based, and processes every source's
backlog in one global order, not scoped to a single poll), then
`runtime.ts` (which already wraps every `acquireSource` call with a
`drainSync()` right after — the actual "this source's new items just
got reconciled" moment). Replaced the whole Hook Point section: the trim
now hooks into `createLogicalRuntime`'s wrapped `acquireSource`, after
`drainSync()`, instead of `commitAcquisition`. This is strictly simpler
than rev 1-3's version, not just more correct: because
`wrapped.acquireSource` is already `async`, settings can be read live
with a plain `await` — no need for the `CommitAcquisitionInput`/
`AcquisitionDeps` threading rev 1-3 built to work around
`commitAcquisition`'s sync/transaction constraints. **Rev 2's finding 3
(the `retentionCap` field collapse) is superseded, not just
inapplicable** — `CommitAcquisitionInput` isn't touched by this feature
at all anymore, so there's no field to collapse. `acquisition.ts` and
`types.ts` need no changes for this feature.

*developed with the help of AI tools*
