# Remote publisher identity fix — aggregate sources & stranded verification

**Date:** 2026-07-27 (rev 2: 2026-07-28)
**Status:** draft rev 2 — ready for spec review.
**Rev 2 change:** reverses the 2026-07-24 adjudication in `convert.ts` that
kept aggregate publishers `feed_anchored` everywhere to protect a legacy
conversion's permanent handle redirect. Maintainer call (2026-07-28): this
project is ~2 weeks old; the thing that adjudication protected — a bookmarked
v1-era URL for a whole federated instance masquerading as one profile — is
already a vanishingly unlikely case to matter on any of these self-hosted
instances, converted or not. Rev 1 scoped C to exclude
`handle_reservations_v2`-backed rows to preserve that adjudication; rev 2
instead reverses it outright and updates `convert.ts` to match, closing the
"two regimes" gap for good rather than freezing it.
**Trigger:** `docs/superpowers/ideas.md`'s "V4 migration follow-ups (Task 5
adjudication, 2026-07-24)" entry — "§2.4 attribution fix must MIGRATE existing
publisher rows" — logged as `backlog, blocked on the §2.4 fix being specced`.
This is that spec. Also closes the `ponytail:` comment above
`getOrCreatePublisher` in `core/src/logical/reconcile.ts:185-189`.

## Root causes (verified in code AND in the live dev database)

