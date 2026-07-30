# Remote content retention — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a global, admin-configurable retention policy (max item count +
max item age, per remote source) that trims old remote content after
each poll — local posts are never touched.

**Architecture:** Four tasks. Task 1 is a new, standalone
`trimSourceToCap` function in `tombstones.ts` — no changes to the
existing `removeSourceEvidence`/purge/reap code at all. Task 2 wires it
into `createLogicalRuntime`'s existing post-acquisition drain hook
(`runtime.ts`), reading the two settings live via the existing generic
KV settings store. Task 3 widens the existing `/admin/settings` route
(core) with the two new keys. Task 4 widens the web `/admin/settings`
page to match. Order 1 → 2 → 3 → 4; 2 depends on 1; 4 depends on 3; 3 has
no dependency on 1/2 but is sequenced after them for a single linear
plan.

**Spec:** `docs/superpowers/specs/2026-07-29-remote-content-retention-design.md`
rev 4. Read it for the full grounding (a live-instance investigation
that found the 13,105-post count was real, not a bug) and the three
revision cycles that corrected this plan's mechanism twice before any
code was written — the corrected design in rev 4 is what this plan
implements; don't consult rev 1-3's now-superseded sections if you open
the file's git history.

**Tech Stack:** Node 22 native type-stripping (no build step — `tsc --noEmit`
is the real compile gate, vitest passes on type errors), better-sqlite3,
Hono, SvelteKit 5 (web), vitest.

## Global Constraints

- **Container-only test commands.** `docker compose exec -T core npm run -w core test -- <files>` / `docker compose exec -T core npm run -w core typecheck` for core. `docker compose exec -T web env -u CORE_API_URL npm test -w web -- <files>` / `docker compose exec -T web npm run -w web check` for web. Never bare `vitest`/`npx vitest` — the container's default CWD silently drops web's `$lib`/`$env` aliases.
- **Baseline (re-verify before Task 1):** core suite green, `tsc --noEmit` 0 errors; web suite green, `svelte-check` 0/0. This plan was written against a specific point in time — re-verify fresh, and note the exact counts in your Task 1 report so later tasks can compare deltas.
- **Never `git add -A`** — shared checkout; other sessions may commit to `main` concurrently. Stage explicit paths.
- **`0` means different things for different settings on the same route.** The existing `maxSubsPerUser` setting's `0` means "disable subscribing" (a real, intentional zero). This feature's two new settings use `0` to mean "unlimited" (the default, so shipping is inert). Do not let this asymmetry leak into shared code — each setting's own validation/UI copy must say what its own zero means; don't assume they match.
- **`removeSourceEvidence` (`core/src/logical/tombstones.ts`) is not touched by this feature.** If any task's diff modifies that function, stop — the whole point of this design (rev 2) is that it doesn't need to change.
- **The two settings keys, exact strings, used verbatim in both Task 2 and Task 3:** `max_remote_items_per_source` and `max_remote_item_age_days`.

---

### Task 1: `trimSourceToCap` (standalone, `core/src/logical/tombstones.ts`)

**Files:**
- Modify: `core/src/logical/tombstones.ts` (append the new function; no changes to any existing function in this file)
- Test: `core/test/source-cleanup.test.ts` (append)

**Interfaces:**
- Consumes: nothing from another task — this is a pure function over a `WriteTx`, using only `hasChildEdge`, `deleteLogicalNode`, `convertToStructuralTombstone`, `sweepStructuralTombstones` (already imported into `tombstones.ts` from `./threading.ts`) and `applySelectionHints` (already imported from `./reconcile.ts`).
- Produces: `export function trimSourceToCap(tx: WriteTx, input: { sourceId: string; maxCount: number; maxAgeDays: number; now: string }): { trimmedCount: number }`. Task 2 imports and calls this by name with these exact parameter names.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Record the exact test count and confirm 0 tsc errors.

- [ ] **Step 2: Read `core/src/logical/tombstones.ts` in full before editing**

Confirm the current file still has, near the top, these imports (added to if anything is missing, never removed):
```ts
import type { ReadTx, WriteTx } from './database.ts'
import { applySelectionHints } from './reconcile.ts'
import { deleteLogicalNode, convertToStructuralTombstone, hasChildEdge, sweepStructuralTombstones } from './threading.ts'
```
And confirm `removeSourceEvidence` (currently ~lines 94-183) still reads as the plan's Global Constraints describe. If it has drifted meaningfully, stop and re-read the surrounding file before writing Step 4's code — this plan's algorithm is written to mirror that function's exact FK order and per-item sequencing, not just something similar to it.

- [ ] **Step 3: Write the failing tests** (append to `core/test/source-cleanup.test.ts`, after the existing `seedEvidence` helper and its neighboring tests)

Read the existing `insertSourceRow`, `countRows`, `seedEvidence`, and `NOW` constant already in this file (used by the tests immediately above) before writing these — match their exact style, don't invent new helpers for things these already do.

