# SQLite read-path performance hardening (2026-07-25)

Trigger: operator reported every v2 timeline tab taking 4–6s on `rsc.rmdes.be`
(the main instance) since the v2 cutover; bob/alice were fast. v1 was never
laggy even with 100+ feeds.

## Root cause (confirmed, not guessed)

SQLite never auto-indexes foreign keys. The v2 read path (the projector) looks
up many v2 tables **per timeline item** by FK/lookup columns — eligible
deliveries, the `REMOTE_VISIBLE` ordinary-visibility gate (evaluated per row),
reply counts (`logical_items_v2.parent_logical_item_id`), publisher claims,
publisher names — and those columns had **no index**. Every lookup was a full
table SCAN. On main (`logical_identity_keys_v2` = 32,267 rows) a 50-item
timeline did hundreds of full scans (~2s), and live federation ran the same
scans in the background, pinning core at 100% CPU. bob/alice have tiny tables,
so their scans were cheap — the size-dependence was the tell.

Measured on a copy of the live DB: 50 per-item opaque+delivery lookups
**478ms → 1ms (478×)** once indexed; EXPLAIN flips `SCAN` → `SEARCH USING INDEX`.

## Fixed + deployed

- **Migration 16** (`LOGICAL_PERF_INDEXES`): `logical_identity_keys_v2(logical_item_id)`.
- **Migration 17** (`LOGICAL_PERF_INDEXES_2`): 19 indexes covering **every**
  remaining un-indexed v2 FK column (exhaustive `foreign_key_list` audit).
- **Read PRAGMAs** at connection open: `mmap_size=256MB`, `cache_size=64MB`,
  `temp_store=MEMORY`, `PRAGMA optimize` after migrate (kept WAL + FK).
- **Guardrail** (`core/test/logical-fk-indexes.test.ts`): reflective invariant —
  every `%_v2` FK column must be the leftmost column of an index; fails CI
  naming any offender. This is the "never again": no future v2 table/FK can
  ship un-indexed. Plus a SCAN-check on the two hottest projector lookups.

**Result on main: `/timeline` ~2000ms → ~40ms (~50×)**, consistent, and
background-federation CPU contention eased.

## Also fixed: SSE reset storm (separate, client-side)

A browser trace found the v2 `/stream` client (`web/src/routes/+page.svelte`)
did a full `invalidateAll()` on **every** barrier reset. Barrier resets are
legitimate — appended when governance/moderation/reconciliation changes ordinary
visibility (`source-repository.ts:244`, `tombstones.ts:209`, `local.ts:282`,
`store.ts`, `runtime.ts`). But a cluster of changes (approving several
federation sources, a reconciliation pass) produced back-to-back full reloads
that churned and serialized with the user's own navigation. Fixed by coalescing
resets onto one ~1s-cooldown refetch (bounds reloads to ~1/s under a burst).
The painful latency was the un-indexed query above; this removes the churn.

## Deferred (measured, spec-ready): projector N+1

**Measurement (provenance for the deferral).** Dated 2026-07-25, taken on
`rsc.rmdes.be` (main, production), core fully indexed (migrations 16+17),
`logical_identity_keys_v2` ≈ 32,267 rows. `/timeline` server-side, best-of-4,
in-process:

| limit | 1 | 10 | 25 | 50 | 100 |
|---|---|---|---|---|---|
| ms | 5 | 9 | 18 | 33 | 59 |

Linear at **~0.55ms/item**. The projector fires ~6 queries per item; batching
each query-type across the page (`WHERE id IN (…)` / JOINs) would cut 50 items
~33ms → ~10ms and drop ~300 statement calls/request to ~6 — a CPU/throughput
win under concurrency.

**Why there is no hidden cliff behind the 0.55ms.** The classic N+1 killer is
the per-query network round trip. This is better-sqlite3 — in-process,
synchronous — so each of the ~300 statement calls is a sub-millisecond index
seek with **zero round-trip cost**. The measured 0.55ms/item is the whole
story; there is no cliff to fall off as the page grows, only the linear slope.
33ms server-side for a full page is imperceptible by an order of magnitude.

**Decision (operator, 2026-07-25): DEFER.** Rationale: (1) no round-trip cliff,
so the gain is a felt-nothing latency shave; (2) extreme risk asymmetry — the
projector is the most load-bearing read component and this week's hardest bugs
(byline, visibility, origin-guid) lived in its per-item logic, so restructuring
its query shape for an imperceptible gain inverts the week's lesson; (3) the
partial/"batch some" middle path is a TRAP not a compromise — mixing batched
and per-item idioms creates a fresh lockstep-drift surface, the exact defect
class this milestone fought; (4) wrong moment — the milestone's next step is
push→dark-deploy→soak, and a projector rewrite would put churn into the very
code being shipped and spend review budget the cutover needs. The catastrophic
class (table scans) is already fixed and guarded by the FK-coverage test — this
is the system working: measure first, refactor only when the measurement says
so.

**Promotion trigger (testable — revisit when ANY holds):**
- server-side `/timeline` **p95 > ~150ms**, or
- default page size **> 200 items**, or
- sustained **real multi-user concurrency** on an instance (the synchronous
  event loop becomes the bottleneck, where cutting 300 statement calls → ~6
  per request actually pays).

**Spec seed when promoted:** batch `projectTimeline`'s per-item reads —
eligible-deliveries, reply-counts (`replyCounts`/`childIds`), selected-author
(`remoteAuthor`/publisher-names), classification, and `materialOf` — into
page-wide queries keyed by the page's item ids, assembled in memory. Do it as a
proper brainstorm→spec→plan→SDD milestone (NOT the partial middle path). The
1084 projector tests are the safety net; keep flag-off byte-identical and both
`test.fails()` markers.

*developed with the help of AI tools*
