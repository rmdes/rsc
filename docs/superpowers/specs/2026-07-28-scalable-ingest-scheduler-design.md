# Scalable ingest scheduler

Status: rev 1 (2026-07-28)

## Motivation

Investigating a live "tab switching feels slow" report on rsc.rmdes.be
(2026-07-28), the actual `projectTimeline` query cost measured against the
production DB was 7-18ms — fast. Hitting core's `/timeline` internally instead
showed all three lenses (`local`, `public`, `federated`) uniformly stalling at
~2.5-2.8s TTFB, regardless of query complexity. Cross-referencing
`acquisition_runs_v2.started_at` timestamps showed why: the poll scheduler
(`core/src/logical/scheduler.ts`) doesn't spread its work evenly across its
`RSC_POLL_SECONDS` interval — it crams 40-75 of the ~155 registered sources'
fetch+parse+commit cycles into a 20-30 second burst, then goes idle for the
rest of the ~90s cycle:

```
08:30:00  45 runs
08:30:10  19 runs
        (idle ~60s)
08:31:20  52 runs
08:31:30  21 runs
```

The scheduler already has one mitigation for this — a `breather` (one
`setImmediate` yield between each source's acquisition, added as a documented
past perf fix, see the comments at `scheduler.ts:16-35`) — but at ~155 sources
one yield per source isn't enough headroom: whether a page load lands inside
or outside the burst window determines whether it takes 300ms or 3 seconds.

This is a scheduler-design ceiling, not a database problem: SQLite is
correctly configured (WAL, `synchronous=NORMAL`, `busy_timeout=5000`, sane
`mmap_size`/`cache_size` — verified live), every join in the hot query path is
covered by a PK/UNIQUE index, and the DB itself is a healthy 259MB with no
runaway table. The operator's ask, given this, is explicit: **feed count
should never again become a problem, at any scale**, tuned by the operator
rather than revisited via more code changes as the catalog grows.

Separately, the same investigation found ~31 `acquisition_runs_v2` rows stuck
at `status='processing'` since 2026-07-25, orphaned by a past process restart.
Confirmed harmless (see §Orphaned-run heal) but worth fixing as part of the
same pass.

## Goals

1. **Decouple feed count from HTTP latency, structurally, not by tuning a
   constant.** No feed count, however large, should be able to make the
   scheduler starve the HTTP-serving event loop for a noticeable slice of
   wall-clock time.
2. **Operator-tunable, not hardcoded.** The knobs that govern throughput
   (how many sources to attempt, how many run at once, how polite to be to a
   single remote host) are environment variables with sane defaults, the same
   pattern `RSC_POLL_SECONDS` already establishes. No code change is needed
   to retune as the catalog grows — only a restart.
3. **Graceful degradation, visible to the operator.** If the configured
   concurrency genuinely can't sustain the operator's target refresh cadence
   at the current catalog size, the cadence should silently stretch rather
   than ever blocking HTTP — and the operator should be able to see this
   happening (via `/admin/overview`) so they know to raise concurrency rather
   than discover degraded freshness by accident.
4. **Self-repair orphaned acquisition runs** left `processing` by a past
   process restart, on every startup, unconditionally and safely.

## Non-goals

- Worker-thread or multi-process ingest. Measured commit cost on the live DB
  is <20ms and per-feed parse cost is normally low single-digit ms; a
  single-thread pipeline with fine-grained yields has enough headroom for any
  realistic catalog size without the complexity of a cross-thread pipeline
  (message serialization, reworking the synchronous acquisition/test model).
  If the new `/admin/overview` cycle metric ever proves CPU is the real
  ceiling, that's a contained follow-up (swap the parse step for a worker
  pool) — not a reason to build it now.
- Outbound-politeness caps beyond a simple per-host concurrency ceiling
  (`RSC_INGEST_MAX_PER_HOST`). Anything smarter (adaptive backoff per host,
  robots.txt-style crawl-delay honoring) is future backlog.
- A manual force-refresh trigger. `docs/superpowers/ideas.md`'s existing
  "Force-refresh" backlog entry names the same scheduler and the same
  bounded-concurrency mechanism for a manual/admin-triggered re-poll; it can
  reuse the pool this spec builds, but building the trigger itself is out of
  scope here.
