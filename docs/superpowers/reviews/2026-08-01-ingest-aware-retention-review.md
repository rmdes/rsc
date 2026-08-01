# Review — Ingest-Aware Retention Design (2026-08-01)

Reviewer: clean-context. Spec under review:
`docs/superpowers/specs/2026-08-01-ingest-aware-retention-design.md`.
Code read at current `main` (post-`00bc235`).

## Verdict

The core mechanism is sound: an ingest gate on `commitAcquisition`'s
new-delivery branch, using the incoming item's **real published date**
(`it.rawDate`), does break the delete↔re-ingest loop — the age half needs **no
schema at all**, and the count half legitimately needs a stored, indexed date.
Feasibility against the real code is good (branch, plumbing, migration pattern
all line up). **But the spec is written on a pre-`00bc235` mental model that no
longer matches the code: it asserts `content_sort_at` equals reconcile's
`timeline_sort_at` "by construction," and since the fingerprint fix
(`00bc235`, 2026-07-31) `timeline_sort_at` silently became `arrival` for every
remote item.** The two dates now diverge, and Invariant #3 — "the gate's
formula MUST equal `timeline_sort_at`" — if followed literally, would make the
gate compute `arrival` and **break the fix**. That contradiction, plus the
convergence claim it undermines, must be resolved before planning. Not a
redesign — a correction of which date each of the three consumers reads, and a
decision on whether to repair the regression. Plan-ready once the Criticals are
folded.

## Findings

### Critical

**C1 — `content_sort_at` does NOT equal `timeline_sort_at` on current `main`;
Invariant #3 as written breaks the fix. (must-fix-before-planning)**
The spec pins `reconcile.ts:379`
`timelineSortAt = pub && pub <= arrival ? pub : arrival` and says
`content_sort_at` uses the same formula, "should agree by construction." They
do not agree. In `reconcile.ts:260`, `material` is parsed from
`canonical_material` (`const material = JSON.parse(v.canonical_material...)`),
and commit `00bc235` **removed `published` from `canonicalMaterialFor`**
(`acquisition.ts:262-282` — there is no `published` key anymore). So at
reconcile time `material.published === undefined` → `normalizeUtc(undefined) ===
null` → **`timeline_sort_at = arrival` for every remote item**, unconditionally.
Verified by executing the exact literal (published field absent → `pub = null` →
result equals arrival).

The spec's `content_sort_at`, by contrast, is computed from `it.rawDate`
(`acquisition.ts:324` still carries `published: it.rawDate` in
`raw_evidence_json`), i.e. the **real** publish date. So:

- `content_sort_at` for a 2020 back-catalog item = `2020` (real date).
- `timeline_sort_at` for the same item = `arrival` (recent).

Consequences the spec gets wrong as a result:
1. **Invariant #3 is actively dangerous.** "The gate's date formula MUST equal
   `timeline_sort_at`" — a maintainer enforcing that by reading the item's date
   the way reconcile does (from canonical material) would compute `arrival` for
   everything, the age gate would never fire, and the loop would reopen. The
   invariant must be inverted: the gate must use the **real published date**
   (`rawDate`), which is exactly what breaks the loop.
2. **The §3 "open decision" is not a no-op.** Switching `trimSourceToCap` from
   `timeline_sort_at` to `deliveries.content_sort_at` changes the age cap from
   "age since arrival" to "age since publication" — a real behavior change, not
   "one consistent date source." Choose deliberately; don't frame it as
   equivalence.