```ts
// --- remote-content-retention: trimSourceToCap (standalone, core/src/logical/tombstones.ts) ---

// Seeds a remote item with a specific timeline_sort_at (unlike seedEvidence,
// which always uses NOW) so count/age ordering tests can control which items
// rank as "oldest." Mirrors seedEvidence's shape exactly, minus the verified
// option (not needed here).
function seedItemAt(raw: Raw, sourceId: string, sortAt: string): string {
  const itemId = randomUUID()
  const deliveryId = randomUUID()
  const versionId = randomUUID()
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'remote', ?, 'none', NULL, ?, NULL, ?)`).run(itemId, sortAt, deliveryId, NOW)
  raw.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, 'opaque', ?, ?, ?, ?, 1)`).run(deliveryId, sourceId, itemId, NOW, NOW, randomUUID())
  raw.prepare(`INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json) VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?, ?, 1, '{}', '{}')`).run(versionId, deliveryId, randomUUID(), Buffer.from('m'), sortAt, randomUUID(), NOW, randomUUID())
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('delivery', ?, ?)`).run(deliveryId, itemId)
  return itemId
}

test('trimSourceToCap: 0/0 is a no-op fast path', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-noop.test/feed' })
  seedItemAt(raw, src, NOW)
  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 0, maxAgeDays: 0, now: NOW }))()
  expect(result).toEqual({ trimmedCount: 0 })
  expect(countRows(raw, 'logical_items_v2')).toBe(1)
  repo.close()
})

test('trimSourceToCap: count cap keeps the N most recent, deletes the rest', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-count.test/feed' })
  const oldest = seedItemAt(raw, src, '2020-01-01T00:00:00.000Z')
  const middle = seedItemAt(raw, src, '2023-01-01T00:00:00.000Z')
  const newest = seedItemAt(raw, src, '2026-01-01T00:00:00.000Z')
  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 2, maxAgeDays: 0, now: NOW }))()
  expect(result).toEqual({ trimmedCount: 1 })
  const remaining = raw.prepare(`SELECT id FROM logical_items_v2`).all().map((r) => (r as { id: string }).id)
  expect(remaining.sort()).toEqual([middle, newest].sort())
  expect(remaining).not.toContain(oldest)
  expect(countRows(raw, 'deliveries_v2')).toBe(2)
  repo.close()
})

test('trimSourceToCap: age cap deletes anything older than the cutoff, regardless of count', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-age.test/feed' })
  const NOW_MS = Date.parse(NOW)
  const old = seedItemAt(raw, src, new Date(NOW_MS - 40 * 86400000).toISOString()) // 40 days old
  const recent = seedItemAt(raw, src, new Date(NOW_MS - 5 * 86400000).toISOString()) // 5 days old
  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 0, maxAgeDays: 30, now: NOW }))()
  expect(result).toEqual({ trimmedCount: 1 })
  const remaining = raw.prepare(`SELECT id FROM logical_items_v2`).all().map((r) => (r as { id: string }).id)
  expect(remaining).toEqual([recent])
  void old
  repo.close()
})

test('trimSourceToCap: count and age union — whichever catches an item removes it', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-union.test/feed' })
  const NOW_MS = Date.parse(NOW)
  // 3 items, all within the count cap (maxCount=5), but the oldest is past the age cap.
  const veryOld = seedItemAt(raw, src, new Date(NOW_MS - 100 * 86400000).toISOString())
  const mid = seedItemAt(raw, src, new Date(NOW_MS - 10 * 86400000).toISOString())
  const recent = seedItemAt(raw, src, NOW)
  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 5, maxAgeDays: 30, now: NOW }))()
  expect(result).toEqual({ trimmedCount: 1 })
  const remaining = raw.prepare(`SELECT id FROM logical_items_v2`).all().map((r) => (r as { id: string }).id)
  expect(remaining.sort()).toEqual([mid, recent].sort())
  void veryOld
  repo.close()
})

