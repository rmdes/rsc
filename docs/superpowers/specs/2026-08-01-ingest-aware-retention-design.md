# Ingest-Aware Retention — Design

**Status:** Draft (brainstormed 2026-08-01, from a live root-cause investigation)

**Goal:** Stop the retention delete↔re-ingest churn loop while keeping both
retention caps (per-source item count + item age). Items outside a source's
retention window are **never ingested**, instead of being ingested-then-deleted
and re-ingested every poll.

## Background — the bug (root-caused live 2026-08-01)

`trimSourceToCap` runs after **every** poll (`runtime.ts:412-433`) and deletes
the deliveries + observation-versions of items older than `maxAgeDays` or beyond
`maxCount` (`tombstones.ts:244-250`). But the source's feed **still serves those
items**, so the next poll's `commitAcquisition` finds no delivery
(`findDelivery` miss, `acquisition.ts:632`) → creates a **new** delivery +
version + reconciliation job → the old item resurfaces as "new" and fires a
journal `upsert` to every firehose client → the trim deletes it again → forever.

**Confirmed on the live fleet (read-only):** rsc.rmdes.be (caps 200 items /
120 days) spawned **1342 new deliveries/hour, all brand-new delivery rows**,
re-ingesting **2020–2021** back-catalog every poll. rsc.rmendes.net has the
same caps but is healthy — its feeds are under-cap, so retention never fires.
The `runtime.ts:426` comment anticipated repeated trims but assumed trimmed
items *stay gone*; nothing guards re-ingestion. This is independent of the
fingerprint fix (that works: 6/1343 recent versions carried `published`); it
surfaced when the caps were set. See [[remote-content-retention-milestone]],
[[obs-versions-runaway-purge]].

## The fix (Approach A): an ingest gate + a stored content-date

### 1. Content-date on the delivery (`deliveries_v2.content_sort_at`)

The count cap needs "the date of the source's N-th-newest item" **at commit
time**, but `logical_items_v2` (which today's trim keys off via
`timeline_sort_at`) don't exist yet at commit (reconciliation creates them
later). So store the item's effective content-date on the delivery when it's
created, using the **exact same formula reconciliation uses** for
`timeline_sort_at` (`reconcile.ts:379`):

```
content_sort_at = (pub && pub <= arrival) ? pub : arrival
```

where `pub` = the item's parsed published date (`rawDate`), `arrival` =
`committedAt`. Dateless items → `arrival` (recent) → never age-gated, matching
timeline behavior; a real 2020 date ≤ arrival → `2020` → correctly gated.

- **Migration** (append to `MIGRATIONS` in `sqlite.ts`): `ALTER TABLE
  deliveries_v2 ADD COLUMN content_sort_at TEXT` + `CREATE INDEX
  idx_deliveries_v2_source_sort ON deliveries_v2(source_id, content_sort_at)`.
- **Backfill:** populate existing rows from each delivery's newest observation
  version's date (same formula), so the count floor is correct immediately;
  rows with no derivable date stay NULL and are treated as "keep" (never gated
  out — conservative). *(Plan resolves the exact backfill SQL.)*

### 2. The ingest gate — in `commitAcquisition`, on the NEW-delivery branch only

In the observation loop (`acquisition.ts:627`), the gate applies **only when
about to create a new delivery** (`existing === undefined`, line 633) — an
already-tracked delivery getting a new version (a genuine edit) is never gated
out; the trim handles items that cross a threshold while stored. Before
`insertDelivery`, compute `contentDate` for the observation and skip if the
source's window excludes it:

- **Age:** `maxAgeDays > 0 && contentDate < (now − maxAgeDays)` → skip.
- **Count:** `maxCount > 0 && (count of this source's deliveries with
  content_sort_at > contentDate) >= maxCount` → skip (it's below the newest-N
  floor).

"Skip" = create **no** delivery, version, or job; increment a new
`retentionFiltered` counter (added to `AdminAcquisitionCounters`) so the
filtering is observable in admin acquisition stats, not a silent black hole.

This is the whole loop-breaker: an out-of-window item the feed re-serves is
never re-created, so there is nothing for the trim to delete and re-detect.

### 3. Keep `trimSourceToCap` (threshold-crossers)

The gate handles *incoming* items; the trim still handles *stored* items that
cross a threshold over time — an in-window item that ages past the cutoff, or
that falls below the newest-N as the source accrues newer items. It is now
loop-safe: once trimmed, the gate blocks re-ingestion. **Open decision (resolve
in the plan):** switch `trimSourceToCap` to key off `deliveries.content_sort_at`
for one consistent date source, vs. keep `logical_items.timeline_sort_at`. They
should agree by construction (same formula); a single source is less to reason
about.

### 4. Live settings, threaded into the commit path

The caps are read live today in `runtime.ts` (so an admin change takes effect
next poll, no restart). The gate needs them **during** `acquireSource`, before
the trim. Thread the live caps into the commit path — via an injected
`getRetentionCaps()` on the acquisition engine (same `getSetting` source
`runtime.ts` uses) or a per-call parameter — so the gate and the existing trim
read the same live values in the same poll.

## Load-bearing invariants

- **`maxCount = 0` and `maxAgeDays = 0` ⇒ gate disabled** (ingest everything —
  today's default behavior; unlimited). Both-zero is the inert default.
- **Local items are never gated** (origin = remote / from a source only), same
  exemption the trim already has.
- **The gate's date formula MUST equal `reconcile.ts`'s `timeline_sort_at`
  formula.** If they diverge, the gate, the trim, and the timeline sort would
  disagree about an item's age — the whole point is one consistent notion of
  "how old is this item."
- **No user-facing data migration / no re-import.** On deploy the existing
  over-window backlog is trimmed once and stays gone (gate blocks re-ingest) →
  the churn self-converges. `content_sort_at` is backfilled by the migration.
- House style: hand-rolled, `app.request` tests, `c.json` (invoke the `hono`
  skill for any route touch — though this feature is mostly in the logical
  layer, not HTTP).

## Testing

- **core** (`core/test/`):
  - Gate skips an over-age incoming item on a NEW delivery: no delivery/version/
    job created, `retentionFiltered` incremented; a within-age item still
    ingests fully.
  - Gate skips an over-count incoming item (source at `maxCount`, item older
    than the floor); a newer-than-floor item ingests and pushes the oldest below
    the floor.
  - **Loop is dead:** poll an over-window feed twice (same items) → zero new
    deliveries on the second poll (today: N new deliveries every poll).
  - `maxCount = 0 && maxAgeDays = 0` → gate inert, everything ingests.
  - An existing in-window delivery still records a genuine edit (new version) —
    the gate does not block updates to already-tracked items.
  - `trimSourceToCap` still removes a stored item that crossed a threshold.
  - `content_sort_at` is set on new deliveries using the reconcile formula
    (published ≤ arrival ? published : arrival).
- Migration test: the column + index are created; backfill populates existing
  rows; NULL content_sort_at is treated as "keep."

## Out of scope (YAGNI)

- Per-user retention (this is instance-wide, per-source, as today).
- Changing the admin UI or the cap semantics (still count + age, 0 = unlimited).
- The form-reset bug on `/admin/settings` (separate one-line fix, already made).
- A retroactive purge of already-created duplicates (the trim converges them).

## Execution

Spec → user review → clean-context spec review (`docs/superpowers/reviews/`) →
`superpowers:writing-plans` → `superpowers:subagent-driven-development`. Touches
the logical/acquisition core (a load-bearing subsystem) + one migration, so the
plan and a whole-branch review on the most capable model both matter.
