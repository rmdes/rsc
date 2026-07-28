# Scalable ingest scheduler — spec review (2026-07-28)

Target: `docs/superpowers/specs/2026-07-28-scalable-ingest-scheduler-design.md`
(rev 1, 249 lines). Ponytail pass only — over-engineering hunt, correctness out
of scope. Grounded against `core/src/logical/scheduler.ts`, `store.ts`,
`acquisition.ts`, `runtime.ts`, `schema.ts`, `push.ts`, `types.ts`,
`core/src/config.ts`, `core/src/api/app.ts`, and the `healMembers` /
`instanceStats` precedents.

**Verdict: ready to proceed. One shrink worth folding as rev 2 (§4's headroom
multiplier), one optional simplification for §4's new metrics. Nothing here
rises to a blocking rev — the four config knobs, the per-host cap, and the
new `failureCategory` value are all directly grounded, not speculative.**

## Cleared (scrutinized, not cuttable)

- **L176-184 (4 config knobs, incl. existing `RSC_POLL_SECONDS`): clean.**
  The operator's stated goal (L51-55: "operator-tunable... no code change...
  only a restart") explicitly rules out a hardcoded or manually-retuned
  constant, and all four follow the existing `positiveInt('RSC_..._', ...)`
  pattern verified live in `core/src/config.ts:25-29,92`. This is the
  established knob shape, not new ceremony.
- **L146-164 (`RSC_INGEST_MAX_PER_HOST`): clean, not premature.** Checked
  whether host overlap in the ~155-source catalog is hypothetical —
  `docs/superpowers/reviews/2026-07-25-instance-governed-members-spec-review.md`
  already treats "rss.chat IS a hosted service" (many distinct
  `remote_sources_v2` rows sharing one host) as a real, load-bearing case the
  membership-cascade design had to exclude explicitly. The scenario this cap
  guards against is already an established fact about this catalog, not a
  guess. The mechanism itself (an in-process `Map<host, count>` ceiling)
  matches the `inFlightMap` precedent (`acquisition.ts:671`) exactly — no new
  complexity class, just one more bounded in-memory counter.
- **L133-172 (self-pacing `batchSize = catalogSize / ticksPerCycle`): clean,
  and not swappable for a simpler fixed-count LIMIT.** Considered the
  obvious alternative — a flat "N sources per tick" env var — and it fails
  the operator's own requirement: it would need a manual bump every time the
  catalog grows materially, which is exactly the "revisit via more code
  changes as the catalog grows" (L36-38) the operator ruled out. The
  time-based target is the only one of the two shapes that stays correct
  set-once. `ticksPerCycle`/`batchSize` is a few lines of arithmetic re-run
  each tick against one indexed `COUNT(*)`, not a new subsystem.
- **L211-221 (`failureCategory: 'interrupted'`): clean.** Read the existing
  union (`types.ts:209-211`): `network | timeout | http | body_limit |
  feed_parse | policy | superseded`. Traced every live assignment site
  (`acquisition.ts:364,367,387,394,539,689,756,762`) — each existing category
  is bound to a real fetch/parse/policy outcome. None fit "the process was
  killed mid-run"; reusing `superseded` (which the type declares but which
  the codebase pairs with an unrelated "a newer run already claimed this
  row" race, `reconcile.ts`/`fanout.ts`) would misdescribe the orphan in any
  future admin diagnostic view. The column is free-text with no CHECK
  constraint (confirmed: no CHECK on `failure_category` in `schema.ts`), so
  this is a one-line TS union widen, zero migration cost — about as cheap as
  a new enum value gets.

## Findings

- `2026-07-28-scalable-ingest-scheduler-design.md:L142-144`: **shrink:** the
  `LIMIT batchSize*2` → JS-filter(push-lease + in-flight) → take-first-N
  two-stage dance exists "for headroom... without a second query round-trip"
  — but `hasActivePush` (`push.ts:213-215`) is already a DB-backed lookup
  (`store.findPushRow`), and this codebase has *already measured* that an
  extra indexed lookup here costs ~1ms with zero round-trip cost
  (`2026-07-25-sqlite-perf-hardening.md`: "each of the ~300 statement calls
  is a sub-millisecond index seek... there is no round-trip cost" — same
  in-process better-sqlite3, no network hop). Fold the push-lease exclusion
  into the staleness query itself (`AND NOT EXISTS (SELECT 1 FROM
  <push-lease table> WHERE unexpired AND active)`), `LIMIT batchSize`
  exactly. Only the in-flight check has to stay a JS filter afterward (it's
  genuinely in-process, per the spec's own non-goal at L83-85) — and that
  set is bounded by `RSC_INGEST_CONCURRENCY` (single digits), so it barely
  erodes a batch. Cuts the arbitrary `×2` constant, the two-stage filter,
  and the "what if filtering knocks out more than half the batch"
  under-fill risk, for one added `NOT EXISTS` clause the codebase's own
  numbers say is free.
- `2026-07-28-scalable-ingest-scheduler-design.md:L188-193`: **yagni-ish:**
  two of the four `/admin/overview` fields don't fit the existing pattern.
  Every current field in that handler (`app.ts:425-429`) is a live query
  computed fresh per request — `service.instanceStats` →
  `repo.instanceStats` (`repository.ts:17`, `sqlite.ts:410`), no cached
  state. "Catalog size" and "most-overdue source's staleness" fit that
  pattern directly (both are one indexed query each, using the new
  `last_poll_at` index). But "last cycle's actual wall-clock duration" and
  "sources attempted last tick" as specified require *new* in-memory
  bookkeeping added to the scheduler's closure — a state category none of
  the sibling fields need, and one the spec's Testing section never
  mentions verifying (resets silently on restart, race with concurrent
  `/admin/overview` reads mid-tick). Both numbers are already reconstructible
  from the durable `acquisition_runs_v2` table (`started_at`/`completed_at`
  for rows in the last `RSC_POLL_SECONDS` window give both attempted-count
  and cycle span) — deriving them from that table instead keeps every
  `/admin/overview` field on the same "computed fresh from durable state"
  footing and avoids adding scheduler-closure mutable state for a debug
  readout.

## Non-findings worth naming

- Non-goals (L65-85) already prune worker-threads/multi-process ingest,
  adaptive per-host backoff/robots.txt honoring, and the force-refresh
  trigger — correct scope discipline, nothing to add to that list.
- No new dependency: confirmed `core/package.json` has no queue/semaphore
  library (`p-limit`, `p-queue`, `bottleneck`, etc.) — the bounded-concurrency
  pool + per-host cap has to be hand-rolled either way, and a Map-based
  counter is the right size for it (roughly what `inFlightMap` already is).
  Not flagging "reinvented p-limit" — pulling in a dependency for a ~15-line
  counter would be the over-engineering move here, not the reverse.

net: -1 magic constant (the `×2` headroom multiplier), -1 new mutable-state
pair on the scheduler (cycle duration / attempted count), possible with the
two shrinks above; everything else in the spec is proportionate to the
operator's explicit ask.

*developed with the help of AI tools*
