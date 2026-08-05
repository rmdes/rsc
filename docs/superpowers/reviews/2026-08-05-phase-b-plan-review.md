# Phase B plan review — Remove remote version-history

**Reviewed:** `docs/superpowers/plans/2026-08-05-phase-b-remove-remote-version-history.md`
against the real code (clean context). **Spec:** rev 2. **Date:** 2026-08-05.

## Verdict

**NOT executable as-is — three Criticals must be fixed first.** The plan's
read-surface removal (Task 3) and its C1/I2 write-path handling (reset-job-to-
`pending` instead of a colliding INSERT; not overwriting `arrival_at`/`run_id`)
are correct against the code, and its delegation to `deleteObservationVersions`
as the FK-order authority is sound. But three things are wrong or missing and
each is a data-safety or feasibility blocker: **(C-A)** the Task 4 migration
mechanism is architecturally impossible as written — `MIGRATIONS` entries are
pure SQL strings run via `sqlite.exec`, so they cannot call the TypeScript
`deleteObservationVersions` helper the plan tells them to reuse; **(C-B)** the
reset-job→re-reconcile loop the plan introduces makes `reconcileClaim`
re-INSERT a fresh `publisher_claims_v2` + `publisher_names_v2` row for the SAME
version on every edit, unbounded now that the cap is deleted — reintroducing the
exact runaway-churn class of the July purge incident, on different tables, and
the Task 1 test as specified would not even catch it; **(C-C)** the byline
re-point (Task 4 step 3.2) is under-specified and does not reliably preserve the
byline given how `selectAuthor`/`itemAssertedName` actually resolve it. Fix
these three, add claim/name-count assertions to the Task 1/2 tests, and the plan
is executable.

## Findings

### Critical

**C-A — Task 4 migration cannot be a `MIGRATIONS` entry that reuses `deleteObservationVersions`. MUST-FIX-BEFORE-EXECUTING.**
`core/src/storage/sqlite.ts:1219` declares `MIGRATIONS: string[][]` and
`migrate()` runs each entry as `for (const stmt of MIGRATIONS[v-1]) sqlite.exec(stmt)`
(`sqlite.ts:1476-1481`) — **pure SQL strings only.** `deleteObservationVersions`
(`tombstones.ts:205`) is a TS function taking a `WriteTx`; a SQL-string
migration cannot call it, and the collapse's per-delivery survivor-selection +
targeted byline re-point is imperative row-by-row logic, not a static statement.
The plan's "append one `MIGRATIONS` entry ~line 1462 … reuse the
`deleteObservationVersions` cascade" is internally contradictory. **Fix:** follow
the existing precedent — `healMembers(sqlite)` (`sqlite.ts:1485`, gated
`if (version < 19)`, own transaction, idempotent) is exactly this: a one-time
imperative data heal called from `migrate()` after the loop. Write the collapse
as a new gated heal function (can then legitimately reuse
`deleteObservationVersions`), OR write it as a genuinely pure-SQL `MIGRATIONS`
entry (feasible for the deletes via correlated-subquery `DELETE`s in FK order —
and note SQLite's variable limit does NOT bite a subquery `DELETE`, so the plan's
"SQL-param chunking" guard is only needed on the imperative path). Pick one; the
current wording is neither.

**C-B — Reset-job→re-reconcile re-inserts duplicate claims + names per edit, unbounded. MUST-FIX-BEFORE-EXECUTING.**
Task 1 resets the delivery's observation job to `pending`
(`reconcile.ts:64`: the drain claims `status IN ('pending','retrying')`), so
`drainReconciliation` re-runs `reconcileClaim` on the SAME `version_id`. For an
already-homed delivery `reconcileClaim` takes the `home` branch
(`reconcile.ts:273`) and falls straight through to the **unconditional**
`INSERT INTO publisher_names_v2 …` and `INSERT INTO publisher_claims_v2 …`
(`reconcile.ts:332-335`) — neither has a UNIQUE guard on `observation_version_id`,
so every edit appends another claim + name row for the one surviving version.
With the version cap and its cascade eviction DELETED in Task 1, nothing bounds
this. That is the runaway-churn class the obs-versions purge incident was about,
moved onto `publisher_claims_v2`/`publisher_names_v2`. The plan never touches
`reconcileClaim`, and the Task 1 test (Step 1) asserts only ONE version + ONE
presentation entry — **it does not assert claim/name counts, so the churn passes
the suite.** **Fix:** make the claim/name write idempotent on re-reconcile of an
already-homed delivery (e.g. delete this item's existing claim+name for that
`observation_version_id`/publisher before re-inserting, or guard the insert on
first-reconcile only), and add `publisher_claims_v2`/`publisher_names_v2`
count assertions to the Task 1 test.

