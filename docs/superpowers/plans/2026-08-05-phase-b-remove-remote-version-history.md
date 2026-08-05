# Phase B — Remove Remote Version-History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remote items keep ONE current observation + ONE presentation entry per delivery; remove the remote history route/page, the remote "edited" marker, the admin versions view, and the version cap. Migrate live data by collapsing existing chains.

**Architecture:** Change-detection fingerprint stays. On a real change, OVERWRITE the delivery's single observation-version material+fingerprint in place (same id), RESET its observation job to pending, UPSERT its single presentation entry. Verification's insert follows the same rule. A forward-only migration collapses existing chains, preserving the current-display survivor and re-pointing the earliest byline claim.

**Tech Stack:** core = better-sqlite3 + Kysely, Node 22 native type-stripping (run tsc separately).

**Spec:** `docs/superpowers/specs/2026-08-05-phase-b-remove-remote-version-history-design.md` (rev 2)
**Spec review folded:** `docs/superpowers/reviews/2026-08-05-phase-b-spec-review.md` (C1/I2/I3/I4 + 5 minors)
**Plan review folded (rev 2):** `docs/superpowers/reviews/2026-08-05-phase-b-plan-review.md` — C-A migration is an imperative heal (not SQL), C-B `reconcileClaim`/verification claim+name must be idempotent (else the runaway class returns), C-C drop the byline re-point (accept realignment-to-current), I-A verification by-delivery + claim guard, I-B null-survivor fallback.

## Global Constraints

- **One version + one presentation entry per remote delivery** — the invariant this establishes. NOT DB-enforced today; enforced by the write paths (Tasks 1, 2) and restored by the migration (Task 4).
- **UNIQUE collision (C1):** `presentation_entries_v2.observation_version_id` (schema.ts:98) and `reconciliation_jobs_v2.observation_version_id` (schema.ts:176) are UNIQUE + RESTRICT. On a change you MUST overwrite/reset/upsert the existing rows for the delivery's version — never INSERT a second.
- **First-arrival stability (I2):** do NOT overwrite the version's `arrival_at`/`run_id` (selection sorts on `compareFirstArrival`, projector.ts:42). The updated display time lives in `presentation_entries_v2.effective_updated_at`.
- **Byline preserved (I3):** the migration re-points the earliest `publisher_claims_v2`/`publisher_names_v2` onto the survivor (`observation_version_id` is RESTRICT but not unique — a plain UPDATE).
- **Kept, untouched:** verification/instance-governed-members (only its version-write becomes overwrite-in-place), local `post_revisions`, threading, moderation, feeds, `REMOTE_VISIBLE`, SSE, the retention age gate, sanitizer.
- **Test commands (in-container):** core `docker compose exec -T core npm test -w core -- <name>`; core tsc `docker compose exec -T core npx tsc --noEmit -p core/tsconfig.json`; web `docker compose exec -T web env -u CORE_API_URL npm test -w web -- <name>`; svelte-check `docker compose exec -T web npm run check -w web`.
- Shared checkout: stage explicit paths, never `git add -A`. Commit messages end with `developed with the help of AI tools`.

---

### Task 1: Forward write-path — one version + one presentation per delivery (acquisition + reconcile)

**Files:** Modify `core/src/logical/acquisition.ts` (commit loop ~593-658), `core/src/logical/reconcile.ts` (`applyPresentation` ~408-422 + `nextPresentationEntry`); Test `core/test/logical-acquisition.test.ts`.

