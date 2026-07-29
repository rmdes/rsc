# Remote content retention — design

**Status:** rev 1, ready for review.

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
- Reuses the existing per-item disposal logic (reselect / delete /
  structural-tombstone) that `removeSourceEvidence` (purge, reap) already
  has, generalized to operate on an explicit delivery-id set instead of
  "every delivery for source X."

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

### The disposal-core refactor (`core/src/logical/tombstones.ts`)

`removeSourceEvidence(tx, {sourceId, now})` currently conflates two
things: FK-ordered deletion scoped by `source_id`, and per-item
reselect/delete/structural-tombstone logic scoped by an `affected` set of
logical-item ids derived from that source's deliveries. Split:

```ts
// New: takes an explicit delivery-id set instead of "every delivery for
// this source" — the shared core both removeSourceEvidence (all
// deliveries) and trimSourceToCap (just the excess ones) call.
export function disposeDeliveries(tx: WriteTx, input: { deliveryIds: string[]; now: string }): { ordinaryAffected: boolean }
```

`disposeDeliveries` is `removeSourceEvidence`'s existing lines ~97-178
(capture affected set, FK-order DELETEs, per-item reselect/delete/
tombstone, unreferenced-publisher cleanup), with every `WHERE source_id =
?` rewritten to `WHERE delivery_id IN (...)` / `WHERE id IN (...)` against
the passed `deliveryIds`, and the FK-order delete queries' `(SELECT id
FROM deliveries_v2 WHERE source_id = @s)` subqueries replaced with the
literal `deliveryIds` list bound directly (no join back through
`source_id` needed — the caller already resolved which deliveries).

`removeSourceEvidence` becomes:

```ts
export function removeSourceEvidence(tx: WriteTx, input: { sourceId: string; now: string }): { ordinaryAffected: boolean } {
  const deliveryIds = (tx.prepare(`SELECT id FROM deliveries_v2 WHERE source_id = ?`).all(input.sourceId) as { id: string }[]).map((r) => r.id)
  const result = disposeDeliveries(tx, { deliveryIds, now: input.now })
  // publisher/source-row cleanup that only a full-source removal does
  // (candidatePublishers computation + the final source-row DELETE) stays here.
  ...
  return result
}
```

The candidate-publisher cleanup and the final `DELETE FROM
remote_sources_v2` stay in `removeSourceEvidence` only — a trim never
deletes the source row (the source keeps polling; only its old items go).
Every existing purge/reap test should pass unchanged: same SQL, same
order, same outcomes, just re-homed behind one more call frame.

### Trim selection (new, `core/src/logical/tombstones.ts` or a new
`retention.ts` — implementer's call, matching whichever keeps the file
focused)

```ts
export function trimSourceToCap(tx: WriteTx, input: { sourceId: string; maxCount: number; maxAgeDays: number; now: string }): { trimmedCount: number }
```

1. If both `maxCount` and `maxAgeDays` are `0`, return `{ trimmedCount: 0 }`
   immediately — no query cost for the (default) unlimited case.
2. Select this source's remote logical items via the same delivery→source
   join used elsewhere (`logical_items_v2 li JOIN deliveries_v2 d ON
   d.id = li.selected_delivery_id WHERE d.source_id = ? AND li.origin =
   'remote'`), ordered by `li.timeline_sort_at DESC`.
3. Excess by age (if `maxAgeDays > 0`): any row with `timeline_sort_at <
   now - maxAgeDays`.
4. Excess by count (if `maxCount > 0`): every row ranked beyond position
   `maxCount` in the DESC order.
5. Union the two id sets, map to `selected_delivery_id`, call
   `disposeDeliveries` with that list.

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
missing/unset) ahead of its `db.write(...)` call. `CommitAcquisitionInput`
(`core/src/logical/types.ts:445-460`) gains two new fields —
`maxRemoteItemsPerSource: number` and `maxRemoteItemAgeDays: number` —
that `commitFromBody` populates from those two resolved values, and
`commitAcquisition` reads at the point it calls `trimSourceToCap`.

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

Trimmed items go through the *exact* per-item disposal path purge already
uses: a reply whose parent gets trimmed away, but which is itself still
under the cap, converts its parent into a structural tombstone rather
than losing the parent silently — thread integrity is preserved the same
way it already is for purge. No new deletion semantics are introduced;
this feature only changes *which* delivery ids reach the existing,
already-tested disposal core.

## Testing

- `disposeDeliveries`/`removeSourceEvidence` split: every existing
  purge/reap test (`source-cleanup.test.ts` and friends) must pass
  unchanged — this is a refactor of tested code, not new behavior.
- New tests for `trimSourceToCap`: count-only cap, age-only cap, both
  together (union), a reply surviving its trimmed parent as a structural
  tombstone (mirrors purge's own such test), the `0`/`0` no-op fast path,
  local items never selected regardless of settings.
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

*developed with the help of AI tools*