test('trimSourceToCap: local items are never selected regardless of settings', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-local.test/feed' })
  const local = randomUUID()
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'local', ?, 'none', NULL, NULL, NULL, ?)`).run(local, '2020-01-01T00:00:00.000Z', NOW)
  seedItemAt(raw, src, NOW)
  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 1, maxAgeDays: 1, now: NOW }))()
  expect(result.trimmedCount).toBe(0) // the one remote item is within maxCount=1; the local item is never a candidate
  expect(countRows(raw, 'logical_items_v2')).toBe(2)
  repo.close()
})

test('trimSourceToCap: a reply surviving its trimmed parent becomes a structural tombstone', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-reply.test/feed' })
  const parent = seedItemAt(raw, src, '2020-01-01T00:00:00.000Z') // will be trimmed (beyond maxCount=1)
  const reply = seedItemAt(raw, src, NOW) // survives, under the cap
  raw.prepare(`UPDATE logical_items_v2 SET parent_logical_item_id = ?, parent_state = 'resolved' WHERE id = ?`).run(parent, reply)

  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 1, maxAgeDays: 0, now: NOW }))()
  expect(result).toEqual({ trimmedCount: 1 })
  const parentRow = raw.prepare(`SELECT structural_tombstone, selected_delivery_id FROM logical_items_v2 WHERE id = ?`).get(parent) as { structural_tombstone: number; selected_delivery_id: string | null }
  expect(parentRow.structural_tombstone).toBe(1)
  expect(parentRow.selected_delivery_id).toBeNull()
  expect(countRows(raw, 'logical_items_v2')).toBe(2) // parent survives as a tombstone, not deleted
  repo.close()
})

test('trimSourceToCap: an excess item with a surviving delivery from a DIFFERENT source reselects instead of being deleted', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-reselect-src.test/feed' })
  const otherSrc = insertSourceRow(raw, { canonicalUrl: 'https://trim-reselect-other.test/feed' })
  const trimmed = seedItemAt(raw, src, '2020-01-01T00:00:00.000Z') // this source's delivery for it will be removed
  seedItemAt(raw, src, NOW) // keeps `src` at exactly maxCount=1, pushing `trimmed` out

  // The SAME logical item also has a delivery from otherSrc (a cross-source
  // merge, e.g. the two feeds carry identical content) -- add a second
  // identity key + delivery pointing at the same logical item id, from otherSrc.
  const otherDeliveryId = randomUUID()
  raw.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, 'opaque', ?, ?, ?, ?, 1)`).run(otherDeliveryId, otherSrc, trimmed, NOW, NOW, randomUUID())
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('delivery', ?, ?)`).run(otherDeliveryId, trimmed)

  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 1, maxAgeDays: 0, now: NOW }))()
  expect(result).toEqual({ trimmedCount: 1 })
  // Reselected, not deleted or tombstoned: the item row still exists, not a tombstone.
  const row = raw.prepare(`SELECT structural_tombstone FROM logical_items_v2 WHERE id = ?`).get(trimmed) as { structural_tombstone: number } | undefined
  expect(row).toBeDefined()
  expect(row!.structural_tombstone).toBe(0)
  expect(countRows(raw, 'logical_items_v2')).toBe(2)
  repo.close()
})

test('trimSourceToCap never touches source-scoped tables or the source row itself', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-scope.test/feed' })
  seedItemAt(raw, src, '2020-01-01T00:00:00.000Z')
  seedItemAt(raw, src, NOW)
  raw.prepare(`INSERT INTO source_health_v2 (source_id, last_poll_at, consecutive_failures) VALUES (?, ?, 0)`).run(src, NOW)
  raw.prepare(`INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, outcome, counters_json) VALUES (?, ?, 'scheduled', 'terminal', ?, 'parsed', '{}')`).run(randomUUID(), src, NOW)

  raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 1, maxAgeDays: 0, now: NOW }))()
  expect(countRows(raw, 'remote_sources_v2')).toBe(1)
  expect(countRows(raw, 'source_health_v2')).toBe(1)
  expect(countRows(raw, 'acquisition_runs_v2')).toBe(1)
  repo.close()
})
```

These two `INSERT`s were verified against `core/src/logical/schema.ts`'s real `CREATE TABLE` statements (~lines 127-148) — both tables have `NOT NULL` columns beyond `source_id` (`acquisition_runs_v2` needs `reason`, `outcome`, `counters_json`; `source_health_v2` needs `consecutive_failures`), so a naive guess omitting them would fail the insert outright, not just be incomplete.

- [ ] **Step 4: Run to verify the tests fail**

Run: `docker compose exec -T core npm run -w core test -- source-cleanup.test.ts`
Expected: FAIL — `trimSourceToCap is not a function` (or a TS error if run through typecheck first).

- [ ] **Step 5: Implement** (append to `core/src/logical/tombstones.ts`, after `removeSourceEvidence` and before the purge command section — do not insert code inside `removeSourceEvidence` itself)