3. **The convergence claim (Invariant #4 / §Load-bearing) is wrong for the age
   cap.** On deployed fixed code, existing already-ingested 2020 duplicates have
   `timeline_sort_at = arrival = recent`, so the age trim (`tombstones.ts:246`,
   `r.timelineSortAt < cutoff`) will **not** remove them. Only the count trim
   (`rows.slice(maxCount)`) will. The "trimmed once and stays gone → self-
   converges" story holds via the count cap, not the age cap as implied.

Fix: pick one of two coherent positions and state it in the spec, then in the
plan:
- **(A, recommended)** Treat `00bc235` as having regressed `timeline_sort_at`
  and repair it: have reconcile read `published` from `raw_evidence_json` (it
  already parses that blob at `reconcile.ts:264` for title/sourceName) so
  `timeline_sort_at` again reflects the real publish date. Then gate, trim, and
  timeline genuinely agree on `rawDate`, Invariant #3 becomes true, and
  convergence works as written. This is a small, self-contained fix and is what
  the spec clearly intends.
- **(B)** Keep `timeline_sort_at = arrival` deliberately, and rewrite Invariant
  #3 to say the gate uses the **published** date while timeline sorts by
  arrival — explicitly acknowledging the two are different notions, and defining
  each consumer's date source. Uglier and leaves the divergence live.

**C2 — The only test covering `timeline_sort_at`-from-published is stale and
gives false confidence. (must-fix-before-planning — at least acknowledge)**
`core/test/logical-reconcile.test.ts:324-333` asserts `timeline_sort_at` equals
the published date, and passes — but its `seedJob` helper (line 66) hand-builds
`canonical_material` **with** `published: m.published ?? ''`, a shape the
production `canonicalMaterialFor` no longer emits. The test validates a dead
code path. There is no integration test driving a dated item through the real
`parseCandidates → commitAcquisition → reconcile` chain and checking
`timeline_sort_at`. Whatever is decided in C1, add one real end-to-end assertion
(dated RSS item → its `timeline_sort_at`/`content_sort_at`), and fix or annotate
the stale unit test — otherwise the same class of regression recurs silently.

### Important

**I1 — Count floor counts deliveries; the cap and the trim count logical items.
(nice-to-have, but decide explicitly)** The gate's count test ("deliveries with
`content_sort_at > contentDate`") counts `deliveries_v2` rows, but the cap's
intent is "max remote items per source" and `trimSourceToCap` keys off
`logical_items_v2` (`tombstones.ts:237-241`). A single logical item can carry
multiple same-source deliveries — `tombstones.ts:254-258` documents exactly this
("a feed that re-issues a GUID for the same permalink can leave an excess item
with two same-source deliveries"). So the delivery count can exceed the logical-
item count and the gate can fire early, skipping a genuinely-new item while the
source is still under the item cap. Rare, but it's a real gate/trim
inconsistency the spec should name. Counting deliveries is the efficient choice
(it's what the indexed column supports); just document that the cap is enforced
per-delivery at ingest and per-logical-item at trim, and that they can differ.

**I2 — `verification.ts:352` is a second, ungated delivery-creation path.
(nice-to-have)** The spec says the new-delivery gate "is the whole loop-
breaker," but `commitAcquisition` is not the only place that inserts into
`deliveries_v2`. V3 origin-verification (`verification.ts:339-352`) creates a
delivery + version + reconciled job for verified origin material, with no
retention gate. It is verification-batch-driven, not per-poll, so it will not
churn the way the poll path does — but if a verified origin source is itself
over-cap and polled, the trim can delete and verification can recreate. Low
risk; the spec should acknowledge this path exists rather than claim the single
gate covers all ingress. (`migration/convert.ts:439` is one-time conversion —
ignore.)

**I3 — Backfill must be synchronous in the migration, or count-gating is off
during a window. (nice-to-have, but call it out)** `content_sort_at > X`
excludes NULLs (SQL `NULL > X` is not true), which correctly implements
"NULL = keep, never counted." But it means: until existing rows are backfilled,
every delivery is NULL, the count floor is 0, and the **count** gate never fires
for incoming items. The age gate is unaffected (it uses the incoming item's own
computed `contentDate`, not stored rows). Since `MIGRATIONS[v]` runs each
element's statements inside one transaction (`sqlite.ts:1454-1458`), putting the
`ALTER` + `CREATE INDEX` + backfill `UPDATE` in the same migration element
closes the window. State that the backfill is part of the migration, not a
deferred/async job.

### Minor

**M1 — Two hand-duplicated counter literals must both gain `retentionFiltered`.**
`ZERO_COUNTERS` (`acquisition.ts:460`) and `EMPTY_COUNTERS`
(`verification.ts:239`) are independent literals of the same shape, plus the
`AdminAcquisitionCounters` type (`types.ts:215`). Adding the counter touches all
three, and any admin projection that renders the counter set. Mechanical, but
easy to miss one.

**M2 — Plumbing lands in `server.ts`, not `runtime.ts`.** The engine is
constructed at `server.ts:37` (`createAcquisition({ db })`), a module-load
top-level const — not in the runtime wrapper where the live-caps read currently
lives (`runtime.ts:419-421`). Injecting `getRetentionCaps()` into
`AcquisitionDeps` is feasible (it flows through the closure into `commitFromBody`,
which is already async, then onto `CommitAcquisitionInput` for `commitAcquisition`),
but the wiring point is `server.ts`. The gate and the existing trim will do two
separate `getSetting` reads per poll; an admin cap change landing between them is
negligible. Confirm `commitAcquisition`'s other callers (loop / not_modified /
ownership / body-limit branches) pass empty observations so the gate is a no-op
there — they do.

**M3 — Strict `>` at the count boundary keeps ties.** "deliveries with
`content_sort_at > contentDate`" treats an item tied with the Nth-newest as
kept. Harmless, matches "keep newest N" loosely; noting for completeness.

### Nit

**N1 — Ponytail: the age gate needs no column at all.** The reported live
incident was age-cap-driven (120 days). The age gate is a pure function of the
incoming item's own `contentDate` vs `now − maxAgeDays` — zero schema, zero
migration, and it alone stops the described 2020-backlog loop. The
`content_sort_at` column + index is justified **only** for the count floor
(you cannot efficiently ask "are there ≥ N deliveries newer than X?" without a
stored, indexed date — a per-poll scan of `observation_versions` JSON blobs
would be O(items²)). Given a whole-pipeline simplification audit is planned
*after* this fix, consider whether the count-gate column is wanted now or
whether the age gate alone is the minimal loop-breaker to ship first. Both caps
can loop, so the column is defensible — just make it a conscious choice, not a
bundled default.

## Correct as written — don't churn

- **Gate belongs on the new-delivery branch** (`acquisition.ts:632-635`,
  `existing === undefined`): skipping there creates no delivery, no version
  (`insertVersion`), no job (`insertJob`) — the loop's three artifacts all
  hinge on that branch. Correct.
- **Existing-delivery edits are never gated** (Check #4): a genuine edit hits
  the `existing` branch (`bumpDelivery` + `findVersion`/`insertVersion`),
  bypassing the gate entirely. Correct.
- **`maxCount = 0 && maxAgeDays = 0` ⇒ inert** matches `trimSourceToCap`'s own
  early return (`tombstones.ts:234`). Correct.
- **Local items never gated** is true by construction — `commitAcquisition` only
  ever processes remote-source acquisitions; local posts never enter this path.
- **`committedAt` and `it.rawDate` are both available at commit** to compute
  `content_sort_at` (`committedAt` is the arrival used throughout commit;
  `rawDate` rides `raw_evidence_json`, or better, compute `content_sort_at` in
  `commitFromBody` where `it.rawDate` is directly in hand and thread it on
  `NewObservationVersion`). Feasible.
- **Migration shape** (`ALTER ADD COLUMN` + `CREATE INDEX`, appended at the
  MIGRATIONS tail) exactly matches the established pattern (`sqlite.ts:1436-1440`,
  the scheduler-index migration #20). Correct.
- **A new `retentionFiltered` counter** is the right observability call — a
  silent skip would be a black hole; the counter surfaces it in acquisition
  stats.