**C-C — Byline re-point (Task 4 step 3.2) does not reliably preserve the byline. MUST-FIX-BEFORE-EXECUTING.**
The displayed byline is `itemAssertedName(tx, itemId, selectedVersionId)`
(`projector.ts:512,523`), where `selectedVersionId` = `selectAuthor(...)
.observationVersionId` (`projector.ts:496,106`). `selectAuthor` picks the
**strongest evidence level FIRST**, then earliest arrival (`projector.ts:97-106`);
`itemAssertedName` then returns the name whose row has
`observation_version_id === selectedVersionId`, else the strongest-level name
(`projector.ts:531-533`). Three problems with the plan's "re-point the earliest
non-survivor claim/name onto the survivor":
1. It keys on **earliest arrival only**, ignoring the strongest-level rung. A
   delivery with a later `verified_origin` claim (verification, `evidence_level
   'verified_origin'`) would have that as its byline pre-migration; re-pointing
   the *earliest* (possibly `aggregate_assertion`) claim silently drops the
   verified byline.
2. After re-pointing, the survivor version carries **two** name rows (its native
   one + the re-pointed one). `itemAssertedName`'s `rows.find(ovid === survivor)`
   is order-undefined among them, so which name displays is nondeterministic —
   re-pointing does not guarantee the earliest name wins.
3. It never deletes the survivor's competing native claim/name, so 2 is
   unavoidable.
**Fix:** either (recommended, per spec review I3 option b, ponytail) **accept
realignment to the current version's byline** — a delivery's `<source>` name
essentially never changes across its own versions, so the observable impact is
nil and an entire fragile migration step disappears; or fully specify: choose the
byline claim by `selectAuthor`'s real order (strongest level, then earliest
arrival, then `claimId`), DELETE the survivor's native competing claim+name, and
re-point exactly that one claim+name — verifying `itemAssertedName` then has a
single unambiguous match.

### Important

**I-A — Task 2 verification: same duplicate-claim exposure + a lookup that must change. MUST-ADDRESS.**
`persistVerifiedDelivery` INSERTs a `verified_origin` claim **unconditionally on
every call** (`verification.ts:389`), and its version lookup is **by fingerprint**
(`verification.ts:351`) — on changed origin material the fingerprint differs, so
`existingVersion` is undefined and it inserts a second version (the I4 path). To
do overwrite-in-place, Task 2 must switch that lookup to by-`delivery_id` (the
single row), like Task 1, AND make the `verified_origin` claim insert idempotent
(same as C-B). The "reuse Task 1's helper" note also understates the seam: Task 1
overwrites an existing version+run, while verification synthesizes a new
`acquisition_runs_v2` row first (`verification.ts:355-359`) — a shared
"overwrite current observation" helper must not assume the acquisition run
context. Mirror carefully or the extraction leaks.

**I-B — Task 4 does not handle a delivery with >1 version but no presentation entry. MUST-ADDRESS (spec M7).**
Survivor = "version backing the highest-`sequence` presentation entry." A
delivery whose jobs never reconciled has NO presentation entry (they are written
only on reconcile, `reconcile.ts:416`), so survivor selection returns nothing and
the "delete all non-survivors" step would delete every version (RESTRICT-safe but
data-destroying) or no-op incorrectly. **Fix:** explicitly skip deliveries with
zero presentation entries (they are not ordinary-visible anyway); this also keeps
the migration idempotent.

### Minor

**M-a — `nextPresentationEntry` "simplify to sequence 0" is unnecessary; keep the rollback/watermark decision.**
The `ON CONFLICT(observation_version_id) DO UPDATE` upsert already collapses to
one row per delivery regardless of `sequence`, so forcing sequence 0 buys
nothing. What DOES matter is preserving the watermark rollback branch
(`nextPresentationEntry` returns `conflict:'rollback'`, no entry, when explicit
`<updated>` ≤ watermark — `projector.ts:224-229`; `applyPresentation`
`recordConflict` at `reconcile.ts:419`). Don't blind-overwrite (spec M5). The
plan says "keep the conflict/rollback handling" — make that explicit and drop the
gratuitous sequence rewrite.