```ts
// Remote content retention (spec 2026-07-29, rev 4): trims a source's OLDEST
// remote items once it exceeds an admin-configured count and/or age cap.
// Deliberately standalone -- NOT a generalization of removeSourceEvidence.
// Most of that function's FK deletes are source-scoped (acquisition_runs_v2,
// source_health_v2, source_validators_v2, verification_checks_v2,
// policy_fanout_v2, publisher_names_v2) and must NEVER run here: a trim keeps
// the source polling, only removing some of its old items, so this owns only
// the delivery/observation-version-scoped tables a partial removal needs.
// Local items are never candidates (origin='remote' only); the source row,
// its health/validator/run history, and unreferenced-publisher cleanup are
// untouched -- those belong only to a full source removal (purge/reap).
export function trimSourceToCap(tx: WriteTx, input: { sourceId: string; maxCount: number; maxAgeDays: number; now: string }): { trimmedCount: number } {
  const { sourceId, maxCount, maxAgeDays, now } = input
  if (maxCount <= 0 && maxAgeDays <= 0) return { trimmedCount: 0 }

  const rows = tx.prepare(
    `SELECT li.id AS id, li.selected_delivery_id AS deliveryId, li.timeline_sort_at AS timelineSortAt
     FROM logical_items_v2 li JOIN deliveries_v2 d ON d.id = li.selected_delivery_id
     WHERE d.source_id = ? AND li.origin = 'remote'
     ORDER BY li.timeline_sort_at DESC`,
  ).all(sourceId) as { id: string; deliveryId: string; timelineSortAt: string }[]

  const excess = new Set<string>()
  if (maxAgeDays > 0) {
    const cutoff = new Date(Date.parse(now) - maxAgeDays * 86400000).toISOString()
    for (const r of rows) if (r.timelineSortAt < cutoff) excess.add(r.id)
  }
  if (maxCount > 0) {
    for (const r of rows.slice(maxCount)) excess.add(r.id)
  }
  if (excess.size === 0) return { trimmedCount: 0 }

  const excessRows = rows.filter((r) => excess.has(r.id))
  const deliveryIds = [...new Set(excessRows.map((r) => r.deliveryId))]
  const dph = deliveryIds.map(() => '?').join(',')

  // ---- delete delivery/observation-scoped rows FIRST, so the per-item
  // hasDelivery check below (which relies on these rows already being gone)
  // correctly reflects whether a surviving delivery remains -- same ordering
  // constraint removeSourceEvidence's own equivalent step observes. ----
  const versionRows = tx.prepare(`SELECT id FROM observation_versions_v2 WHERE delivery_id IN (${dph})`).all(...deliveryIds) as { id: string }[]
  const versionIds = versionRows.map((r) => r.id)
  if (versionIds.length > 0) {
    const vph = versionIds.map(() => '?').join(',')
    tx.prepare(`DELETE FROM reconciliation_jobs_v2 WHERE observation_version_id IN (${vph})`).run(...versionIds)
    tx.prepare(`DELETE FROM publisher_claims_v2 WHERE observation_version_id IN (${vph})`).run(...versionIds)
    tx.prepare(`DELETE FROM logical_conflicts_v2 WHERE observation_version_id IN (${vph})`).run(...versionIds)
  }
  tx.prepare(`DELETE FROM presentation_entries_v2 WHERE delivery_id IN (${dph})`).run(...deliveryIds)
  tx.prepare(`DELETE FROM observation_versions_v2 WHERE delivery_id IN (${dph})`).run(...deliveryIds)
  tx.prepare(`DELETE FROM logical_identity_keys_v2 WHERE kind = 'delivery' AND key IN (${dph})`).run(...deliveryIds)
  tx.prepare(`DELETE FROM deliveries_v2 WHERE id IN (${dph})`).run(...deliveryIds)

  // ---- per-item reselect/delete/tombstone -- identical sequence to
  // removeSourceEvidence's own loop, scoped to just the excess ids ----
  const hasDelivery = (id: string): boolean =>
    tx.prepare(`SELECT 1 FROM logical_identity_keys_v2 WHERE kind = 'delivery' AND logical_item_id = ? LIMIT 1`).get(id) !== undefined
  const unsupported = new Set<string>()
  for (const id of excess) {
    if (hasDelivery(id)) applySelectionHints(tx, id, '') // a different source's delivery still backs it
    else unsupported.add(id)
  }
  const deletedParents: Array<string | null> = []
  let changed = true
  while (changed) {
    changed = false
    for (const id of [...unsupported]) {
      if (hasChildEdge(tx, id)) continue
      const row = tx.prepare(`SELECT parent_logical_item_id AS p FROM logical_items_v2 WHERE id = ?`).get(id) as { p: string | null } | undefined
      deleteLogicalNode(tx, id)
      unsupported.delete(id)
      deletedParents.push(row ? row.p : null)
      changed = true
    }
  }
  for (const id of unsupported) convertToStructuralTombstone(tx, id)
  sweepStructuralTombstones(tx, deletedParents, now)

  return { trimmedCount: excess.size }
}
```

- [ ] **Step 6: Run to verify the tests pass**

Run: `docker compose exec -T core npm run -w core test -- source-cleanup.test.ts`
Expected: PASS, all 8 new tests plus every pre-existing test in this file green.

- [ ] **Step 7: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 0 tsc errors, all tests pass (baseline count + 8 new). Confirm specifically that no test in `logical-purge.test.ts` or elsewhere in `source-cleanup.test.ts` regressed — this task must not change `removeSourceEvidence`'s behavior at all.

- [ ] **Step 8: Commit**

```bash
git add core/src/logical/tombstones.ts core/test/source-cleanup.test.ts
git commit -m "core: trimSourceToCap -- standalone remote-item retention trim

New, standalone function (not a removeSourceEvidence refactor -- see the
spec's rev 2 for why that was the wrong approach): trims a source's
oldest remote items past an admin-configured count/age cap, reusing the
same per-item reselect/delete/structural-tombstone primitives purge
already calls (hasChildEdge/deleteLogicalNode/convertToStructuralTombstone/
applySelectionHints), scoped to just the excess deliveries rather than
every delivery for the source. removeSourceEvidence itself is untouched.

developed with the help of AI tools"
```

---

### Task 2: Wire the trim into `createLogicalRuntime`'s post-acquisition drain