- Changing `acquireSource`'s per-source semantics, its `inFlightMap` guard, or
  the commit transaction shape. Those are correct today and untouched; only
  the scheduler's *dispatch* loop changes.

## Current mechanics (grounding)

- `core/src/logical/scheduler.ts` `pollDue()`: a strictly serial `for` loop
  over `store.listSchedulableSources()`, `await`ing each due source's
  `acquisition.acquireSource()` in turn, with one `breather()` yield between
  sources.
- `core/src/logical/store.ts:671` `listSchedulableSources()`: returns **every**
  schedulable source (`ORDER BY s.id ASC`, no LIMIT, no staleness filter) —
  the JS loop does the recency check (`skip-if-recent`) per source itself.
  This is O(catalog size) work every tick even when almost nothing is due.
- `source_health_v2` (schema.ts:144): `source_id TEXT PRIMARY KEY, last_poll_at,
  last_success_at, last_failure_at, consecutive_failures` — no index on
  `last_poll_at`.
- `core/src/logical/acquisition.ts:671` `inFlightMap`: an in-process `Map`,
  keyed by `sourceId`, guarding against a second concurrent acquisition for
  the *same* source. Concurrent `acquireSource()` calls for *different*
  sources are already safe — each is its own claim/commit transaction pair.
- Push-subscribed sources already poll at a reduced cadence
  (`PUSH_POLL_FACTOR = 10`, scheduler.ts:63) via `deps.push.hasActivePush()`.

## Design

### 1. Push "who's due" into SQL, staleness-ordered, LIMIT-bounded

Replace `listSchedulableSources()`'s unbounded, arbitrarily-ordered query with
one that:

- Joins `source_health_v2` and computes each source's effective interval
  (`RSC_POLL_SECONDS`, or `× PUSH_POLL_FACTOR` for a source with an active
  push lease — same rule as today, moved into SQL).
- Filters to only currently-overdue sources.
- Orders **oldest-`last_poll_at`-first, NULLs first** (never-polled sources
  are the most overdue by definition) — fairness under load: today's
  `ORDER BY id ASC` risks starving sources that sort late in ID order once a
  catalog is large enough that not everyone fits in one tick's batch, which is
  now true by design (see below).
- Is `LIMIT`-bounded to a small multiple of the tick's batch size (see §2),
  not the whole catalog.

New index: `source_health_v2(last_poll_at)`, needed to keep this query
index-supported (not a full-table sort) at any catalog size.

The push-lease check (`hasActivePush`) and the `inFlightMap` in-flight check
stay as a final, cheap JS filter applied to the small candidate batch the SQL
query returns — not to the whole catalog.

### 2. Self-pacing batch size + bounded concurrency

Every tick (`RSC_POLL_SECONDS`, unchanged):

```
catalogSize   = COUNT(*) of schedulable sources          // cheap, indexed
ticksPerCycle = ceil(RSC_INGEST_CYCLE_MINUTES * 60 / RSC_POLL_SECONDS)
batchSize     = max(1, ceil(catalogSize / ticksPerCycle)) // self-adjusts, no hardcoded count

due = staleness-ordered query above, LIMIT batchSize * 2  // headroom for the
      push-lease/in-flight filter below without a second query round-trip
      → filter push-lease + in-flight → take first `batchSize`

run `due` through a bounded pool:
  - at most RSC_INGEST_CONCURRENCY in flight at once
  - at most RSC_INGEST_MAX_PER_HOST in flight to the same remote host
  - reuses acquireSource() unchanged
  - after each source's fetch+parse+commit resolves: yield (existing
    breather), then dispatch the next
```

This gives two independent pacing dials:

- **How much is attempted per tick** — self-computed from catalog size, so
  the operator declares a *target cycle time* (how fresh they want the whole
  catalog to be), not a feed count. As the catalog grows, `batchSize` grows to
  compensate automatically; no code or config change needed.
- **How much runs at once** — an explicit ceiling on simultaneous
  network+CPU load (`RSC_INGEST_CONCURRENCY`), so a burst never happens
  regardless of catalog size, plus a per-host ceiling
  (`RSC_INGEST_MAX_PER_HOST`) so a catalog with many sources on one popular
  host doesn't hammer it.