- [ ] **Step 1: Failing tests.** Drive the real acquire→commit→drain path twice over one item with CHANGED content between polls. Assert: the delivery has exactly ONE `observation_versions_v2` row (material+fingerprint = the newer content, same `id` as poll 1), ONE `presentation_entries_v2` row (effective_updated_at reflects the change), the observation job is back to `pending`/re-reconciled, `arrival_at` unchanged from poll 1, and NO `UNIQUE` throw. **CRITICAL (review C-B): also assert the item's `publisher_claims_v2` and `publisher_names_v2` stay at ONE each across many change-polls** — the version cap is being deleted, so an unbounded claim/name INSERT-per-reconcile is the reintroduced runaway class. Poll a changing item ~5× and assert claim/name counts stay 1. Unchanged re-poll → only `last_seen` bumps.
- [ ] **Step 2: Run — expect FAIL** (today a changed fingerprint inserts a 2nd version).
- [ ] **Step 3: Implement.**
  - `acquisition.ts` commit loop: replace the `findVersion`-by-fingerprint + insert-new + cap-evict branch. New logic per observation on an EXISTING delivery: look up the delivery's single version; if its fingerprint == the incoming fingerprint → bump `last_seen` (unchanged); else → `UPDATE observation_versions_v2 SET fingerprint = ?, canonical_material = ?, raw_evidence_json = ?, normalized_json = ?, last_seen_at = ?, last_seen_run_id = ? WHERE id = ?` (NOT `arrival_at`/`run_id` — I2), then `UPDATE reconciliation_jobs_v2 SET status='pending', next_attempt_at=? WHERE observation_version_id = ? AND kind='observation'` (reset, never insert — C1). For a NEW delivery, INSERT the first version + job as today (that's the one legitimate insert). DELETE the cap machinery: `MAX_VERSIONS_PER_DELIVERY`, `findVictims`, the `deleteObservationVersions` eviction call (~619-657).
  - `reconcile.ts` `applyPresentation`: make it UPSERT the single current entry rather than append a sequence. Simplify `nextPresentationEntry` to always target the one entry (sequence 0). Change the INSERT to `INSERT INTO presentation_entries_v2 (...) VALUES (...) ON CONFLICT(observation_version_id) DO UPDATE SET effective_updated_at=excluded.effective_updated_at, provenance=excluded.provenance, material_fingerprint=excluded.material_fingerprint` (one row per version = one per delivery). Keep the conflict/rollback handling that still applies.
  - **`reconcile.ts` `reconcileClaim` (~328-335) — the C-B churn guard.** Today it UNCONDITIONALLY INSERTs a `publisher_names_v2` + `publisher_claims_v2` row on every reconcile. With re-pended jobs on every edit + the cap gone, that grows unboundedly. Make both idempotent for the one-version-per-delivery model: UPSERT / INSERT-OR-IGNORE keyed on the row's natural identity — a claim on `(logical_item_id, publisher_id, observation_version_id)`, a name on `(publisher_id, observation_version_id, normalized_name)` — so re-reconciling the SAME (overwritten) version does not append. Update the row's `evidence_level`/name in place when it legitimately changes. (Confirm the natural keys against `schema.ts`; add the UNIQUE index if one doesn't exist, or use an existence-guarded INSERT.)
- [ ] **Step 4: Run — expect PASS**; core tsc 0; full core suite green (`--no-file-parallelism`).
- [ ] **Step 5: Commit** (`core/src/logical/acquisition.ts core/src/logical/reconcile.ts core/test/logical-acquisition.test.ts`).

---

### Task 2: Verification write-path — same overwrite-in-place (I4)

**Files:** Modify `core/src/logical/verification.ts` (`persistVerifiedDelivery` ~324-383); Test `core/test/logical-verification.test.ts`.

- [ ] **Step 1: Failing test.** A verified delivery whose origin material later CHANGES → still ONE `observation_versions_v2` row (overwritten) + ONE presentation entry + re-`pending`ed job; no second version, no UNIQUE throw. A first verification of a delivery still creates its one version (unchanged).
- [ ] **Step 2: Run — expect FAIL** (today `persistVerifiedDelivery` can append a 2nd version on changed origin material).
- [ ] **Step 3: Implement.** In `persistVerifiedDelivery`: (a) change the version lookup from by-fingerprint to **by-delivery** (find the delivery's one version), and on changed material take the same overwrite-in-place + reset-job + upsert-presentation path (reuse the helper Task 1 introduces if extracted); preserve the first-arrival tuple. (b) **Same C-B guard (review I-A):** its `publisher_names_v2`/`publisher_claims_v2` INSERT (`verification.ts:389`) must be idempotent per the same natural keys, so a re-verified delivery doesn't accumulate claims/names. Add claim/name count assertions to the test.
- [ ] **Step 4: Run — PASS; tsc 0; verification suite + full core green.**
- [ ] **Step 5: Commit** (explicit paths).

---

### Task 3: Remove remote history read-surfaces

**Files:** Modify `core/src/logical/projector.ts` (`projectHistory` remote branch ~750-764), `core/src/logical/store.ts` (item-detail `versions` count ~261 + per-delivery versions read ~282), the item-detail DTO type; `web/src/routes/post/[id]/history/*`, the remote "edited" marker (`web/src/lib/EditedMarker.svelte`/`PostBody.svelte`), `web/src/routes/admin/items/[id]/+page.svelte` (~68 `delivery.versions`); relevant tests.

- [ ] **Step 1: Failing tests.** Core: `projectHistory` for a REMOTE item returns current-only (single entry) or undefined; LOCAL `post_revisions` history byte-unchanged. Web: `/post/[id]/history` renders no remote history; the admin item-detail renders no per-delivery versions list; remote items show no "edited" marker; local edited/revisions intact.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Remove the REMOTE branch of `projectHistory` (`projector.ts:750-764`) — return undefined (route 404s for remote) or a single current entry; keep the LOCAL branch (`:737-749`). Remove the store item-detail `versions` count + per-delivery versions read (store.ts:261,282) and the DTO field; remove `delivery.versions` rendering (admin item-detail). Remove the remote "edited" affordance (the `updatedAtProvenance`-driven marker for remote source items) — keep local. Remove/redirect the web `/post/[id]/history` remote path.
- [ ] **Step 4: Run — PASS; core + web suites green; svelte-check 0/0.**
- [ ] **Step 5: Commit** (explicit paths).

---

### Task 4: Collapse migration (Criticals 2 & 5, byline I3)

**Files:** Modify `core/src/storage/sqlite.ts` — an **imperative heal function** (NOT a `MIGRATIONS` SQL entry — review C-A: `MIGRATIONS` is `string[][]` run via `sqlite.exec`, pure SQL, and CANNOT call the TS `deleteObservationVersions` helper). Follow the `healMembers` precedent (`sqlite.ts:1485`): add a `collapseVersionHistory(sqlite)` function that wraps its own transaction, gated by `if (version < <N>)` after the migration loop, so it runs once when the DB crosses the new version. Bump the `user_version` with a no-op/marker `MIGRATIONS` entry so the gate advances. Test `core/test/phase-b-collapse.test.ts`.

- [ ] **Step 1: Failing test.** Seed a delivery with N (>1) observation versions + presentation entries + claims/names. Run `collapseVersionHistory`. Assert: exactly ONE version + ONE presentation entry remain (the current-display survivor); all FK children of the dropped versions are gone with NO `RESTRICT` violation; the item still resolves a byline (realigned to the survivor's claim — see C-C below); a delivery that has versions but NO presentation entry is handled (survivor falls back to the newest-by-`arrival_at` version, NOT null — review I-B); and a second run is a no-op (idempotent).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `collapseVersionHistory`, per remote delivery with >1 version:
  1. **Survivor** = the version backing the current-display `presentation_entries_v2` (highest `sequence`); **if the delivery has no presentation entry (I-B), fall back to the newest version by `arrival_at, id`** — never null (null → data-destroying delete).
  2. **No byline re-point (review C-C).** `selectAuthor` is evidence-level-first (not earliest-arrival) AND already prefers the RETAINED current author, so the fragile "move the earliest claim" step was both wrong and unnecessary. Accept byline **realignment-to-current** (spec I3 option b): the survivor's own claim/name is the byline post-collapse; delete the non-survivors' native claim/name rows with the versions. Negligible real impact; deletes a fragile step.
  3. Delete the non-survivor versions + their FK children in dependency order via the `deleteObservationVersions` cascade (`tombstones.ts:205` — covers presentation_entries UNIQUE + the RESTRICT children, chunked, idempotent).
  4. Collapse the survivor's presentation entries to one (sequence 0) if multiple remain.
  - Chunk any `IN (...)` (the retention param-limit lesson). Local `post_revisions`/`posts` untouched.
- [ ] **Step 4: Run — PASS; tsc 0; full core suite green.** Verify against the local dev DB (converted, has real chains) read-only before/after counts.
- [ ] **Step 5: Commit** (`core/src/storage/sqlite.ts` + test).

---

## Self-Review

- **Spec coverage:** overwrite-in-place + reset-job + upsert-presentation (T1) with the I2 first-arrival guard; verification consistency (T2, I4); remove history surfaces (T3); collapse migration with byline preservation (T4, C2/C5/I3). Version cap deletion in T1. ✓
- **The UNIQUE-collision Critical (C1)** is handled in both write paths (T1 reset-job/upsert-presentation, T2 same). ✓
- **Type/interface consistency:** if T1 extracts a shared "overwrite current observation" helper, T2 reuses it — name it in T2's dispatch.
- **Open for the plan reviewer:** the exact "which claim/name is the byline" selection in the migration (T4 step 3.2) — tighten against `selectAuthor`/`itemAssertedName`; and confirm `nextPresentationEntry`'s simplification (T1) doesn't drop the conflict-rollback path that visibility needs.

## Execution Handoff

superpowers:subagent-driven-development — fresh implementer per task, review after each, whole-branch review on the most capable model (the migration T4 is the sharp edge). Order 1 → 2 → 3 → 4.