**Files:**
- Modify: `core/src/logical/runtime.ts` (the `getSetting?` field on `createLogicalRuntime`'s input type; the `wrapped.acquireSource` body)
- Modify: `core/src/server.ts` (wire `getSetting: (key) => repo.getSetting(key)` into the `createLogicalRuntime({...})` call)
- Modify: `core/test/logical-vertical.test.ts` (widen the file-local `mkRuntime` helper with one new optional parameter; append the new test)

**Interfaces:**
- Consumes: Task 1's `trimSourceToCap(tx, { sourceId, maxCount, maxAgeDays, now })`, imported from `./tombstones.ts`.
- Produces: nothing new consumed by later tasks — Task 3/4 are independent (both just extend the existing `/admin/settings` route using the same setting-key strings this task also uses).

- [ ] **Step 1: Confirm Task 1 landed**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`

- [ ] **Step 2: Read `core/src/logical/runtime.ts` fresh**, specifically:
  - `createLogicalRuntime`'s input type (currently ~lines 338-352)
  - the `wrapped: AcquisitionEngine` object (currently ~lines 403-410)
  - the `drainSync` closure (currently ~lines 378-382)

Confirm these still read as this plan and the spec describe. Re-derive the exact current line numbers rather than trusting this plan's citations blind — Task 1 didn't touch this file, but another session may have, since this is a shared checkout.

- [ ] **Step 3: Write the failing test.** `core/test/logical-vertical.test.ts` already has the exact fixture toolkit this needs: `fresh()` (repo/raw/db/store), `seedSource`, `seedJob` (hand-seeds a delivery+version+pending job, avoiding a crafted wire body), `fakeFetch`/`ok`/`RSS`/`linkItem` (a stubbed network layer for a real `createAcquisition` engine), and the file-local `mkRuntime(deps, acquisition, order?)` helper (currently ~lines 96-98).

First, widen `mkRuntime` with one new optional parameter (every existing call site omits it, so none need updating):

```ts
const mkRuntime = (deps: Awaited<ReturnType<typeof fresh>>, acquisition: AcquisitionEngine = stubEngine, order?: string[], getSetting?: (key: string) => Promise<string | undefined>): LogicalRuntime =>
  createLogicalRuntime({ db: deps.db, store: deps.store, acquisition, config: TEST_CONFIG, now: () => NOW, ...(order ? { trace: (p: string) => order.push(p) } : {}), ...(getSetting ? { getSetting } : {}) })
```

Then append the test (near the other `mkRuntime(deps, engine)` tests, e.g. after the crash-recovery block around line 213):

```ts
test('acquireSource (through the runtime wrapper) trims a source to its configured cap once the poll drains', async () => {
  const deps = await fresh()
  await deps.repo.setSetting('max_remote_items_per_source', '1')
  seedSource(deps.raw, 's1', 'https://feed.test/s1')
  // one existing remote item for s1, committed before the poll below
  seedJob(deps.raw, { sourceId: 's1', deliveryKey: { kind: 'link', key: 'https://blog.test/existing' }, committedAt: NOW, material: { permalink: 'https://blog.test/existing' } })
  drainReconciliation({ store: deps.store, now: () => NOW })
  expect(count(deps.raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(1)

  const engine = createAcquisition({ db: deps.db, fetchFn: fakeFetch({ 'https://feed.test/s1': () => ok(RSS(linkItem('https://blog.test/new'))) }), lookupFn: publicLookup, now: () => LATER })
  const runtime = mkRuntime(deps, engine, undefined, (key) => deps.repo.getSetting(key))
  await runtime.ready
  await runtime.acquisition.acquireSource('s1', { kind: 'scheduled' }, undefined)
  await runtime.stop()

  // A second remote item just arrived (LATER than the existing one), but the
  // cap is 1 -- the older one is trimmed once the poll's drain completes.
  expect(count(deps.raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(1)
  const remaining = deps.raw.prepare(`SELECT selected_delivery_id FROM logical_items_v2 WHERE origin = 'remote'`).get() as { selected_delivery_id: string }
  const survivingKey = (deps.raw.prepare(`SELECT key FROM deliveries_v2 WHERE id = ?`).get(remaining.selected_delivery_id) as { key: string }).key
  expect(survivingKey).toBe('https://blog.test/new')
})
```

- [ ] **Step 4: Run to verify it fails**

Run: `docker compose exec -T core npm run -w core test -- logical-vertical.test.ts`
Expected: FAIL — either a TS error (`getSetting` not a known property yet) or a runtime assertion failure (the item count isn't trimmed).

- [ ] **Step 5: Implement.** In `core/src/logical/runtime.ts`:

Add the import (alongside the file's existing `./reconcile.ts`/`./threading.ts`-style imports):
```ts
import { trimSourceToCap } from './tombstones.ts'
```

Widen `createLogicalRuntime`'s input type — add one optional field to the existing inline type (do not restructure the rest of it):
```ts
  getSetting?: (key: string) => Promise<string | undefined>
```

Replace the `wrapped: AcquisitionEngine` object:
```ts
  const wrapped: AcquisitionEngine = {
    inFlight: (id) => acquisition.inFlight(id),
    async acquireSource(id, reason, signal) {
      const r = await acquisition.acquireSource(id, reason, signal)
      if (!('kind' in r)) {
        drainSync()
        const getSetting = input.getSetting ?? (async () => undefined)
        const maxCount = Number((await getSetting('max_remote_items_per_source')) ?? '0')
        const maxAgeDays = Number((await getSetting('max_remote_item_age_days')) ?? '0')
        if (maxCount > 0 || maxAgeDays > 0) {
          db.write((tx) => trimSourceToCap(tx, { sourceId: id, maxCount, maxAgeDays, now: now() }))
        }
      }
      return r
    },
  }
```

Verify `db`, `now`, and `drainSync` are all already in scope at this point in the closure (they are — `db`/`now` are destructured/derived near the top of `createLogicalRuntime`, `drainSync` is defined a few lines above `wrapped`) before assuming this compiles as written.

In `core/src/server.ts`, widen the `createLogicalRuntime({...})` call (currently ~line 37):
```ts
const runtime = createLogicalRuntime({
  db,
  store: logicalStore,
  acquisition,
  config,
  notify: (sequence) => bus.emitSequenceHint(sequence),
  getSetting: (key) => repo.getSetting(key),
})
```
(`repo` is already constructed earlier in this file, before this call — confirm this is still true before assuming the wiring compiles.)

- [ ] **Step 6: Run to verify the new test passes**

Run: `docker compose exec -T core npm run -w core test -- logical-vertical.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 0 tsc errors, all tests pass. Pay particular attention to any test that constructs `createLogicalRuntime` directly (5 files per the spec's grep) — they should all still pass unchanged, since `getSetting` is optional with an inert default.

- [ ] **Step 8: Commit**

```bash
git add core/src/logical/runtime.ts core/src/server.ts core/test/logical-vertical.test.ts
git commit -m "core: wire retention trimming into the post-acquisition drain

createLogicalRuntime's wrapped acquireSource already runs drainSync()
after every committed poll -- the actual moment a source's new items are
guaranteed reconciled into logical_items_v2. createLogicalRuntime's input
gains an optional getSetting (inert default; only server.ts's real call
site wires it to repo.getSetting), read live after drainSync() to call
trimSourceToCap in its own transaction when either setting is non-zero.
commitAcquisition/AcquisitionDeps/CommitAcquisitionInput are untouched --
reconciliation is async and job-based, so hooking there would check
state that doesn't exist yet (see the spec's rev 4).

developed with the help of AI tools"
```

---

### Task 3: Core admin settings API (`core/src/api/app.ts`)

**Files:**
- Modify: `core/src/api/app.ts` (widen the existing `GET`/`PATCH /admin/settings` routes)
- Test: `core/test/admin-settings.test.ts` (append)

**Interfaces:**
- Consumes: the same two setting-key string literals Task 2 uses (`max_remote_items_per_source`, `max_remote_item_age_days`) — no shared constant exists for `max_subs_per_user` either (it's a literal in this same route), so don't introduce one here.
- Produces: `GET /admin/settings` response gains `maxRemoteItemsPerSource: number` and `maxRemoteItemAgeDays: number`; `PATCH /admin/settings` requires both alongside `maxSubsPerUser` on every request (the existing route's all-or-nothing convention, confirmed in Step 2 — no partial updates). Task 4 (web) consumes this exact response/request shape.

- [ ] **Step 1: Confirm Task 2 landed**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`

- [ ] **Step 2: Read the current `/admin/settings` routes fresh** (`core/src/api/app.ts`, currently ~lines 479-491) and the full `core/test/admin-settings.test.ts` file, to confirm they still match what this plan assumes: `PATCH` currently requires `maxSubsPerUser` on every request — there is no partial-update support (a request with only some fields 400s). This task's two new fields follow the same all-or-nothing convention: every PATCH must carry all three fields. If a prior commit changed this convention since this plan was written, stop and re-derive Step 3/5 from the real current behavior instead of this plan's assumption — don't silently pick either convention on your own.

- [ ] **Step 3: Write the failing tests** (append to `core/test/admin-settings.test.ts`, mirroring the existing tests' exact style — `makeApp()`, `registeredSession`, the same request/response shape checks)

```ts
test('GET /admin/settings: includes the retention defaults (unlimited)', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/settings', { headers: { cookie } })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.maxRemoteItemsPerSource).toBe(0)
  expect(body.maxRemoteItemAgeDays).toBe(0)
})

test('PATCH /admin/settings: updates the retention caps, GET reflects it', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const patch = await app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ maxSubsPerUser: 500, maxRemoteItemsPerSource: 200, maxRemoteItemAgeDays: 90 }),
  })
  expect(patch.status).toBe(200)
  const get = await app.request('/admin/settings', { headers: { cookie } })
  const body = await get.json()
  expect(body.maxRemoteItemsPerSource).toBe(200)
  expect(body.maxRemoteItemAgeDays).toBe(90)
})

test('PATCH /admin/settings: rejects non-integer or negative retention values', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  for (const bad of [{ maxRemoteItemsPerSource: -1 }, { maxRemoteItemsPerSource: 1.5 }, { maxRemoteItemAgeDays: -1 }, { maxRemoteItemAgeDays: 'ten' }]) {
    const res = await app.request('/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ maxSubsPerUser: 500, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, ...bad }),
    })
    expect(res.status).toBe(400)
  }
})

