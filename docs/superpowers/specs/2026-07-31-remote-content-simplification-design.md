# Remote content simplification — design

**Date:** 2026-07-31
**Status:** PARKED 2026-07-31. The clean-context 2-lens review found **5 Criticals** on the full removal (deleting `verification.ts` breaks the migration converter via `EMPTY_COUNTERS`; the version-collapse cannot "rewire" FKs — it must DELETE children in dependency order, and `presentation_entries_v2` is UNIQUE+RESTRICT; live `evidence_level='verified_origin'` claim rows feed `undefined` into the comparator once the rung is removed) plus an "under-removed" footprint (`reconcile.ts`/`store.ts`/`tombstones.ts`/web + enum members). It is a large, hazardous refactor on live data. The maintainer instead took the **minimal root-cause fix** — commit `00bc235`: exclude the volatile enclosure URL and the arrival-substituted `published` date from the fingerprint, plus a per-delivery version cap of 5 — which resolves the runaway and phantom-"edited" symptoms this milestone targeted. This doc is retained as a record; if the full simplification is ever revisited, the review findings above must be folded first.
**Scope:** Remove two over-built remote-content subsystems (retained version history; origin verification), keeping a lean change-detection fingerprint. Deployed-spine change with a forward-only migration.

## Purpose

RSC's v2 remote-content model retains a full **version history** of every ingested feed item (`observation_versions_v2`, one row per material change per delivery) and runs an **origin-verification** subsystem (`verification.ts`, `verification_checks_v2`). A 2026-07-25 incident showed the cost: one podcast feed grew `observation_versions` to **763k rows / 2.6 GB** on a live instance.

**Root cause (reproduced in the act, 2026-07-31, not inferred):** the observation fingerprint (`canonicalMaterialFor`, `acquisition.ts:261-273`) includes the raw **enclosure URL**. Podcast feeds wrap audio in chained tracking redirectors (`podtrac`, `byspotify`, `mgln.ai`, `pscrb.fm`, `claritas`, …) whose URL rotates on the tracker's own cadence. Comparing the DB's import-time fingerprints to a live fetch, the `rss.art19.com/a-little-bit-culty` feed showed **9/9 items would create a new version right now, `changedFields={"enclosures":9}`** — zero real content change. On a large feed polled repeatedly, ~100% of items re-version every poll → unbounded storage *and* CPU (each new version also spawns a reconciliation job), and each phantom version surfaces to users as a spurious **"edited"** marker with no visible diff.

The earlier "identity-key collision" attribution was **wrong** — collision was ruled out empirically (all 295 dev feeds are 1:1 after import). The cause is volatile enclosure URLs in the fingerprint.

**Design finding.** Retained remote version history is an over-built layer, not a load-bearing one:
- It backs exactly **one** feature: the remote `/posts/:id/revisions` history page — admin-visible, low value, and actively **degraded** by the phantom "edits" the machinery itself produces.
- Display, visibility, and moderation read only the **current** version (projector takes the latest presentation entry, `projector.ts:569`).
- **Local** post edit-history is a *separate* system (`post_revisions`, the sole local history authority per `local.ts:12`); verified independent — **0 local logical items have a delivery**. Removing remote versioning cannot touch it.
- Origin verification (`verification.ts`, 407 LOC) only affects **aggregate**-feed attribution (anti-byline-spoofing on shared firehoses); it does nothing for ordinary single-blog subscriptions and is admin-invisible.

The fix is therefore **subtraction**: remove the two subsystems, keep a lean change-detection fingerprint (fixed so tracker rotation is not a "change"), and always show the publisher's latest.

## Decisions locked (maintainer, 2026-07-31)

1. **Remote items retain no version history.** Keep one current observation per delivery; on a real change, overwrite in place and show the publisher's latest. No remote history route, no remote "edited" marker.
2. **Keep a change-detection fingerprint** (one per delivery) so unchanged re-polls are skipped — but exclude the volatile enclosure URL so tracker rotation is not seen as a change.
3. **Remove the origin-verification subsystem entirely.**
4. **Local `post_revisions` edit-history is untouched.**