If concurrency genuinely can't sustain the target cycle time at the current
catalog size (e.g. thousands of sources but `RSC_INGEST_CONCURRENCY` left at
a conservative default), the *actual* cycle time lengthens beyond
`RSC_INGEST_CYCLE_MINUTES` — HTTP is never affected, freshness degrades
gracefully — and this is visible in the new `/admin/overview` metric (§4) so
the operator can raise concurrency deliberately rather than discover stale
feeds by accident.

### 3. Config surface

| Var | Meaning | Default |
|---|---|---|
| `RSC_POLL_SECONDS` (existing) | tick interval | 60 |
| `RSC_INGEST_CYCLE_MINUTES` (new) | target time to cycle the whole catalog once | 30 |
| `RSC_INGEST_CONCURRENCY` (new) | max simultaneous in-flight fetches | 8 |
| `RSC_INGEST_MAX_PER_HOST` (new) | max simultaneous fetches to one remote host | 2 |

All follow the existing `positiveInt('RSC_..._', env.RSC_..._ ?? 'default')`
pattern in `core/src/config.ts`.

### 4. Observability

`/admin/overview` (`core/src/api/app.ts:425`, already exists) gains a small
scheduler-stats block: last cycle's actual wall-clock duration, sources
attempted last tick, catalog size, and the most-overdue source's staleness
(`now - oldest last_poll_at` among schedulable sources). This is the signal
that turns "cadence silently stretched" from an invisible degradation into
something an operator can act on.

### 5. Orphaned-run heal

`core/src/logical/acquisition.ts`'s `inFlightMap` (line 671) is an in-process
`Map`, created empty on every process start. Before `scheduler.start()` has
run even once on a fresh process, that map is empty by construction — so any
`acquisition_runs_v2` row still `status='processing'` at that exact moment
cannot belong to this process; it predates this boot and its owning process
is gone. This is certain, not a timeout heuristic.

Confirmed harmless today: `claimAcquisition` (acquisition.ts:460) never
checks the DB for an existing `processing` row before starting a new one —
only the in-memory map guards against a double-claim — so these orphans don't
block re-polling. They're wrong bookkeeping, not a functional bug, but worth
healing since a stuck `processing` row misleads any future admin view of
"is this source stuck?"

**Fix**, following the same pattern as `healMembers()`
(`core/src/logical/membership.ts:93` — a self-contained atomic transaction):
a new `healOrphanedRuns(tx, now)` in `acquisition.ts` that unconditionally
terminalizes every `processing` row: `status='terminal'`,
`outcome='operational_failure'`, a new `failureCategory: 'interrupted'` value
(added to the union at `types.ts:209-211`), `diagnostic: 'orphaned by process
restart'`, `completed_at = now`. Wired into `runtime.ts`'s `ready` IIFE
(`runtime.ts:435-447`), right after `activateLogicalV2` and before
`drainSync()` — the same pre-listen, no-network-I/O slot startup
reconciliation already uses. No operator toggle: unconditionally safe by
construction.

## Testing

- `pollDue()` is already exposed for deterministic tests (no wall-clock
  timers) — the existing test harness pattern is preserved; concurrency is
  tested by controlling the order in which a mock `fetchFn`'s promises
  resolve, not by real timing.
- New test: staleness-ordering — sources with older `last_poll_at` are
  chosen before newer ones when catalog size exceeds one tick's `batchSize`.
- New test: `batchSize` self-adjusts correctly for a given
  `catalogSize`/`RSC_INGEST_CYCLE_MINUTES`/`RSC_POLL_SECONDS` combination.
- New test: `RSC_INGEST_CONCURRENCY` and `RSC_INGEST_MAX_PER_HOST` are
  actually respected (never more than N in flight globally, never more than M
  to one host) under a batch that exceeds both.
- New test: `healOrphanedRuns` terminalizes every `processing` row
  unconditionally and is a no-op when none exist.

## Rollout

- Migration: one new index (`source_health_v2(last_poll_at)`).
- No schema change for `acquisition_runs_v2` (outcome/failure_category are
  free-text, no CHECK constraint to update).
- Deploy to rsc.rmdes.be first (the instance that surfaced this), verify the
  `/admin/overview` cycle metric looks sane, then the other 3 instances.
- `docs/superpowers/ideas.md`'s "Force-refresh" entry should be annotated to
  reference this spec's bounded-concurrency pool as the mechanism it would
  reuse, once written.