**M-b — The new fingerprint-equality branch drops the `fingerprint_collision` finding.**
Today, a same-fingerprint-different-material case records a
`fingerprint_collision` finding and skips (`acquisition.ts:660-664`). The plan's
"if fingerprint == incoming → bump last_seen" collapses that into a plain bump.
Acceptable (a real hash collision is astronomically rare) but it's a behavior
change worth one line in the plan.

**M-c — Post-collapse `selected_publisher_id` can point to a publisher with no remaining claims.**
Deleting non-survivor claims can strip every claim of a hinted publisher.
`selected_publisher_id` still references a live `remote_publishers_v2` row (not
deleted), so no FK break, and reads re-derive (`selectAuthor` treats the hint as
advisory, `projector.ts:100`), so it self-heals. Optionally recompute hints in
the migration; not required.

**M-d — `REMOTE_VISIBLE` blinks during the reset-to-`pending` window (spec M6).**
Resetting the single job to `pending` briefly fails the reconciled-job
requirement of `REMOTE_VISIBLE` until the synchronous post-commit drain
re-reconciles. Practically invisible; keep the drain-after-commit ordering.

**M-e — Task 3 DTO removals should be enumerated.**
Name them: `counts.versions` (`store.ts:261`), the per-delivery `versions` read
(`store.ts:282-284`), and the DTO types `AdminVersionRow` +
`AdminDeliveryRow.versions`. KEEP `LogicalHistoryEnvelope` (the LOCAL branch of
`projectHistory` still returns it). `/posts/:id/revisions` (`logical-routes.ts:429`)
cleanly 404s for remote once the remote branch returns `undefined`.

**M-f — Distinguish removing the remote "edited" MARKER from keeping the remote updatedAt.**
Phase B still updates `effective_updated_at` on a remote change; only the
"edited" affordance is removed. The web edited signal lives across
`EditedMarker.svelte`, `ReplyTree.svelte`, `logical-live.ts`, `live.ts`,
`types.ts` — Task 3 must strip the remote *badge* without also dropping the
remote *updated timestamp* display.

### Nit

**N-g — `convert.ts` still writes multi-entry chains** (spec N10) — fresh-install
path only, over zero legacy rows; leaving it is fine.

**N-h — Task 4 step 4 (renumber survivor entry to sequence 0) is cosmetic.** After
the cascade only the survivor's one entry remains; the projector reads the top
entry regardless of its number. Not load-bearing.

## Correct-as-written

- **C1 handling is right:** reset the existing observation job to `pending` (an
  UPDATE — dodges `reconciliation_jobs_v2.observation_version_id` UNIQUE
  `schema.ts:176`) and `applyPresentation` upsert via
  `ON CONFLICT(observation_version_id)` (valid — that column is `UNIQUE`
  `schema.ts:98`) instead of a second INSERT.
- **I2 handling is right:** not overwriting `arrival_at`/`run_id`; the changed
  display time rides `presentation_entries_v2.effective_updated_at`.
- **`deleteObservationVersions` is the correct FK-order authority** — it deletes
  all four RESTRICT children (`reconciliation_jobs_v2`, `presentation_entries_v2`,
  `publisher_claims_v2`, `logical_conflicts_v2`) plus the non-FK
  `publisher_names_v2` before the versions (`tombstones.ts:208-213`), chunked and
  idempotent — provided it is reached from an imperative heal (see C-A), not a
  SQL-string migration.
- **Survivor = highest-sequence presentation entry's version is unambiguous**
  (`presentation_entries_v2.observation_version_id` is UNIQUE).
- **Re-point BEFORE delete** ordering (Task 4 steps 2→3) is correct — re-pointed
  rows escape the cascade.
- **Task 3 read-surface locations are accurate:** `projectHistory` remote branch
  `projector.ts:750-764`, `store.ts:261/282`, admin `+page.svelte:68`.
- **The migration cannot corrupt `logical_conflicts_v2` or dangle
  `selected_publisher_id`** — conflicts on doomed versions are cascaded;
  `selected_publisher_id` FK-references publishers, which are never deleted here.