## Load-bearing invariants preserved

- **Durable per-item moderation** (`hidden` survives re-poll) — unchanged.
- **Aggregate-feed publisher attribution** (source/publisher/claim model) — unchanged, minus the `verified_origin` evidence rung.
- **Local origin authority, resolve-once threading, the central visibility projector, feeds (RSS/Atom/JSON/comments), SSE journal, sanitizer, no-JS.**
- **`post_revisions` as the sole local edit-history authority.**

## 1. Remote items become current-only

Today (`acquisition.ts:581-616`): each poll resolves-or-creates a delivery, computes a fingerprint, and on a novel `(delivery_id, fingerprint)` **INSERTs a new `observation_versions_v2` row + a reconciliation job**; unbounded.

Target: **at most one observation per delivery.** On re-poll:
- fingerprint unchanged → bump `last_seen` (as today);
- fingerprint changed → **overwrite the current observation's material + fingerprint in place** (single row), enqueue one reconciliation job, emit the ordinary "updated" journal effect used for display refresh. No new row, no history accumulation.

The exact table shape (keep `observation_versions_v2` bounded to 1/delivery, or fold the current material into `deliveries_v2`) is a **plan decision**; the invariant is *one current observation per delivery*. Runaway becomes structurally impossible.

## 2. Change-detection fingerprint (keep, but fix)

Keep a single per-delivery fingerprint purely to skip re-processing unchanged items (the CPU-churn guard). **Fix the input:** in `canonicalMaterialFor` (`acquisition.ts:271`), enclosures are fingerprinted as `[url, mimeType, sizeBytes, durationSeconds]`. **Drop the `url`** — fingerprint enclosures by their stable media attributes (`mimeType`, `sizeBytes`, `durationSeconds`) only. Rationale: the tracker-wrapped URL is volatile delivery metadata, not content identity; the media's identity is its type/size/duration. This eliminates the phantom "edits" and the tracker-driven re-reconciliation at the source, without a tracker-blocklist (which would be whack-a-mole).

Display still stores and serves the latest enclosure **URL** (so playback uses the current link); only the **fingerprint** ignores it.

Open question for review: should *any* other fingerprint field be reconsidered (e.g., `updated`/`published` timestamps that some feeds regenerate)? Default: no — only enclosures were shown volatile; keep the change minimal.

## 3. Remove remote edit-history

- Core: `projectHistory` (behind `GET /posts/:id/revisions`, `logical-routes.ts:419`) serves history **only for local posts** (`post_revisions`); for remote logical items it returns not-found/empty.
- Web: `/post/[id]/history` shows history only for local posts; the "history"/"edited" affordance is not rendered for remote items.

## 4. Remove the remote "edited" marker

Remote items no longer carry an "edited" indicator (it only ever reflected the now-removed version churn). Local posts keep their existing edited/revisions affordance.

## 5. Remove the origin-verification subsystem

Grounded footprint to delete:
- `core/src/logical/verification.ts` (407 LOC) + `createVerificationRunner`.
- `verification_checks_v2` table + `verification_checks_v2_source` index (`schema.ts:240,367`).
- `reconciliation_jobs_v2.kind` CHECK narrows to `'observation'` only (`schema.ts:174,182`); remove the `verification_batch_key` column and its paired CHECK.
- The `verified_origin` rung (rank 0) in the projector comparator (`projector.ts:17,22,27`) → the comparator drops to its remaining levels (`bound_single_publisher`, `aggregate_assertion`, `source_scoped_fallback`). Publisher-feed aliases established *only* by verification are removed.
- Runtime/scheduler wiring: `runtime.ts` `drainVerification` + `createVerificationRunner`; `scheduler.ts` `drainVerification` dep and its call site (`scheduler.ts:170`). Note the deliberate **required-not-optional** pattern on `drainVerification` (a guard against silent no-op) — removal deletes the dep entirely rather than making it optional.