test('PATCH /admin/settings: accepts 0 for both retention fields (means unlimited, not disabled)', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ maxSubsPerUser: 500, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0 }),
  })
  expect(res.status).toBe(200)
})
```

These bodies already carry all three fields on every PATCH, matching the existing route's confirmed all-or-nothing convention (Step 2).

- [ ] **Step 4: Run to verify the tests fail**

Run: `docker compose exec -T core npm run -w core test -- admin-settings.test.ts`
Expected: FAIL — the new fields are absent from GET's response / PATCH doesn't recognize them.

- [ ] **Step 5: Implement.** Replace the two routes in `core/src/api/app.ts`:

```ts
app.get('/admin/settings', async (c) =>
  c.json({
    maxSubsPerUser: Number(await service.getSetting('max_subs_per_user') ?? '500'),
    maxRemoteItemsPerSource: Number(await service.getSetting('max_remote_items_per_source') ?? '0'),
    maxRemoteItemAgeDays: Number(await service.getSetting('max_remote_item_age_days') ?? '0'),
  }))

app.patch('/admin/settings', jsonWrite, async (c) => {
  const body = await readJsonBody(c)
  if (!body) return c.json({ error: 'body invalid' }, 400)
  const { maxSubsPerUser, maxRemoteItemsPerSource, maxRemoteItemAgeDays } = body
  if (!(typeof maxSubsPerUser === 'number' && Number.isInteger(maxSubsPerUser) && maxSubsPerUser >= 0)) {
    return c.json({ error: 'maxSubsPerUser invalid' }, 400)
  }
  if (!(typeof maxRemoteItemsPerSource === 'number' && Number.isInteger(maxRemoteItemsPerSource) && maxRemoteItemsPerSource >= 0)) {
    return c.json({ error: 'maxRemoteItemsPerSource invalid' }, 400)
  }
  if (!(typeof maxRemoteItemAgeDays === 'number' && Number.isInteger(maxRemoteItemAgeDays) && maxRemoteItemAgeDays >= 0)) {
    return c.json({ error: 'maxRemoteItemAgeDays invalid' }, 400)
  }
  await service.setSetting('max_subs_per_user', String(maxSubsPerUser))
  await service.setSetting('max_remote_items_per_source', String(maxRemoteItemsPerSource))
  await service.setSetting('max_remote_item_age_days', String(maxRemoteItemAgeDays))
  return c.json({ maxSubsPerUser, maxRemoteItemsPerSource, maxRemoteItemAgeDays }, 200)
})
```

This matches the existing route's confirmed all-or-nothing convention (Step 2) — every field required on every PATCH.

- [ ] **Step 6: Run to verify the tests pass, then the full core suite + typecheck**

Run: `docker compose exec -T core npm run -w core test -- admin-settings.test.ts` then `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: PASS, 0 tsc errors. The pre-existing `maxSubsPerUser`-only PATCH bodies in this file's earlier tests (e.g. `{ maxSubsPerUser: 1 }` alone) will now 400, since the route requires all three fields — update those pre-existing test bodies to also carry `maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0`. This is a necessary, expected consequence of widening required fields on an all-or-nothing route, not scope creep.