1. **Every remote publisher is minted `identity_level = 'feed_anchored'`,
   regardless of the source's `attribution_mode`.** `getOrCreatePublisher`
   exists as two independent copies — `core/src/logical/reconcile.ts:190` and
   `core/src/logical/verification.ts:307` (the latter's own comment: "mirrors
   reconcile.ts") — both key purely on `canonical_feed_url` and hardcode
   `'feed_anchored'`. For an `aggregate`-mode source (a whole federated
   instance's firehose, e.g. `https://rsc.rmdes.be/users/rss.xml`), this mints
   a publisher row that represents the **entire instance**, not a real person,
   and every author on that instance shares it until something else
   intervenes. The schema (`schema.ts:41`) already defines a second value,
   `identity_level IN('feed_anchored','source_scoped_fallback')`, and the
   projector already reads it to gate publisher-page navigability
   (`projector.ts:503,647`: a byline only links to `/p/:id` when
   `identity_level === 'feed_anchored'`) — but nothing has ever written
   `source_scoped_fallback`. Confirmed live: `rsc.rmdes.be`'s dev DB has exactly
   one `aggregate` source, and its publisher row
   (`691fa1e6-880d-4d8e-82b7-fa020226cd46`, keyed on the instance's own
   firehose URL) is `feed_anchored` — treated exactly like a real person's
   identity.

2. **The "something else" that usually intervenes is verification, and it
   mostly works — but a per-item verification miss is permanent, even after
   the correct identity is established by other means.** `reconcile.ts:332-333`
   schedules a per-item origin-verification check whenever an aggregate-source
   item asserts its own `<source url>`. `verification.ts`'s
   `resolveVerificationBatch` fetches that URL, and on a content match
   (`matchContainment`) mints (or reuses) a real per-author `single_publisher`
   source (`findOrCreateOriginSource`) and re-derives the item's author via
   `applySelectionHints` — the v2 "never trust stored conclusions" philosophy
   holding here too. **Verified live:** of 58 items that ever claimed the
   aggregate instance's publisher, 57 were successfully verified and now
   correctly point at their real per-author publisher. Exactly one
   (`ccfd70e7-85c9-481e-9390-2eebd52c9cb3`, author "Paul") is stuck: its
   `verification_checks_v2` row resolved `state = 'unverified'` (the fetch
   succeeded, but Paul's feed didn't yet contain the post at check time — a
   timing race), and `unverified` is coded as **terminal**
   ("never contradicted, no retry"). Paul's real identity
   (`0d898080-21e7-4ec3-8950-0a42495cf414`, `origin_verification` provenance)
   demonstrably exists — other items from Paul verified successfully — but
   nothing ever gives this one item a second look.

## Decided model

Two independent fixes, agreed after tracing both the code and the live data
(2026-07-27 brainstorm):

- **(C) Stop minting a real identity for an aggregate instance's own URL.**
  A publisher row keyed on an aggregate source's own `canonical_url` should be
  `source_scoped_fallback` — an honest "unresolved author within this
  aggregate" placeholder, gated out of publisher-page navigability by the
  projector exactly as the schema always intended. This does not fix any
  already-stranded item on its own; it stops new instance-level rows from
  being mistaken for real identities.
- **(A) Give a stranded item a second chance when fresh evidence arrives.**
  Whenever a verification batch fetch succeeds for a URL, re-run the same
  containment check against any of that URL's *previously terminal*
  `unverified` checks, not just the ones newly pending in this batch. This
  directly fixes the observed failure (Paul's item) using the exact evidence
  and matching logic that already exists — no new trust shortcut.

**Approach B (make `unverified` retryable/backed-off in general, not just
opportunistically) was considered and explicitly rejected for this spec:**
it would also help an author whose *only* item ever raced and lost (a gap A
does not close), but changes a deliberate terminal-state design decision,
adds retry/backoff bookkeeping, and increases outbound fetch load — not
justified by what the live data shows (1 stuck item out of 58, and it belongs
to an author who has other, successfully-verified items). Left as a
documented non-goal, not silently dropped.

## The convert.ts adjudication, and why this spec reverses it

`core/src/migration/convert.ts:291-294` mints a publisher for every converted
legacy source, unconditionally `feed_anchored` — including aggregates — and
`convert.ts:303-307` unconditionally writes a `handle_reservations_v2` row
pointing at it, backing a **permanent** `/u/:handle` → `/p/:publisherId`
redirect. `convert.ts:280-290`'s comment ("ADJUDICATED 2026-07-24") explains
why: `resolvePublisher` (`projector.ts:647`) refuses anything that isn't
`feed_anchored`, so a `source_scoped_fallback` row would make that redirect
404 forever, and the same comment explicitly framed this as accepting one
uniform (if wrong) population to migrate later rather than two regimes to
reconcile.

This spec reverses that call. `identityLevelFor` now governs `convert.ts`'s
mint too, and `convert.ts` skips writing a `handle_reservations_v2` row when
the resulting identity is `source_scoped_fallback` — there is no real
identity there to permanently protect a redirect for, so writing one anyway
would just ship an unreachable redirect from the moment the row is created,
which is strictly worse than not promising one. The migration for existing
data (below) also removes any `handle_reservations_v2` row left pointing at a
publisher it is about to relabel, for the same reason: a reservation whose
target the projector will now refuse to resolve serves nobody by lingering.

### C — identity_level correctness

`getOrCreatePublisher` collapses to ONE function, in `reconcile.ts`, exported.
`verification.ts` already imports `applyPresentation`/`applySelectionHints`/
`recordReconciliationFailure` from `reconcile.ts` (one-way dependency, no
circularity) — it adds `getOrCreatePublisher` to that same import and deletes
its own copy.

New signature:

```typescript
function identityLevelFor(attributionMode: string): 'feed_anchored' | 'source_scoped_fallback' {
  return attributionMode === 'aggregate' ? 'source_scoped_fallback' : 'feed_anchored'
}

export function getOrCreatePublisher(tx: WriteTx, canonicalUrl: string, identityLevel: 'feed_anchored' | 'source_scoped_fallback', now: string): string {
  const r = tx.prepare(`SELECT id FROM remote_publishers_v2 WHERE canonical_feed_url = ?`).get(canonicalUrl) as { id: string } | undefined
  if (r) return r.id
  const id = randomUUID()
  tx.prepare(`INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, ?, ?)`).run(id, canonicalUrl, identityLevel, now)
  return id
}
```

Call sites:
- `reconcile.ts:257`: `getOrCreatePublisher(tx, source.canonical_url, identityLevelFor(source.attribution_mode), now)`.
- `verification.ts`'s call (currently its own copy, line 262): `getOrCreatePublisher(tx, batchKey, 'feed_anchored', now)` — literal, never `aggregate` at this call site, since it only ever runs for a freshly found/created `single_publisher` origin source.
- `convert.ts:291-294`: mint with `identityLevelFor(mode)` instead of the
  hardcoded `'feed_anchored'` literal, where `mode` is the same
  `attribution_mode` value already resolved earlier in that function for the
  source insert. `convert.ts:303-307`'s `handle_reservations_v2` insert moves
  inside an `if (identityLevelFor(mode) === 'feed_anchored')` guard — skipped
  for aggregates, unchanged for everything else.

No collision risk between the two `core/src/logical/` call sites' URL spaces:
`reconcile.ts` always calls with a source's *own* `canonical_url`;
`verification.ts` always calls with an *individually asserted author's* URL
from a freshly-found `origin_verification` source. An aggregate instance's
own firehose URL is never a real person's feed URL.

**Migration** (tail-appended to `MIGRATIONS` in `core/src/storage/sqlite.ts`,
pure SQL, no DDL — the `identity_level` `CHECK` already allows the target
value):

```sql
UPDATE remote_publishers_v2
SET identity_level = 'source_scoped_fallback'
WHERE identity_level = 'feed_anchored'
  AND canonical_feed_url IN (SELECT canonical_url FROM remote_sources_v2 WHERE attribution_mode = 'aggregate');

DELETE FROM handle_reservations_v2
WHERE publisher_id IN (
  SELECT id FROM remote_publishers_v2
  WHERE identity_level = 'source_scoped_fallback'
    AND canonical_feed_url IN (SELECT canonical_url FROM remote_sources_v2 WHERE attribution_mode = 'aggregate')
);
```

The `DELETE` runs after the `UPDATE` (same migration step, in order) so it
catches rows the `UPDATE` just relabeled in this same pass, not only
already-`source_scoped_fallback` rows from some earlier run. Idempotent (a
second run no-ops both statements), no FK cascade involved
(`handle_reservations_v2` has no foreign keys by design — the table
survives source removal — so this delete is the only way to retire a stale
reservation). No consequence for `publisher_claims_v2`/
`logical_items_v2.selected_publisher_id` (they keep referencing the same
row id — only its label changes, and a *different* row,
`handle_reservations_v2`, loses a now-meaningless entry). Current
`MIGRATIONS.length` is 17, pinned in four places in
`core/test/migrations.test.ts` (lines 19, 99, 135, 246 as of this writing —
re-verify against the file at implementation time) — this becomes migration
18; all four pins move to 18.

### A — opportunistic re-adoption

`resolveVerificationBatch` (`verification.ts`) currently pulls only:

```sql
SELECT id, logical_item_id, source_id FROM verification_checks_v2 WHERE batch_key = ? AND state = 'pending'
```

Widen to also pull previously-terminal ones sharing the same URL:

```sql
SELECT id, logical_item_id, source_id FROM verification_checks_v2 WHERE batch_key = ? AND state IN ('pending', 'unverified')
```

Every check in the widened set — old or new — runs through the existing
`matchContainment` call unchanged. A newly-matching previously-`unverified`
check promotes through the existing `persistVerifiedDelivery` path exactly as
a first-pass match does: a `verified_origin` publisher claim, `applySelectionHints`
re-derivation, and a journal upsert when the ordinary selection actually
changes. No new code path — the same evidence, the same match logic, just a
wider window of checks it gets to run against.

**Open implementation question (not yet decided, flag for the plan):** should
a re-promoted check's `verification_checks_v2.resolved_at` update to the retry
time, or preserve the original resolution time? Leaning toward updating it
(reflects when the check actually succeeded), but this is a one-line decision
best made against the real column's other uses at plan time, not guessed here.

## Testing

- `getOrCreatePublisher` mints `source_scoped_fallback` for an `aggregate`
  source's own URL, `feed_anchored` for a `single_publisher` source's URL and
  for verification's own origin-source mint.
- A migration test: a pre-migration fixture DB with an aggregate source's
  publisher row labeled `feed_anchored` AND a `handle_reservations_v2` row
  pointing at it (the exact shape a real legacy conversion produced pre-fix)
  — after migration, the publisher is relabeled to `source_scoped_fallback`
  AND the reservation is gone; a `single_publisher` source's publisher row
  and its reservation are both untouched. Idempotency: running the migration
  logic twice leaves the same end state.
- `migration-convert.test.ts:129-132,309-334`'s existing assertions (aggregate
  conversion mints `feed_anchored`; the live reconcile-onto-converted-row
  convergence test) update to assert `source_scoped_fallback` and no
  `handle_reservations_v2` row for the aggregate case — these are the exact
  tests this spec's rev 1→rev 2 change deliberately reverses, not
  incidental collateral, so the diff should read as an intentional flip, not
  a quiet deletion.
- The money test for A, replaying the real shape found in dev: item 1's
  verification resolves `unverified` (fetch succeeds, no containment match);
  item 2's verification later succeeds against the *same* batch URL — assert
  item 1's `verification_checks_v2` row flips to `verified`, its
  `logical_items_v2.selected_publisher_id` updates to the real per-author
  publisher, a `publisher_claims_v2` row with `evidence_level='verified_origin'`
  is inserted for item 1, and a journal upsert fires for item 1
  (`changeMask: 'author'`).
- A still-non-matching previously-`unverified` check stays `unverified` after
  a batch re-run that doesn't contain it (no regression — re-checking isn't
  the same as always-promoting).
