# Ingest-Aware Retention — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop the retention delete↔re-ingest loop (age half) and repair the `timeline_sort_at` regression that amplifies it — no schema change.

**Architecture:** (1) reconcile derives `timeline_sort_at` from the item's real published date again (read from `raw_evidence_json`, not the fingerprint blob `00bc235` stripped it from); (2) an **age ingest gate** in `commitAcquisition`'s new-delivery branch skips items older than `maxAgeDays` so out-of-window items are never (re-)created; (3) the second delivery-insert path in `verification.ts` honors the same gate if it can ingest. Count-cap gate + schema are **Phase 2, deferred** (see spec).

**Tech Stack:** core = Hono + Kysely + better-sqlite3, Node 22 native type-stripping (no build; run tsc separately).

**Spec:** `docs/superpowers/specs/2026-08-01-ingest-aware-retention-design.md` (Rev 2)
**Review folded:** `docs/superpowers/reviews/2026-08-01-ingest-aware-retention-review.md`

## Global Constraints

- **One content date, everywhere.** After Task 1, an item's content date is `pub && pub <= arrival ? pub : arrival` where `pub` = the item's published date from `raw_evidence_json` (`it.rawDate`), `arrival` = the commit/acquisition time. The timeline sort (reconcile), the age trim (`trimSourceToCap` via `timeline_sort_at`), and the age gate (Task 2) MUST all use this same date. Do NOT read `material.published` — the fingerprint blob no longer carries it.
- **`maxAgeDays = 0` ⇒ gate disabled** (today's unlimited default). Local/origin items are never gated (this whole path is remote-source ingestion).
- **Gate is new-delivery-only.** A genuine edit to an already-tracked delivery (existing !== undefined) is never gated out.
- **House style:** hand-rolled, `app.request`/unit tests, `c.json`. Native type-stripping ⇒ vitest passes on type errors, so ALWAYS run tsc.
- **Test commands (in-container):**
  - core: `docker compose exec -T core npm test -w core -- <name>`
  - core tsc: `docker compose exec -T core npx tsc --noEmit -p core/tsconfig.json`
- **Shared checkout:** stage explicit paths only; never `git add -A`. Commit messages end with `developed with the help of AI tools`.

---

### Task 1: Repair `timeline_sort_at` — reconcile reads `published` from `raw_evidence`

**Files:**
- Modify: `core/src/logical/reconcile.ts` (`createRemoteItem`, ~line 375-381)
- Test: `core/test/logical-reconcile.test.ts` (add a real dated-item test; the existing seed hand-builds `canonical_material` WITH `published`, a shape production no longer emits — review C2)

**Interfaces:**
- Consumes: `VersionRow.raw_evidence_json` (already on the row, `reconcile.ts:161`), `normalizeUtc` (`projector.ts:237`). `raw_evidence_json` carries `published: it.rawDate` (`acquisition.ts:324`).
- Produces: remote `logical_items_v2.timeline_sort_at` = the item's real published date (clamped `≤ arrival`), or arrival when dateless.

- [ ] **Step 1: Write the failing test.**
A dated remote item, driven through the REAL pipeline (parse → `commitAcquisition` → reconcile), lands `timeline_sort_at = <published>`, not arrival. Build it by feeding a real feed document with a `<pubDate>` well before "now" through the acquisition+reconcile path used by other `logical-reconcile` tests — do NOT hand-build a `canonical_material` blob (that's the dead-code shape C2 flagged). Assert `SELECT timeline_sort_at FROM logical_items_v2` equals the item's published instant.

- [ ] **Step 2: Run — expect FAIL** (`timeline_sort_at` currently = arrival).
Run: `docker compose exec -T core npm test -w core -- logical-reconcile`

- [ ] **Step 3: Implement.** In `createRemoteItem` (`reconcile.ts`), replace the `material.published` read:

```ts
// was: const pub = normalizeUtc(material.published)
const rawPublished = (JSON.parse(v.raw_evidence_json) as { published?: string | null }).published ?? null
const pub = normalizeUtc(rawPublished)
const timelineSortAt = pub && pub <= arrival ? pub : arrival
```

`v` (the `VersionRow`) is already a parameter of `createRemoteItem`; `raw_evidence_json` is on it. `normalizeUtc('')` → `null` (empty rawDate ⇒ dateless ⇒ arrival), preserving today's dateless behavior. Leave `material` for its other uses (title/content).

- [ ] **Step 4: Run — expect PASS**, then `tsc` 0. Also run the full `logical-reconcile` + `logical` suites to catch any test that asserted the arrival-sort behavior; fix any that encoded the regression.

- [ ] **Step 5: Commit** (`git add core/src/logical/reconcile.ts core/test/logical-reconcile.test.ts`).

---

### Task 2: Age ingest gate in `commitAcquisition` (+ caps plumbing + counter)

**Files:**
- Modify: `core/src/logical/types.ts` (add `retentionFiltered` to `AdminAcquisitionCounters`; add `maxAgeDays` to `CommitAcquisitionInput`; add `getSetting?` to `AcquisitionDeps`)
- Modify: `core/src/logical/acquisition.ts` (`ZERO_COUNTERS` ~460; `commitFromBody`/commit callers ~742-767 read the live cap and pass it; the observation loop ~627-635 gate; import `normalizeUtc`)
- Modify: `core/src/server.ts:37` (`createAcquisition({ db })` → pass `getSetting`)
- Test: `core/test/logical-acquisition.test.ts` (or the nearest existing acquisition/commit test — check first)

**Interfaces:**
- Consumes: `normalizeUtc` (`projector.ts:237`), `obs.rawEvidenceJson` (on `NewObservationVersion`), `input.committedAt`, live `getSetting('max_remote_item_age_days')`.
- Produces: an out-of-window incoming item on a NEW delivery creates no delivery/version/job and increments `counters.retentionFiltered`.

- [ ] **Step 1: Failing tests.**
  1. `caps: maxAgeDays=120`, a feed with an item dated 2 years ago on a source with no existing delivery for it → `commitAcquisition` creates NO delivery/version/job for it; `retentionFiltered === 1`. A same-poll item dated today → ingested normally.
  2. **Loop-dead:** run the acquire→commit path twice over the same old-dated feed → zero new deliveries on the second run.
  3. `maxAgeDays=0` → the old item ingests (gate inert).
  4. An EXISTING delivery (already ingested) that gets a new version is never gated (edit still recorded).
Drive these through the real acquire/commit path (a fake `fetchFn` returning the feed doc), matching existing acquisition tests.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.**
  - `types.ts`: `AdminAcquisitionCounters` gains `retentionFiltered: number`; `CommitAcquisitionInput` gains `maxAgeDays: number`; `AcquisitionDeps` gains `getSetting?: (key: string) => Promise<string | undefined>`.
  - `acquisition.ts`: `ZERO_COUNTERS` (~460) gains `retentionFiltered: 0`. Import `normalizeUtc` from `./projector.ts`.
  - Read the live cap before each commit and pass it in. In `commitFromBody` (~742), before `db.write(... commitAcquisition ...)` at ~767:
    ```ts
    const maxAgeDays = Number((await deps.getSetting?.('max_remote_item_age_days')) ?? '0')
    ```
    and add `maxAgeDays` to the `commitAcquisition(tx, { ... })` input object (here and at the two terminal-only call sites ~828/831 pass `maxAgeDays: 0` — they carry no observations, so any value is inert; use 0 for clarity).
  - `server.ts:37`: `const acquisition = createAcquisition({ db, getSetting: (key) => repo.getSetting(key) })`.
  - The gate, in `commitAcquisition`'s observation loop, right AFTER `const existing = findDelivery.get(...)` and BEFORE `const deliveryId = ...` (~632):
    ```ts
    if (!existing && input.maxAgeDays > 0) {
      const rawPub = (JSON.parse(obs.rawEvidenceJson) as { published?: string | null }).published ?? null
      const pub = normalizeUtc(rawPub)
      const contentDate = pub && pub <= committedAt ? pub : committedAt
      const cutoff = new Date(Date.parse(committedAt) - input.maxAgeDays * 86400000).toISOString()
      if (contentDate < cutoff) { counters.retentionFiltered++; continue } // out-of-window: never create the delivery
    }
    ```
    (`committedAt` is already destructured from `input` at the top of `commitAcquisition`.)

- [ ] **Step 4: Run — expect PASS**, tsc 0, full core suite green (`--no-file-parallelism`).

- [ ] **Step 5: Commit** (`git add core/src/logical/types.ts core/src/logical/acquisition.ts core/src/server.ts core/test/logical-acquisition.test.ts`).

---

### Task 3: Second insert path — `verification.ts` honors the gate

**Files:**
- Investigate + possibly modify: `core/src/logical/verification.ts` (~line 352, the delivery/observation-version insert)
- Test: `core/test/logical-verification.test.ts`

**Interfaces:**
- Consumes: the same content-date + `maxAgeDays` window check as Task 2 (extract a shared helper `isWithinAgeWindow(rawEvidenceJson, committedAt, maxAgeDays)` in `acquisition.ts` and export it, so both paths use one implementation).

- [ ] **Step 1: Determine whether this path can ingest an out-of-window item.**
Read `verification.ts` around 345-360: does this insert create a NEW delivery for a feed item (subject to retention), or only re-record a verified version of an ALREADY-known delivery? Document the finding in the task report.
  - **If it only touches already-known deliveries / verified-origin re-records:** the new-delivery gate does not apply — no code change; add a short test/comment asserting it doesn't create out-of-window *new* deliveries, and close the task.
  - **If it can create a new delivery for an out-of-window item:** proceed to Step 2.

- [ ] **Step 2 (only if needed): Failing test** — the verification path skips an out-of-window new item (no new delivery), mirroring Task 2's gate.

- [ ] **Step 3 (only if needed): Implement** — call the shared `isWithinAgeWindow` helper before the `INSERT INTO deliveries_v2 ... else` branch at ~352; skip creating the delivery/version/job when out of window. Plumb `maxAgeDays` here the same way (live `getSetting`).

- [ ] **Step 4: Run tests + tsc 0.**

- [ ] **Step 5: Commit** (explicit paths).

---

## Self-Review

- **Spec coverage:** Task A→1, Task B→2, Task C→3; C2 stale-test replaced (Task 1 Step 1); `retentionFiltered` counter (Task 2); plumbing at `server.ts:37` (Task 2). Phase 2 (count gate + schema) intentionally absent. ✓
- **One-content-date invariant:** Task 1 and Task 2 use the identical formula (`pub <= arrival ? pub : arrival`, `pub` from `raw_evidence`), so gate/trim/timeline agree. ✓
- **Type consistency:** `maxAgeDays` added to `CommitAcquisitionInput` is threaded at every `commitAcquisition` call site (Task 2 names all three: the real commit + the two terminal-only ones). ✓
- **Open verification note for the executor:** confirm the exact existing acquisition test harness (fake `fetchFn` + `createAcquisition`/`acquireSource`) by reading a neighboring `core/test/logical-acquisition*.test.ts` before Task 2; confirm `NewObservationVersion` carries `rawEvidenceJson` (it does, per the `observations` mapping in `acquisition.ts`).

## Execution Handoff

Recommended: **superpowers:subagent-driven-development** — fresh implementer per task, review after each, whole-branch review on the most capable model at the end (Task 1 is a live regression fix; Task 2 touches the ingestion core). Order is 1 → 2 → 3 (Task 3 depends on Task 2's shared helper).