- [ ] **Step 7: Commit**

```bash
git add core/src/api/app.ts core/test/admin-settings.test.ts
git commit -m "core: /admin/settings gains the two remote-retention caps

GET/PATCH /admin/settings widened with maxRemoteItemsPerSource and
maxRemoteItemAgeDays, same generic getSetting/setSetting KV store as the
existing maxSubsPerUser, same validation shape (integer >= 0). Both
default to 0 (unlimited) -- note this is a DIFFERENT meaning of 0 than
maxSubsPerUser's own 0 (which disables subscribing).

developed with the help of AI tools"
```

---

### Task 4: Web admin settings UI

**Files:**
- Modify: `web/src/lib/api.ts` (`getAdminSettings`/`patchAdminSettings` types)
- Modify: `web/src/routes/admin/settings/+page.server.ts` (read/validate/submit the two new fields)
- Modify: `web/src/routes/admin/settings/+page.svelte` (two new form fields)
- Test: none of these files currently have a dedicated render/action test — check for one (`grep -rl "admin/settings" web/src --include='*.test.ts'`) before assuming none exists; if one exists, extend it matching its existing style; if genuinely none exists, this task does not need to invent one (matching the existing untested state of this page — don't add test infrastructure beyond this plan's scope).

**Interfaces:**
- Consumes: Task 3's widened `GET`/`PATCH /admin/settings` response/request shape.

This task touches Svelte 5/SvelteKit code and UI copy — consult the relevant `svelte-skills` (`sveltekit-data-flow` for the load/action pattern) and the `ui-ux-pro-max` skill before writing the two new form fields, per this project's CLAUDE.md. This page's existing field (`max-subs`) already establishes the exact pattern (label, number input with `min="0"`, a `field-hint` paragraph) — match it, don't invent a new layout.

- [ ] **Step 1: Confirm Task 3 landed**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web && docker compose exec -T web npm run -w web check`

- [ ] **Step 2: Invoke the required skills**, then read `web/src/lib/api.ts`'s current `getAdminSettings`/`patchAdminSettings` (currently ~lines 177-190), `web/src/routes/admin/settings/+page.server.ts` in full, and `+page.svelte` in full — all quoted in this plan's research above; re-read live since Task 3 may have shifted nearby line numbers in `api.ts` (Task 3 didn't touch this file, but confirm).

- [ ] **Step 3: Implement.** `web/src/lib/api.ts`:

```ts
export async function getAdminSettings(f: typeof fetch): Promise<{ maxSubsPerUser: number; maxRemoteItemsPerSource: number; maxRemoteItemAgeDays: number }> {
	const res = await f(`${base()}/admin/settings`)
	if (!res.ok) throw new Error(await errorMessage(res, 'getAdminSettings failed'))
	return (await res.json()) as { maxSubsPerUser: number; maxRemoteItemsPerSource: number; maxRemoteItemAgeDays: number }
}