- `projector.ts:501-503,646-647`'s existing `identity_level === 'feed_anchored'`
  gate needs no code change — add a test confirming a `source_scoped_fallback`
  publisher still correctly gets no publisher page / no navigable byline link
  (guards the assumption the whole design leans on, rather than trusting it
  silently).

## Non-goals

- No fix for an author whose *only* asserted item ever races and loses (that
  gap is Approach B, explicitly deferred — see Decided model above).
- No changes to `instance-governed-members` (stuck at plan-rev-1-not-ready) or
  `admin-governance-visibility` (draft rev 1) — both touch adjacent
  machinery (`verification.ts`'s mint path, admin surfacing of attribution
  state) but neither implements or blocks this fix; confirmed during this
  brainstorm, not assumed.
- No cap on how far back A's widened re-check reaches. Reasoned as bounded in
  practice — only items that ever unsuccessfully asserted the same URL, which
  given the mint cap and current live-data shape is small (1 out of 58 in the
  one aggregate instance sampled) — but not verified at full production scale
  across all 4 instances. If a future instance's stranded-item count turns out
  large enough to matter, that's a follow-up, not a reason to add speculative
  bounding now.
- No schema changes beyond the one data-only migration — `identity_level`'s
  `CHECK` already allows the value this spec starts writing.

*developed with the help of AI tools*
