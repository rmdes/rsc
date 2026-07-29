# Remote content retention — design

**Status:** rev 2 (2026-07-30) — folds a `ponytail:ponytail-audit` pass
(dispatched to a fresh subagent, clean sub-context) run against rev 1.
One finding accepted and applied (the disposal mechanism was over-built —
see the Architecture section); one finding (drop the age cap) presented
to the maintainer and explicitly declined — both count and age stay, per
maintainer call. Full findings and the maintainer's call are in the
Revision History at the bottom.

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
5. Union the two id sets → the excess logical-item ids.
6. For each excess item id: `hasChildEdge(tx, id) ?
   convertToStructuralTombstone(tx, id) : deleteLogicalNode(tx, id)` —
   the same branch `removeSourceEvidence`'s own per-item loop uses,
   called directly.
7. Delete the excess items' own delivery/observation-version rows —
   **delivery/observation-scoped tables only**, never the source-scoped
   ones step 6's sibling `removeSourceEvidence` also touches:
   `presentation_entries_v2` (by delivery_id), `reconciliation_jobs_v2`
   (by observation_version_id), `publisher_claims_v2` (by
   observation_version_id — **not** source_id, the source itself
   survives), `logical_conflicts_v2` (by observation_version_id),
   `observation_versions_v2` (by delivery_id), `logical_identity_keys_v2`
   (kind='delivery', key=delivery_id), `deliveries_v2` (by id) — children
   before the delivery row itself.
8. Return `{ trimmedCount: <excess item count> }`.

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

### Hook point (`core/src/logical/acquisition.ts`, `commitAcquisition`)

At the end of `commitAcquisition`, after this poll's observations are
reconciled into items (same write transaction — trimming is atomic with
the ingest that may have just pushed the source over its cap): if either
setting is non-zero, call `trimSourceToCap` scoped to `input.sourceId`.

**Settings must be read live, not baked into `AcquisitionDeps` at boot.**
`createAcquisition(deps)` is called once at server startup — `deps`
values captured there (like `pollSeconds`) are effectively static for the
process's lifetime. But `/admin/settings` can change these two values at
any time, and `service.getSetting` is `async`, while `commitAcquisition`
runs synchronously inside a `db.write((tx) => ...)` callback (settings
can't be fetched mid-transaction). So the read has to happen in
`commitFromBody` (the async function that calls `db.write(...)`, already
in `createAcquisition`'s closure), *before* opening the transaction, and
the resolved numbers get passed into `CommitAcquisitionInput` as plain
values for `commitAcquisition` to act on. Concretely: `commitFromBody`
gains two `await deps.getSetting(...)` calls (parsed to numbers, `0` on
missing/unset) ahead of its `db.write(...)` call. Rev 2 (ponytail-audit
shrink, accepted): `CommitAcquisitionInput`
(`core/src/logical/types.ts:445-460`) gains ONE new field, not two —
`retentionCap: { maxCount: number; maxAgeDays: number } | null` — that
`commitFromBody` populates from the two resolved settings values (`null`
when both are `0`, so `commitAcquisition` has a single check instead of
two), and `commitAcquisition` reads at the point it calls
`trimSourceToCap`.

`AcquisitionDeps` (`core/src/logical/acquisition.ts:640-646`, currently
`{ db, fetchFn?, lookupFn?, deadlineMs?, now? }`) has no settings access
today — add `getSetting?: (key: string) => Promise<string | undefined>`,
**optional**, matching every other field on this interface. 46 test files
construct `createAcquisition` directly (`grep -rl "createAcquisition("
core/test/ | wc -l`) — an optional field with an inert default (`const
getSetting = deps.getSetting ?? (async () => undefined)`, i.e. unlimited)
means none of those 46 need touching; only the one real production call
site, `core/src/server.ts:37` (`createAcquisition({ db })`), needs
widening — `repo` (which already has `getSetting`) is constructed at
line 27, before this call, so the wiring is `createAcquisition({ db,
getSetting: (key) => repo.getSetting(key) })`. A handful of NEW tests
(§Testing below) will pass `getSetting` explicitly to exercise
retention; the other 46 are unaffected.

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
  tombstone (mirrors purge's own such test), the `0`/`0` no-op fast path,
  local items never selected regardless of settings, and confirming the
  source-scoped tables (`acquisition_runs_v2`, `source_health_v2`, etc.)
  and the `remote_sources_v2` row are untouched after a trim.
- `commitAcquisition` integration test: a poll that pushes a source over
  its configured cap trims within the same commit.
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

*developed with the help of AI tools*