Consequence: aggregate-feed attribution keeps its lower evidence levels; only *verified* origin (and its anti-spoofing) is gone — accepted.

## 6. Migration (forward-only, converted v2 data on 4 live instances)

One additive migration:
- **Collapse `observation_versions_v2` to one current row per delivery** — keep the row backing the current selected/display presentation per delivery, drop the rest; rewire/clean the `ON DELETE RESTRICT` references (`presentation_entries_v2`, `publisher_claims_v2`, `logical_conflicts_v2`, `reconciliation_jobs_v2`) so the survivor is consistent. Exact selection of the survivor + FK cleanup is the **plan's** central task.
- **Drop `verification_checks_v2`**; delete any `kind='verification'` reconciliation jobs before narrowing the CHECK.
- No change to `post_revisions`, `posts`, or the local path.
- Preflight/backup posture identical to prior cutovers (RUNNING.md): forward-only, pre-flip Cloudron backup is the only rollback.

This is the milestone's riskiest surface and must be its own carefully-tested tasks.

## 7. Preserved (explicit non-goals of removal)

Local `post_revisions`; moderation/`hidden`; source/publisher/claim model and aggregates; feeds; SSE journal; sanitizer; the source-retention count/age caps (`trimSourceToCap`, 2026-07-30) — complementary, untouched.

## 8. Testing / acceptance

- **Runaway impossible:** re-polling a rotating-tracker feed (art19) N times creates **no** new versions and **no** phantom "edited" — versions stay 1/delivery. Regression test drives the real acquisition path across two polls with a rotated enclosure URL and asserts one row, unchanged fingerprint.
- **Real edit still reflected:** a genuine remote content change overwrites in place and the timeline shows the latest.
- **Local edit-history intact:** `post_revisions` behavior byte-unchanged; `/posts/:id/revisions` still serves local history.
- **Moderation still durable:** hide a remote item; poll/restart; stays hidden.
- **Feeds/threading/visibility regression** green.
- **Verification gone:** no `verification_checks_v2`, no `kind='verification'` jobs, comparator is 3-level, startup/scheduler run without the verification drain.
- **Completion gate:** core Vitest, `tsc`, web Vitest, `svelte-check`, web build.

## 9. Risks & coordination

- **Deployed to 4 instances** with converted v2 data; forward-only migration; backup-before-flip.
- **FK-woven spine**; the version-collapse migration is the sharp edge.
- **Parallel sessions are actively working in `core/src/logical/*`** on a shared checkout. This milestone must be coordinated with them before execution — it removes tables/columns/evidence-levels other in-flight work may assume. Do not begin SDD until that coordination and the clean-context spec review are done.

## 10. Sequencing

Spec → clean-context spec review (fold as revs) → `writing-plans` → clean-context plan review → `subagent-driven-development` with a whole-branch review. No code is authorized by this document.

## Self-review notes / open questions for the reviewer

1. **Survivor selection in the version collapse** — pick the row backing the current display presentation; confirm no consumer needs a non-display version post-migration.
2. **`verified_origin` removal ripple** — confirm nothing outside the projector/reconcile comparator depends on the rung or on verification-established publisher aliases.
3. **Fingerprint scope** — is dropping only the enclosure `url` sufficient, or do any feeds churn on regenerated `published`/`updated`? Keep minimal unless the reviewer shows otherwise.
4. **Table shape** — collapse `observation_versions_v2` into `deliveries_v2`, or keep it bounded to 1? Plan decision; spec only mandates one-current-per-delivery.
5. **"Show latest" vs journal** — confirm the overwrite-in-place path emits the correct ordinary journal upsert so SSE/timeline refresh, without a remote "edited" semantic.