export async function patchAdminSettings(f: typeof fetch, body: { maxSubsPerUser: number; maxRemoteItemsPerSource: number; maxRemoteItemAgeDays: number }): Promise<void> {
	const res = await f(`${base()}/admin/settings`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	})
	if (!res.ok) throw new Error(await errorMessage(res, 'patchAdminSettings failed'))
}
```

`web/src/routes/admin/settings/+page.server.ts`:

```ts
import { fail } from '@sveltejs/kit'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { getAdminSettings, patchAdminSettings } from '$lib/api'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	return { settings: await getAdminSettings(f) }
}

function parseNonNegativeInt(raw: FormDataEntryValue | null, field: string): number {
	const value = Number(String(raw ?? '').trim())
	if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be an integer ≥ 0`)
	return value
}

export const actions: Actions = {
	save: async (event) => {
		const form = await event.request.formData()
		let maxSubsPerUser: number, maxRemoteItemsPerSource: number, maxRemoteItemAgeDays: number
		try {
			maxSubsPerUser = parseNonNegativeInt(form.get('maxSubsPerUser'), 'maxSubsPerUser')
			maxRemoteItemsPerSource = parseNonNegativeInt(form.get('maxRemoteItemsPerSource'), 'maxRemoteItemsPerSource')
			maxRemoteItemAgeDays = parseNonNegativeInt(form.get('maxRemoteItemAgeDays'), 'maxRemoteItemAgeDays')
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'invalid input' })
		}
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await patchAdminSettings(f, { maxSubsPerUser, maxRemoteItemsPerSource, maxRemoteItemAgeDays })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'save failed' })
		}
		return { saved: true }
	}
}
```

(Widened from the existing single-field `Number(raw)`/`Number.isInteger` check into a small shared `parseNonNegativeInt` helper, since the same validation now repeats three times — this is the kind of duplication worth a one-line helper, not three copy-pasted blocks.)

`web/src/routes/admin/settings/+page.svelte` — add two fields to the existing form, following its exact established pattern:

```svelte
<form method="POST" action="?/save" use:enhance>
	<div class="field">
		<label for="max-subs">Max subscriptions per user</label>
		<input id="max-subs" name="maxSubsPerUser" type="number" min="0" required value={data.settings.maxSubsPerUser} />
		<p class="field-hint">Self-serve subscriptions (person + web feeds) each registered user may hold. Default 500.</p>
	</div>
	<div class="field">
		<label for="max-remote-items">Max remote items per source</label>
		<input id="max-remote-items" name="maxRemoteItemsPerSource" type="number" min="0" required value={data.settings.maxRemoteItemsPerSource} />
		<p class="field-hint">Keeps only the N most recent items from each remote source, trimming older ones after each poll. 0 means unlimited (default) — local posts are never affected.</p>
	</div>
	<div class="field">
		<label for="max-remote-age">Max remote item age (days)</label>
		<input id="max-remote-age" name="maxRemoteItemAgeDays" type="number" min="0" required value={data.settings.maxRemoteItemAgeDays} />
		<p class="field-hint">Trims remote items older than this many days after each poll. 0 means unlimited (default) — local posts are never affected.</p>
	</div>
	<button>Save</button>
</form>
```

- [ ] **Step 4: Run the web suite + svelte-check**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web && docker compose exec -T web npm run -w web check`
Expected: 0 svelte-check errors, all tests pass (no new test file per this task's Files note, unless Step 1's grep found an existing one to extend — if so, extend it with the same 3 field-round-trip + validation cases Task 3's core tests cover, at the HTTP-via-load/action layer instead).

- [ ] **Step 5: Manual smoke** (last task in this plan)

Using the running dev stack: load `/admin/settings`, confirm the two new fields render with the existing field's exact visual style, save a non-zero value for each, reload and confirm they persist, save `0` for both and confirm the save succeeds (0 means unlimited here, unlike `maxSubsPerUser`'s own `0`).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/routes/admin/settings/+page.server.ts web/src/routes/admin/settings/+page.svelte
git commit -m "web: admin/settings exposes the two remote-retention caps

Two new fields on the existing settings form, matching maxSubsPerUser's
established pattern exactly (label, number input min=0, a field-hint
paragraph). parseNonNegativeInt collapses what would otherwise be three
copies of the same validation into one small helper.

developed with the help of AI tools"
```

---

## Final verification (after all 4 tasks)

- [ ] `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck` — core suite green, 0 errors.
- [ ] `docker compose exec -T web env -u CORE_API_URL npm test -w web && docker compose exec -T web npm run -w web check` — web suite green, 0 errors.
- [ ] Manual smoke on the running dev stack: set a small `maxRemoteItemsPerSource` (e.g. 3) on a test instance with a source that has more than 3 remote items, trigger a poll (admin refresh or wait for the scheduler), and confirm the item count for that source drops to 3 after the poll. Confirm local posts are untouched throughout.
- [ ] Re-confirm the spec's own Motivation is actually addressed: on an instance resembling `rsc.rmdes.be`'s real state, setting the cap and letting sources repoll should visibly shrink the item count over time (not instantly — per the no-periodic-sweep, lazy-trim-on-next-poll design).

*developed with the help of AI tools*
