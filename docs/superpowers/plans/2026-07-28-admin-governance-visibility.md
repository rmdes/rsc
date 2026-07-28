# Admin source & user governance visibility — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make buried admin sources/users findable (URL search + real
pagination), show who added each source, add an always-visible paginated
orphan group with a retention-reason label per row, add an operator-override
reap command, and extend `listUsers` to real cursor pagination — per
`docs/superpowers/specs/2026-07-25-admin-governance-visibility-design.md`
(rev 2).

**Architecture:** Five tasks. Task 1 extends the core source-summary read
(`q`, `filter=orphan`, `retention`, `addedBy`). Task 2 adds the operator reap
command (a new route + a refactored `reapSource` sharing all of
`reapSourceIfOrphaned`'s guards plus an operator-override path). Task 3 gives
`listUsers` real cursor pagination on the core side (all 9 call sites, since
`tsc --noEmit` fails otherwise). Task 4 builds the `/admin/feeds` web UI
(search box, orphan group, reap forms, `addedBy` display). Task 5 wires the
web `/admin/users` page to Task 3's new pagination. Order 1 → 2 → 3 → 4 → 5;
4 depends on 1+2, 5 depends on 3 — do not run 4 before 1+2 or 5 before 3.

**Tech Stack:** Node 22 native type-stripping (no build step — `tsc --noEmit`
is the real compile gate, vitest passes on type errors), better-sqlite3,
Hono, SvelteKit 5 (web), vitest.

## Global Constraints

- **Sequencing with `docs/superpowers/plans/2026-07-25-instance-governed-members.md`.** That plan should land FIRST, in full (all 6 tasks) — it's the more foundational layer (defines the `overridden`/membership model) and is already through two review passes. Once it has landed, its Task 5 will have added `listSourceMembers()` to `SqliteRepository`, which builds its own `SourceSummary` object literals independently of this plan's Task 1. Task 1 Step 4 below includes a step to find and patch that method too — don't skip it just because it isn't mentioned elsewhere in this plan. If instance-governed-members has NOT landed yet when this plan executes, skip that step (there's nothing to patch) but re-check for it before merging this plan's Task 1, since a `tsc --noEmit` clean run at patch-time is not proof no such method exists on a later `main`.
- **Container-only test commands.** `docker compose exec -T core npm run -w core test -- <files>` / `docker compose exec -T core npm run -w core typecheck` for core. `docker compose exec -T web env -u CORE_API_URL npm test -w web -- <files>` / `docker compose exec -T web npm run -w web check` for web. Never bare `vitest`/`npx vitest` — the container's default CWD is `/app` (repo root), which silently drops web's `$lib`/`$env` aliases and produces a misleading "Cannot find module" error (a documented gotcha, `docs/superpowers/documentation/TESTING.md`).
- **Baseline (re-verify before Task 1):** core suite green, `tsc --noEmit` 0 errors; web suite green, `svelte-check` 0/0. This plan was written against a specific point in time — re-verify counts fresh.
- **Never `git add -A`** — shared checkout; a parallel session may commit to `main` concurrently. Stage explicit paths.
- **Every task ends with its own workspace's suite green and typecheck clean** (core tasks: core suite + `tsc`; web tasks: web suite + `svelte-check`).
- **Orphan definition (spec, pinned):** a source is an orphan iff `governance='allowed'` AND no federation relationship AND zero `source_subscriptions_v2` rows of ANY state (`active`, `pending`, `pending_review`) — matches `reapSourceIfOrphaned`'s own predicate verbatim. A `pending_review`-only source is NOT an orphan.
- **`addedBy` is a plain per-row lookup, not a batched query** — matches the existing accepted `pushFor` pattern (`sqlite.ts:508-518`, one small indexed lookup per listed row, ≤50-row pages). No query-count/no-N+1 test.
- **Full scope ships together** — the orphan group + reap command are not deferred, per the spec rev 2's explicit maintainer decision. The ~46-of-~49-row overlap with `instance-governed-members` (unimplemented) is accepted as a known, revisit-later situation, not something this plan works around.
- **Component 3 of the spec (the auto-reap leak fix) needs NO task here** — already shipped as commit `d4bea7d`, verified against current `local.ts` with existing test coverage in `housekeeping.test.ts`.

---

### Task 1: `SourceSummary` gains `q` search, `filter=orphan`, `retention`, `addedBy`

**Files:**
- Modify: `core/src/domain/types.ts`, `core/src/domain/source-repository.ts`, `core/src/storage/sqlite.ts`, `core/src/api/app.ts`
- Test: `core/test/source-reads.test.ts`

**Interfaces:**
- Consumes: nothing from another task.
- Produces: `SourceSummary` gains `retention: 'verified_origin' | 'audit_history' | 'admin_retained' | 'reapable' | null` and `addedBy: { handle: string; displayName: string }[]`. `listSourceSummaries(cursor, limit, filter?, q?)` — `filter?: 'governance' | 'orphan'`, `q?: string`. Route `GET /admin/sources` accepts `?q=` and `?filter=orphan` alongside the existing `?filter=governance`. Task 4 (web) consumes these new fields/params directly.

- [ ] **Step 1: Confirm the baseline**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Record the exact test count and confirm 0 tsc errors.

- [ ] **Step 2: Read `core/src/storage/sqlite.ts`'s `listSourceSummaries` fresh (currently ~lines 448-470), confirm it still reads as follows before editing**

```typescript
async listSourceSummaries(cursor: Cursor | undefined, limit: number, filter?: 'governance'): Promise<Page<SourceSummary>> {
  const lim = clampLimit(limit)
  const where = filter === 'governance'
    ? `(EXISTS(SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = remote_sources_v2.id) OR governance = 'quarantined')`
    : '1=1'
  const rows = (cursor
    ? this.raw.prepare(
        `SELECT * FROM remote_sources_v2 WHERE ${where} AND ((created_at < ?) OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
    : this.raw.prepare(`SELECT * FROM remote_sources_v2 WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(lim + 1)
  ) as RemoteSourceV2Row[]
  const { page, nextCursor } = this.splitPage(rows, lim)
  const items: SourceSummary[] = page.map((r) => {
    const source = rowToRemoteSourceV2(r)
    return { source, federationStatus: this.federationStatusFor(source.id), subscriptionCounts: this.subscriptionCountsFor(source.id), push: this.pushFor(source.id).push }
  })
  return { items, nextCursor }
}
```

If this has drifted, stop and re-read the surrounding class before editing — the edit below assumes this exact text.

- [ ] **Step 3: Replace it — widen the `where` clause for `q`/`orphan`, add `retention`/`addedBy` to the per-row map**

The orphan predicate (spec, pinned): `governance='allowed' AND no federation relationship AND zero source_subscriptions_v2 rows of any state`. Note this is a NARROWER predicate than `filter='governance'`'s (which is about federation/quarantine, not subscription count) — the two filters are mutually exclusive query shapes, not composable in this step.

```typescript
async listSourceSummaries(cursor: Cursor | undefined, limit: number, filter?: 'governance' | 'orphan', q?: string): Promise<Page<SourceSummary>> {
  const lim = clampLimit(limit)
  const where = filter === 'governance'
    ? `(EXISTS(SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = remote_sources_v2.id) OR governance = 'quarantined')`
    : filter === 'orphan'
      ? `(governance = 'allowed'
          AND NOT EXISTS(SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = remote_sources_v2.id)
          AND NOT EXISTS(SELECT 1 FROM source_subscriptions_v2 s WHERE s.source_id = remote_sources_v2.id))`
      : '1=1'
  const qClause = q ? ` AND canonical_url LIKE '%'||?||'%'` : ''
  const qParams = q ? [q] : []
  const rows = (cursor
    ? this.raw.prepare(
        `SELECT * FROM remote_sources_v2 WHERE ${where}${qClause} AND ((created_at < ?) OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(...qParams, cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
    : this.raw.prepare(`SELECT * FROM remote_sources_v2 WHERE ${where}${qClause} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...qParams, lim + 1)
  ) as RemoteSourceV2Row[]
  const { page, nextCursor } = this.splitPage(rows, lim)
  const items: SourceSummary[] = page.map((r) => {
    const source = rowToRemoteSourceV2(r)
    const isOrphan = filter === 'orphan'
    return {
      source,
      federationStatus: this.federationStatusFor(source.id),
      subscriptionCounts: this.subscriptionCountsFor(source.id),
      push: this.pushFor(source.id).push,
      retention: isOrphan ? this.retentionFor(source.id) : null,
      addedBy: this.addedByFor(source.id),
    }
  })
  return { items, nextCursor }
}
```

Placeholder bind order matters: SQLite `?` placeholders bind positionally, and `qParams` must come BEFORE the cursor params in the `.all(...)` call because `qClause` is spliced into the SQL string textually before the cursor `AND` clause.

- [ ] **Step 4: Add the two new private helper methods**

Read `pushFor` (currently `sqlite.ts:508-518`) immediately above/below this insertion point first, to match its exact style (private method, one indexed lookup, `ponytail:`-commented if it cuts the same corner). Add:

```typescript
// The retention ladder (spec, mirrors every reapSourceIfOrphaned guard in
// order): non-null only for orphans. admin_retained must be checked before
// source_audit_v2 or an admin-retained orphan is mislabeled reapable.
private retentionFor(sourceId: string): 'verified_origin' | 'audit_history' | 'admin_retained' | 'reapable' {
  if (this.raw.prepare(`SELECT 1 FROM publisher_claims_v2 WHERE source_id = ? AND evidence_level = 'verified_origin' LIMIT 1`).get(sourceId)) return 'verified_origin'
  const source = this.raw.prepare(`SELECT admin_retained FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { admin_retained: 0 | 1 } | undefined
  if (source?.admin_retained === 1) return 'admin_retained'
  if (this.raw.prepare(`SELECT 1 FROM source_audit_v2 WHERE source_id = ? LIMIT 1`).get(sourceId)) return 'audit_history'
  return 'reapable'
}

// ponytail: one small indexed lookup per listed source (the page is clamped
// to ≤50, matching pushFor's own accepted shape); fold into the list query
// only if a page read ever shows up in a profile.
private addedByFor(sourceId: string): { handle: string; displayName: string }[] {
  const rows = this.raw.prepare(
    `SELECT u.handle AS handle, u.display_name AS displayName
     FROM source_subscriptions_v2 s JOIN users u ON u.id = s.owner_id
     WHERE s.source_id = ? ORDER BY s.created_at ASC LIMIT 3`,
  ).all(sourceId) as { handle: string; displayName: string }[]
  return rows
}
```

Verify the exact column names on `users` (`handle`, `display_name`) and `source_subscriptions_v2` (`owner_id`, `source_id`, `created_at`) against the live schema before finalizing — `listUsers` (same file, ~line 400-409) and `unsubscribe` (same file) both already query these exact columns, cross-check against those.

- [ ] **Step 5: Update `SourceSummary` in `core/src/domain/types.ts`**

Read the interface fresh (currently ~line 156-163) and add the two fields:

```typescript
export interface SourceSummary {
  source: RemoteSource
  federationStatus: 'none' | FederationStatus
  subscriptionCounts: { active: number; pending: number; pendingReview: number }
  push: PushSummary
  retention: 'verified_origin' | 'audit_history' | 'admin_retained' | 'reapable' | null
  addedBy: { handle: string; displayName: string }[]
}
```

`SourceDetail extends SourceSummary` (same file, immediately below) inherits both fields automatically — no separate edit needed there, but re-verify it doesn't redeclare them.

- [ ] **Step 6: Update the interface declaration in `core/src/domain/source-repository.ts`**

Change (currently ~line 97):
```typescript
listSourceSummaries(cursor: Cursor | undefined, limit: number, filter?: 'governance'): Promise<Page<SourceSummary>>
```
to:
```typescript
listSourceSummaries(cursor: Cursor | undefined, limit: number, filter?: 'governance' | 'orphan', q?: string): Promise<Page<SourceSummary>>
```

- [ ] **Step 7: Update the route in `core/src/api/app.ts`**

Read the current route fresh (currently ~lines 294-300):
```typescript
app.get('/admin/sources', async (c) => {
  const args = pageArgs(c)
  if (args instanceof Response) return args
  const filter = c.req.query('filter')
  if (filter !== undefined && filter !== 'governance') return c.json({ error: 'filter invalid' }, 400)
  return c.json(await v2repo.listSourceSummaries(args.cursor, args.limit, filter))
})
```
Replace with:
```typescript
app.get('/admin/sources', async (c) => {
  const args = pageArgs(c)
  if (args instanceof Response) return args
  const filter = c.req.query('filter')
  if (filter !== undefined && filter !== 'governance' && filter !== 'orphan') return c.json({ error: 'filter invalid' }, 400)
  const q = c.req.query('q')
  if (q !== undefined && q.length > 256) return c.json({ error: 'q invalid' }, 400)
  return c.json(await v2repo.listSourceSummaries(args.cursor, args.limit, filter as 'governance' | 'orphan' | undefined, q))
})
```

- [ ] **Step 8: Typecheck, and patch any other `SourceSummary`-building site**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors. If this fails on a method other than `listSourceSummaries` (most likely `listSourceMembers`, added by the instance-governed-members plan's Task 5 if it has landed) with a "missing properties `retention`, `addedBy`" error, that method builds a `SourceSummary` literal of its own — patch it the same way, calling the same two helpers: `retention: this.retentionFor(source.id)` (this helper computes a real answer for any source, not only orphans — safe to call unconditionally, unlike Step 3's guarded `isOrphan ? ... : null` which is specific to `listSourceSummaries`'s own orphan-vs-ordinary distinction) and `addedBy: this.addedByFor(source.id)`. Don't guess the exact call site — `grep -n "SourceSummary\[\]\|: SourceSummary =" core/src/storage/sqlite.ts` and fix every hit tsc flags.

- [ ] **Step 9: Fix the frozen-shape test in `core/test/source-reads.test.ts`**

The existing test `'listSourceSummaries paginates stably across equal timestamps and SourceSummary carries only the four DTO keys'` (currently ~line 35) asserts:
```typescript
expect(Object.keys(first.items[0]).sort()).toEqual(['federationStatus', 'push', 'source', 'subscriptionCounts'])
```
This is now wrong on purpose — update to:
```typescript
expect(Object.keys(first.items[0]).sort()).toEqual(['addedBy', 'federationStatus', 'push', 'retention', 'source', 'subscriptionCounts'])
```
and rename the test to drop "carries only the four DTO keys" (now six). Also add `expect(first.items[0].retention).toBeNull()` and `expect(first.items[0].addedBy).toEqual([])` (a non-orphan `filter=undefined` list should have null retention and empty addedBy for a source with no subscriptions in this fixture — verify against what `insertSource`'s fixture actually seeds first).

- [ ] **Step 10: Add new tests to `core/test/source-reads.test.ts`**

Read the file's existing `insertSource`/`insertSubscription`/`insertAudit` helpers (already in the file, ~lines 14-33) and use them. Add:

```typescript
test('q searches canonical_url; filter=orphan returns only zero-subscription allowed non-federated sources', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const orphanId = randomUUID()
  const subscribedId = randomUUID()
  insertSource(raw, orphanId)
  insertSource(raw, subscribedId)
  insertSubscription(raw, randomUUID(), 'owner-1', subscribedId, 'active')

  const orphans = await repo.listSourceSummaries(undefined, 50, 'orphan')
  expect(orphans.items.map((i) => i.source.id)).toEqual([orphanId])
  expect(orphans.items[0].retention).toBe('reapable')

  const searched = await repo.listSourceSummaries(undefined, 50, undefined, orphanId)
  expect(searched.items.map((i) => i.source.id)).toEqual([orphanId])
  const noMatch = await repo.listSourceSummaries(undefined, 50, undefined, 'no-such-substring-xyz')
  expect(noMatch.items).toEqual([])
  repo.close()
})

test('a pending_review-only source is NOT an orphan (C1 regression)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const sourceId = randomUUID()
  insertSource(raw, sourceId)
  insertSubscription(raw, randomUUID(), 'owner-1', sourceId, 'pending_review')
  const orphans = await repo.listSourceSummaries(undefined, 50, 'orphan')
  expect(orphans.items.map((i) => i.source.id)).not.toContain(sourceId)
  repo.close()
})

test('retention ladder: verified_origin beats admin_retained beats audit_history beats reapable', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const reapableId = randomUUID()
  const auditedId = randomUUID()
  const retainedId = randomUUID()
  const verifiedId = randomUUID()
  insertSource(raw, reapableId)
  insertSource(raw, auditedId)
  insertSource(raw, retainedId)
  insertSource(raw, verifiedId)
  insertAudit(raw, randomUUID(), auditedId, T)
  raw.prepare(`UPDATE remote_sources_v2 SET admin_retained = 1 WHERE id = ?`).run(retainedId)
  raw.prepare(
    `INSERT INTO publisher_claims_v2 (id, logical_item_id, publisher_id, source_id, observation_version_id, evidence_level, first_seen_at)
     VALUES (?, NULL, NULL, ?, NULL, 'verified_origin', ?)`,
  ).run(randomUUID(), verifiedId, T)
  const orphans = await repo.listSourceSummaries(undefined, 50, 'orphan')
  const byId = new Map(orphans.items.map((i) => [i.source.id, i.retention]))
  expect(byId.get(reapableId)).toBe('reapable')
  expect(byId.get(auditedId)).toBe('audit_history')
  expect(byId.get(retainedId)).toBe('admin_retained')
  expect(byId.get(verifiedId)).toBe('verified_origin')
  repo.close()
})

test('addedBy resolves the first 3 subscriber handles in created_at order, empty for orphans', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const sourceId = randomUUID()
  insertSource(raw, sourceId)
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, created_at) VALUES ('u1', 'local', 'alice', 'Alice', ?)`).run(T)
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, created_at) VALUES ('u2', 'local', 'bob', 'Bob', ?)`).run(T)
  insertSubscription(raw, randomUUID(), 'u1', sourceId, 'active')
  insertSubscription(raw, randomUUID(), 'u2', sourceId, 'active')
  const page = await repo.listSourceSummaries(undefined, 50)
  const row = page.items.find((i) => i.source.id === sourceId)!
  expect(row.addedBy.map((a) => a.handle)).toEqual(['alice', 'bob'])
  repo.close()
})
```

Verify the `users` table's exact `INSERT` column list (`id, kind, handle, display_name, created_at` — plus any other `NOT NULL` columns) against the live schema before running — the snippet mirrors `listUsers`'s own read shape, not a guess, but re-check the write side (`CREATE TABLE users` in `core/src/logical/schema.ts` or wherever the base v1 schema lives) since this test inserts directly.

- [ ] **Step 11: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 0 tsc errors, all tests pass, test count up by 4 from Step 1's baseline (the frozen-shape test is modified in place, not counted as new).

- [ ] **Step 12: Commit**

```bash
git add core/src/domain/types.ts core/src/domain/source-repository.ts core/src/storage/sqlite.ts core/src/api/app.ts core/test/source-reads.test.ts
git commit -m "core: source summaries gain q search, filter=orphan, retention, addedBy

listSourceSummaries extends its existing cursor-paginated read with a URL
search (q, bound LIKE param) and a new filter=orphan (governance=allowed,
no federation, zero subscriptions of any state -- matches
reapSourceIfOrphaned's own predicate verbatim, so a pending_review-only
source is correctly never an orphan). SourceSummary gains retention (the
reap-guard ladder, non-null only for orphans) and addedBy (first 3
subscriber handles) -- addedBy is a plain per-row indexed lookup matching
the existing accepted pushFor pattern, not a batched join.

developed with the help of AI tools"
```

---

### Task 2: Operator reap command

**Files:**
- Modify: `core/src/domain/source-repository.ts`, `core/src/storage/sqlite.ts`, `core/src/api/app.ts`
- Test: `core/test/source-cleanup.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly (independent data path), but Task 4 (web) wires both together in one UI.
- Produces: `POST /admin/sources/:id/reap` (body `{ commandId, force? }`), repository method `reapSource(tx, id, { force })` replacing `reapSourceIfOrphaned`'s body (kept as a thin `{force: false}` wrapper for the existing auto-reap callers, so their behavior is byte-for-byte unchanged).

- [ ] **Step 1: Confirm Task 1 landed**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`

- [ ] **Step 2: Read `core/src/domain/source-repository.ts`'s `reapSourceIfOrphaned` fresh (currently ~lines 226-245), confirm it still reads as follows**

```typescript
export function reapSourceIfOrphaned(tx: Db, sourceId: string, now: string = new Date().toISOString()): boolean {
  const { n } = tx.prepare(`SELECT COUNT(*) AS n FROM source_subscriptions_v2 WHERE source_id = ?`).get(sourceId) as { n: number }
  if (n > 0) return false
  const source = tx.prepare(`SELECT governance, admin_retained FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { governance: SourceGovernance; admin_retained: 0 | 1 } | undefined
  if (!source || source.governance !== 'allowed' || source.admin_retained !== 0) return false
  if (tx.prepare(`SELECT 1 FROM federation_relationships_v2 WHERE source_id = ?`).get(sourceId)) return false
  if (tx.prepare(`SELECT 1 FROM source_audit_v2 WHERE source_id = ? LIMIT 1`).get(sourceId)) return false
  if (tx.prepare(`SELECT 1 FROM publisher_claims_v2 WHERE source_id = ? AND evidence_level = 'verified_origin' LIMIT 1`).get(sourceId)) return false
  const { ordinaryAffected } = removeSourceEvidence(tx, { sourceId, now })
  if (ordinaryAffected) appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, now)
  return true
}
```

If drifted, stop and re-read before editing.

- [ ] **Step 3: Replace with `reapSource(tx, sourceId, { force }, now)` + the thin auto-reap wrapper**

```typescript
export type ReapResult = { kind: 'reaped' } | { kind: 'refused'; reason: 'has_subscribers' | 'not_allowed' | 'federated' | 'verified_origin_evidence' }
// The command-layer outcome adds the two idempotency-ledger cases (source
// not found, replayed command fingerprint mismatch) that only apply once
// reapSource is wrapped behind checkCommand/storeCommand in sqlite.ts —
// reapSource itself (the raw guard chain below) only ever returns ReapResult.
export type ReapCommandResult = ReapResult | { kind: 'unknown' } | { kind: 'conflict' }

// The full operator-reap command (Task 8, spec Component 2): every guard
// reapSourceIfOrphaned always enforced, PLUS an operator override for the two
// guards auto-reap has no way to bypass (source_audit_v2 row, admin_retained).
// governance/subscription/federation/verified-origin-evidence stay
// always-enforced regardless of force -- force only lifts the audit/
// admin_retained holds, and even verified-origin evidence requires force
// explicitly (never silently).
export function reapSource(tx: Db, sourceId: string, opts: { force: boolean }, now: string = new Date().toISOString()): ReapResult {
  const { n } = tx.prepare(`SELECT COUNT(*) AS n FROM source_subscriptions_v2 WHERE source_id = ?`).get(sourceId) as { n: number }
  if (n > 0) return { kind: 'refused', reason: 'has_subscribers' }
  const source = tx.prepare(`SELECT governance FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { governance: SourceGovernance } | undefined
  if (!source || source.governance !== 'allowed') return { kind: 'refused', reason: 'not_allowed' }
  if (tx.prepare(`SELECT 1 FROM federation_relationships_v2 WHERE source_id = ?`).get(sourceId)) return { kind: 'refused', reason: 'federated' }
  const hasVerifiedOrigin = tx.prepare(`SELECT 1 FROM publisher_claims_v2 WHERE source_id = ? AND evidence_level = 'verified_origin' LIMIT 1`).get(sourceId)
  if (hasVerifiedOrigin && !opts.force) return { kind: 'refused', reason: 'verified_origin_evidence' }
  // admin_retained and source_audit_v2 are the two guards force overrides;
  // NOT checked at all here (auto-reap's version checks both and refuses).
  const { ordinaryAffected } = removeSourceEvidence(tx, { sourceId, now })
  if (ordinaryAffected) appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, now)
  return { kind: 'reaped' }
}

// Auto-reap (unsubscribe, account deletion): every guard enforced, force
// never available. Byte-for-byte the same refusals reapSourceIfOrphaned
// always had -- admin_retained and source_audit_v2 still block it here,
// since force is hardcoded false.
export function reapSourceIfOrphaned(tx: Db, sourceId: string, now: string = new Date().toISOString()): boolean {
  const source = tx.prepare(`SELECT admin_retained FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { admin_retained: 0 | 1 } | undefined
  if (source?.admin_retained !== 0) return false
  if (tx.prepare(`SELECT 1 FROM source_audit_v2 WHERE source_id = ? LIMIT 1`).get(sourceId)) return false
  return reapSource(tx, sourceId, { force: false }, now).kind === 'reaped'
}
```

**Read this carefully before implementing:** `reapSourceIfOrphaned` must still refuse on `admin_retained`/`source_audit_v2` — those checks moved OUT of the shared `reapSource` (since force needs to skip them) and INTO this wrapper, run BEFORE calling `reapSource`. Verify with the existing `core/test/source-cleanup.test.ts`/`core/test/housekeeping.test.ts` tests for `reapSourceIfOrphaned` (Step 8) that behavior is truly unchanged — this is the highest-risk step in this task, since a mistake here regresses already-shipped, already-tested auto-reap behavior.

- [ ] **Step 4: Add `reapSource` to the `SourceRepository` interface** (same file, near `listSourceSummaries` in the interface block, ~line 97)

```typescript
reapSource(input: { command: CommandEnvelope; sourceId: string; force: boolean; now: string }): Promise<ReapCommandResult>
```
Import `ReapCommandResult` from `./source-repository.ts` (it's defined and exported there, alongside `ReapResult`, in Task 2 Step 3).

- [ ] **Step 5: Add the wrapping method in `core/src/storage/sqlite.ts`**

Read `unsubscribe`'s existing `BEGIN IMMEDIATE` + `checkCommand`/`storeCommand` wrapping (same file, ~line 806-827, per Task 1's Step 4 neighborhood) as the exact pattern to mirror:

```typescript
async reapSource(input: { command: CommandEnvelope; sourceId: string; force: boolean; now: string }): Promise<ReapCommandResult> {
  const raw = this.raw
  return raw.transaction(() => {
    const check = checkCommand<ReapCommandResult>(raw, input.command)
    if (check.kind === 'replay') return check.result
    if (check.kind === 'conflict') return { kind: 'conflict' as const }
    if (!raw.prepare(`SELECT 1 FROM remote_sources_v2 WHERE id = ?`).get(input.sourceId)) {
      const result = { kind: 'unknown' as const }
      storeCommand(raw, input.command, result, input.now)
      return result
    }
    const outcome = reapSourceFn(raw, input.sourceId, { force: input.force }, input.now)
    storeCommand(raw, input.command, outcome, input.now)
    return outcome
  }).immediate()
}
```

Import `reapSource` (aliased `reapSourceFn` to avoid shadowing this method's own name) alongside the existing `reapSourceIfOrphaned` import at the top of this file (currently `sqlite.ts:10`), and import the `ReapCommandResult` type from the same module.

- [ ] **Step 6: Add the route in `core/src/api/app.ts`**

Register BEFORE `app.post('/admin/sources/:id/:action', ...)` (currently ~line 364) — Hono matches routes in registration order, and the existing precedent (`mountLogicalRoutes` at ~line 203, registering `/refresh`/`/purge` before this same `:action` catch-all) is exactly why this must go before it too, or `:action='reap'` gets swallowed as an invalid transition. Read the current file around line 318-364 fresh to find the exact insertion point (right after the existing `/admin/sources/:id/audit` GET route, before the `establishFederation`/`:action` block, is the natural spot — but re-verify against the live file, not this line estimate).

```typescript
app.post('/admin/sources/:id/reap', jsonWrite, async (c) => {
  const id = c.req.param('id') ?? ''
  const body = await readJsonBody(c)
  if (!body) return c.json({ error: 'body invalid' }, 400)
  const { commandId, force } = body
  if (!isString(commandId, 1, 200)) return c.json({ error: 'commandId invalid' }, 400)
  if (force !== undefined && typeof force !== 'boolean') return c.json({ error: 'force invalid' }, 400)
  const actorId = c.get('coreUser').id
  const command: CommandEnvelope = { actorScope: 'administrator', actorId, commandId, requestFingerprint: fingerprintRequest(['reap', id]) }
  const result = await v2repo.reapSource({ command, sourceId: id, force: force === true, now: new Date().toISOString() })
  if (result.kind === 'reaped') return c.json(result, 200)
  if (result.kind === 'unknown') return c.json({ error: 'unknown source' }, 404)
  if (result.kind === 'conflict') return c.json(IDEMPOTENCY_CONFLICT, 409)
  return c.json({ error: result.reason }, 409)
})
```

Verify `isString`, `readJsonBody`, `jsonWrite`, `fingerprintRequest`, `CommandEnvelope`, `IDEMPOTENCY_CONFLICT` are already imported/in-scope in this file (they're used by neighboring routes — `establishFederation` a few lines below uses several of these already) before assuming the snippet compiles as-is.

- [ ] **Step 7: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors.

- [ ] **Step 8: Confirm existing `reapSourceIfOrphaned` tests still pass unchanged**

Run: `docker compose exec -T core npm run -w core test -- source-cleanup.test.ts housekeeping.test.ts logical-journal-effects.test.ts`
Expected: all pass, same count as before this task — Step 3's refactor must be BEHAVIOR-PRESERVING for every existing caller. If anything fails, the refactor broke byte-for-byte compatibility; fix before proceeding, don't adjust the existing tests to match new behavior.

- [ ] **Step 9: Write new tests for `reapSource` in `core/test/source-cleanup.test.ts`**

Read the file's existing helpers (likely shares `insertSource`-style fixtures with `source-reads.test.ts`, or has its own — check first) and add tests for: refuse on non-allowed governance; refuse on any-state subscription; refuse on federation; refuse on verified-origin evidence without force, succeed with force (asserting the consequence — evidence actually removed); force overrides audit history AND admin_retained; idempotent replay (same commandId+fingerprint returns the stored result, no second effect); a force-retry with a NEW commandId (not the same one that got refused) succeeds; unknown source → `{kind:'unknown'}`, ledgered (a retry with the same id after ALSO 404s, not silently differs).

- [ ] **Step 10: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 0 tsc errors, all tests pass.

- [ ] **Step 11: Commit**

```bash
git add core/src/domain/source-repository.ts core/src/storage/sqlite.ts core/src/api/app.ts core/test/source-cleanup.test.ts
git commit -m "core: operator reap command (POST /admin/sources/:id/reap)

reapSource(tx, sourceId, {force}) generalizes reapSourceIfOrphaned:
governance/subscription/federation/verified-origin-evidence stay
always-enforced (force does not lift them, except verified-origin evidence
which force explicitly can), while admin_retained and source_audit_v2 --
the two guards auto-reap has no way past -- move out of the shared function
into reapSourceIfOrphaned's own wrapper, unchanged for every existing
caller. The new route is registered before the :action catch-all, mirroring
the existing /refresh and /purge precedent, so reap isn't swallowed as an
invalid transition.

developed with the help of AI tools"
```

---

### Task 3: `listUsers` cursor pagination (core, all 9 call sites)

**Files:**
- Modify: `core/src/domain/repository.ts`, `core/src/storage/sqlite.ts`, `core/src/domain/service.ts`, `core/src/api/app.ts`
- Test: `core/test/admin-users.test.ts`, `core/test/source-capability-api.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `listUsers(cursor?: Cursor, limit?: number): Page<...>` (repository, service, and the `/admin/users` route all take the new signature). **Task 5 (web) depends on this landing first** — the web client/page break at the HTTP layer until Task 5 also lands, since the response shape changes from `{ users }` to `{ items, nextCursor }`. Not a problem within one SDD session, but do not consider this feature deployable until Task 5 also lands.

- [ ] **Step 1: Confirm Task 2 landed**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`

- [ ] **Step 2: Re-run the mechanical sweep to confirm the call-site count**

```bash
grep -rn "listUsers\b" core/src core/test web/src --include='*.ts' --include='*.svelte'
```
Expected: the 9 sites named below (repository.ts interface, sqlite.ts impl, service.ts wrapper, app.ts route, 2 web files, 3 test files — web's 2 are Task 5's territory, not touched in this task, but confirm they show up in this grep so Task 5 knows exactly what it's touching). If a 10th core-side site appears, stop and re-scope.

- [ ] **Step 3: Read `core/src/storage/sqlite.ts`'s `listUsers` fresh (currently ~lines 400-410), confirm it still reads as follows**

```typescript
listUsers(): Array<{ handle: string; displayName: string; kind: 'local' | 'remote'; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }> {
  const rows = this.raw.prepare(
    `SELECT u.handle AS handle, u.display_name AS displayName, u.kind AS kind,
            u.created_at AS createdAt, u.feed_url AS feedUrl, au.emailVerified AS emailVerified
     FROM users u LEFT JOIN user au ON au.id = u.auth_user_id
     WHERE u.kind = 'remote'
        OR (u.kind = 'local' AND (au.isAnonymous = 0 OR au.isAnonymous IS NULL))
     ORDER BY u.created_at DESC`,
  ).all() as Array<{ handle: string; displayName: string; kind: 'local' | 'remote'; createdAt: string; feedUrl: string | null; emailVerified: number | null }>
  return rows.map((r) => ({ ...r, emailVerified: r.emailVerified === null ? null : r.emailVerified === 1 }))
}
```

- [ ] **Step 4: Replace with a cursor-paginated version, reusing `splitPage`/`clampLimit`/`encodeCursor`/`decodeCursor` from `source-repository.ts`**

`splitPage`'s generic constraint requires `{ created_at: string; id: string }` on each row — this query needs `u.id AS id` added to the SELECT for that to typecheck; the `Page<T>` return needs a distinct row shape (no existing `User`-flavored `Page<T>` in this file — model it on `listSourceSummaries`'s exact shape).

```typescript
listUsers(cursor: Cursor | undefined, limit: number): Page<{ id: string; handle: string; displayName: string; kind: 'local' | 'remote'; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }> {
  const lim = clampLimit(limit)
  const where = `(u.kind = 'remote' OR (u.kind = 'local' AND (au.isAnonymous = 0 OR au.isAnonymous IS NULL)))`
  const rows = (cursor
    ? this.raw.prepare(
        `SELECT u.id AS id, u.handle AS handle, u.display_name AS displayName, u.kind AS kind,
                u.created_at AS createdAt, u.feed_url AS feedUrl, au.emailVerified AS emailVerified
         FROM users u LEFT JOIN user au ON au.id = u.auth_user_id
         WHERE ${where} AND ((u.created_at < ?) OR (u.created_at = ? AND u.id < ?))
         ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
      ).all(cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
    : this.raw.prepare(
        `SELECT u.id AS id, u.handle AS handle, u.display_name AS displayName, u.kind AS kind,
                u.created_at AS createdAt, u.feed_url AS feedUrl, au.emailVerified AS emailVerified
         FROM users u LEFT JOIN user au ON au.id = u.auth_user_id
         WHERE ${where}
         ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
      ).all(lim + 1)
  ) as Array<{ id: string; created_at: string; handle: string; displayName: string; kind: 'local' | 'remote'; createdAt: string; feedUrl: string | null; emailVerified: number | null }>
  const { page, nextCursor } = this.splitPage(rows.map((r) => ({ ...r, created_at: r.createdAt })), lim)
  return { items: page.map((r) => ({ ...r, emailVerified: r.emailVerified === null ? null : r.emailVerified === 1 })), nextCursor }
}
```

**Note the `created_at` duplication** (`splitPage`'s generic wants a `created_at` field, the row's own alias is `createdAt`) — the `.map((r) => ({...r, created_at: r.createdAt}))` bridges this; verify this is actually necessary by reading `splitPage`'s exact generic constraint (`sqlite.ts:419`) before assuming — there may be a cleaner way already established elsewhere in this file (e.g. selecting `created_at AS created_at, created_at AS createdAt` twice in SQL instead). Use whichever pattern the file's OTHER paginated methods (`listSourceSubscriptions`, `listSourceAudit`) actually use — read one of them fresh first.

- [ ] **Step 5: Update the interface in `core/src/domain/repository.ts`**

Change (find the exact current line — it's the `Repository` interface, not `SourceRepository`):
```typescript
listUsers(): Array<{ handle: string; displayName: string; kind: 'local' | 'remote'; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }>
```
to:
```typescript
listUsers(cursor: Cursor | undefined, limit: number): Page<{ id: string; handle: string; displayName: string; kind: 'local' | 'remote'; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }>
```
Import `Cursor` from `./source-repository.ts` and `Page` from `./types.ts` if not already imported in this file — check first.

- [ ] **Step 6: Update the service wrapper in `core/src/domain/service.ts`**

Change (currently ~line 122):
```typescript
listUsers() { return repo.listUsers() },
```
to:
```typescript
listUsers(cursor: Cursor | undefined, limit: number) { return repo.listUsers(cursor, limit) },
```

- [ ] **Step 7: Update the route in `core/src/api/app.ts`**

Change (currently ~line 419):
```typescript
app.get('/admin/users', (c) => c.json({ users: service.listUsers() }))
```
to:
```typescript
app.get('/admin/users', (c) => {
  const args = pageArgs(c)
  if (args instanceof Response) return args
  return c.json(service.listUsers(args.cursor, args.limit))
})
```
`pageArgs` is already defined in this file (`app.ts:58`, used by `/admin/sources` and others) — reuse it, don't redefine.

- [ ] **Step 8: Typecheck**

Run: `docker compose exec -T core npm run -w core typecheck`
Expected: 0 errors. This is the real gate for "did I actually find and fix all core-side call sites" — any compile error here is a missed site.

- [ ] **Step 9: Fix the two incidental test call sites**

`core/test/admin-users.test.ts:33` (`const users = repo.listUsers()`) and `core/test/source-capability-api.test.ts:93` (`repo.listUsers().filter(...)`) both call the old zero-arg signature. Read each in context — the first needs updating to pass `(undefined, 100)` (or whatever the test's own intent needs) and read `.items` instead of the bare array; the second is testing something unrelated (feed URL filtering) and just needs its call site updated to compile, not its assertions rewritten.

- [ ] **Step 10: Run the full core suite**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`
Expected: 0 tsc errors, all tests pass (no test-count change — existing tests updated, not added/removed, unless Step 9's fix naturally wants a new pagination-specific test, in which case add one: `listUsers` with `limit=1` returns exactly 1 item + a `nextCursor`, and paginating through returns all users with no dupes/gaps).

- [ ] **Step 11: Commit**

```bash
git add core/src/domain/repository.ts core/src/storage/sqlite.ts core/src/domain/service.ts core/src/api/app.ts core/test/admin-users.test.ts core/test/source-capability-api.test.ts
git commit -m "core: listUsers gets real cursor pagination

listUsers(cursor, limit) replaces the zero-arg, unpaginated version --
adds id to the SELECT and (created_at DESC, id DESC) ordering (the existing
created_at-only order had no tiebreak), reusing the same splitPage/
clampLimit/Cursor codec every other v2 admin listing already uses. All 9
real call sites (repository interface, sqlite impl, service wrapper, the
route, 2 web files -- Task 5's territory, 3 test files) needed to move
together for tsc to pass; this task covers the 7 core-side ones.

developed with the help of AI tools"
```

---

### Task 4: Web — `/admin/feeds` UI (search, orphan group, reap forms, addedBy)

**Files:**
- Modify: `web/src/routes/admin/feeds/+page.server.ts`, `web/src/routes/admin/feeds/+page.svelte`
- Test: `web/src/routes/admin/feeds/source-actions.test.ts`

**Interfaces:**
- Consumes: Task 1's `q`/`filter=orphan`/`retention`/`addedBy` on `GET /admin/sources`, Task 2's `POST /admin/sources/:id/reap`.
- Produces: no new exports consumed elsewhere.

**This task MUST invoke the `ui-ux-pro-max` skill first** (per this repo's CLAUDE.md: any task touching UI pages/components/layout must), and follow `design-system/rsc/MASTER.md` for styling. This plan describes data flow and behavior, not markup/CSS — the UI skill governs the latter.

- [ ] **Step 1: Confirm Task 3 landed**

Run: `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck`

- [ ] **Step 2: Invoke `ui-ux-pro-max` before writing any markup**

Read `design-system/rsc/MASTER.md` and any `design-system/rsc/pages/admin*.md` override for this page's existing conventions (spacing, color tokens, form styling) before adding new markup — match what's already there.

- [ ] **Step 3: Read `web/src/routes/admin/feeds/+page.server.ts` fresh in full**

It's ~220 lines; read the whole file (already partially quoted in this plan's research, but re-read live — this file is dense and every helper matters). Note its existing local `SourceSummary` type (currently ~lines 37-40) is DELIBERATELY narrow ("Only the SourceSummary fields this page renders. Everything else core sends (provenance, retention, subscription counts) is ignored on purpose.") — this task widens it on purpose for the first time, so update that comment too, not just the type.

- [ ] **Step 4: Add `q`, `retention`, `addedBy` to the local `SourceSummary` type and `listSources` helper**

```typescript
interface SourceSummary {
  source: { id: string; canonicalUrl: string; attributionMode: 'single_publisher' | 'aggregate'; operation: 'enabled' | 'paused'; governance: 'allowed' | 'quarantined' | 'blocked' }
  federationStatus: 'none' | 'pending' | 'approved'
  retention: 'verified_origin' | 'audit_history' | 'admin_retained' | 'reapable' | null
  addedBy: { handle: string; displayName: string }[]
}
```

`listSources` (currently ~line 86) takes `filter?: 'governance'` — widen to `filter?: 'governance' | 'orphan'` and add a `q?: string` param, threading it into the querystring builder alongside `cursor`/`filter`.

- [ ] **Step 5: Add the search param and orphan-group fetch to `load`**

Read `url.searchParams.get('q')` (mirroring the existing `cursor`/`tab` pattern), pass it to the ordinary `listSources` call. Add a THIRD parallel fetch (alongside the existing governance/page ones in the `Promise.all`) for `listSources(f, orphanCursor, 'orphan')`, where `orphanCursor` is a SEPARATE query param (e.g. `?orphanCursor=`) from the ordinary list's `cursor` — the spec requires the orphan group to paginate independently. Return `q`, the orphan group's rows (mapped through a `toRow`-equivalent — decide whether to extend the existing `toRow` or add a sibling, given orphan rows need a `retention` label + reap form instead of the ordinary transition-action list), and its own `orphanCursor`/`orphanNextCursor`.

- [ ] **Step 6: Add a `reap` form action**

Mirror the existing `source`/`tombstone` actions' shape (read them fresh, ~lines 128-219) — read `commandId`/`sourceId`/optionally `force` from the form, refuse a missing `commandId` (never mint one, same reasoning as every other action here), POST to `${base()}/admin/sources/${sourceId}/reap` with `{ commandId, ...(force ? { force: true } : {}) }`. On a `409` with `reason: 'verified_origin_evidence'`, the FIRST form (no force) surfaces this as a `fail()` with the consequence message; the confirm form is a SEPARATE `<form>` in the `.svelte` carrying a DISTINCT freshly-minted `commandId` and a hidden `force=true` field (a same-id retry would fingerprint-conflict, per the spec). Echo `sourceId`/`commandId` on failure, same pattern as `source`/`tombstone`.

- [ ] **Step 7: Update `+page.svelte`**

Add: a no-JS `<form method="GET">` search box writing `?q=`, echoing the current `q` with a "clear" link; an "Orphaned sources" section rendering the orphan group's rows (retention label + reap form + link to `/admin/sources/[id]`) with its own prev/next pagination controls (separate from the ordinary list's); `addedBy` rendered per user-source row as "Added by @handle (+N)" using the first-3-plus-count shape Task 1 already computed. Follow the UI skill's guidance for exact markup/styling — this plan does not prescribe it.

- [ ] **Step 8: Update the frozen privacy-guard test**

`source-actions.test.ts:89-91` currently asserts `Object.keys(r).some((k) => /provenance|adminRetained|item|deliver/i.test(k))).toBe(false)` for every rendered row. `retention` and `addedBy` are NEW fields this page now deliberately renders — confirm this regex still correctly excludes only `provenance`/`adminRetained` (it does, by construction — neither `retention` nor `addedBy` matches `/provenance|adminRetained|item|deliver/i`), and state that confirmation explicitly in this task's commit message rather than silently leaving the regex untouched. If the page's per-row action lists changed (a reap form added to orphan rows), update whatever test asserts on that list too.

- [ ] **Step 9: Write new tests**

Search round-trip (`?q=` echoes and filters); orphan group renders with retention labels and paginates independently of the ordinary list; reap without force on a verified_origin row 409s with the consequence surfaced; the confirm form (separate commandId + force=true) succeeds; `addedBy` renders "Added by @handle (+N)"; prev/next controls work on both lists.

- [ ] **Step 10: Run the web suite**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- source-actions.test.ts` then the full suite: `docker compose exec -T web env -u CORE_API_URL npm test -w web && docker compose exec -T web npm run -w web check`
Expected: 0 svelte-check errors, all tests pass.

- [ ] **Step 11: Commit**

```bash
git add web/src/routes/admin/feeds/+page.server.ts web/src/routes/admin/feeds/+page.svelte web/src/routes/admin/feeds/source-actions.test.ts
git commit -m "web: admin/feeds gains search, an orphan group, and operator reap

Search box (?q=, no-JS form) filters the ordinary source list. A new
always-shown, independently-paginated Orphaned sources group renders each
row's retention reason (verified-origin evidence / audit history /
admin-retained / reapable) with a Reap form; reaping a verified_origin row
is a two-step confirm (a distinct commandId + force=true on the second
form, since a same-id retry would fingerprint-conflict). addedBy renders
as 'Added by @handle (+N)' on every user-source row. Frozen privacy guard
re-confirmed to still exclude only provenance/adminRetained, not the two
new deliberately-exposed fields.

developed with the help of AI tools"
```

---

### Task 5: Web — `/admin/users` pagination

**Files:**
- Modify: `web/src/lib/api.ts`, `web/src/routes/admin/users/+page.server.ts`, `web/src/routes/admin/users/+page.svelte`
- Test: `web/src/lib/api.test.ts`

**Interfaces:**
- Consumes: Task 3's `listUsers(cursor, limit)` / `GET /admin/users?cursor=&limit=` returning `{ items, nextCursor }`.

- [ ] **Step 1: Confirm Task 4 landed**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web && docker compose exec -T web npm run -w web check`

- [ ] **Step 2: Update `listAdminUsers` in `web/src/lib/api.ts`**

Read the current function fresh (currently ~lines 97-107):
```typescript
export async function listAdminUsers(
  f: typeof fetch
): Promise<Array<{ handle: string; displayName: string; kind: string; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }>> {
  const res = await f(`${base()}/admin/users`)
  if (!res.ok) throw new Error(await errorMessage(res, 'listAdminUsers failed'))
  return (
    (await res.json()) as {
      users: Array<{ handle: string; displayName: string; kind: string; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }>
    }
  ).users
}
```
Replace with a cursor-taking, `{ items, nextCursor }`-returning version:
```typescript
export interface AdminUserRow { id: string; handle: string; displayName: string; kind: string; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }

export async function listAdminUsers(f: typeof fetch, cursor?: string): Promise<{ items: AdminUserRow[]; nextCursor: string | null }> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const res = await f(`${base()}/admin/users${qs}`)
  if (!res.ok) throw new Error(await errorMessage(res, 'listAdminUsers failed'))
  return (await res.json()) as { items: AdminUserRow[]; nextCursor: string | null }
}
```

- [ ] **Step 3: Update `web/src/routes/admin/users/+page.server.ts`**

Read the current file fresh (full file quoted in this plan's research — 20 lines). Replace:
```typescript
export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
  const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
  return { users: await listAdminUsers(f) }
}
```
with:
```typescript
export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
  const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
  const cursor = url.searchParams.get('cursor') ?? undefined
  const page = await listAdminUsers(f, cursor)
  return { users: page.items, cursor, nextCursor: page.nextCursor }
}
```

- [ ] **Step 4: Update `web/src/routes/admin/users/+page.svelte`**

Read the current file fresh. Add prev/next `<a>` controls carrying the cursor (no-JS, mirroring `admin/feeds`'s existing pagination links — find and copy that exact pattern rather than inventing a new one). `data.users` stays the same shape consumers already read from (`u.handle`, `u.displayName`, etc.) — only the load's own fetch changed, not the per-row rendering.

- [ ] **Step 5: Update `web/src/lib/api.test.ts`**

The existing test asserting `listAdminUsers`'s return shape needs updating for the new `{ items, nextCursor }` response and the optional `cursor` param — read it fresh (search for `listAdminUsers` in the file) before editing.

- [ ] **Step 6: Run the web suite**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web && docker compose exec -T web npm run -w web check`
Expected: 0 svelte-check errors, all tests pass.

- [ ] **Step 7: Manual smoke** (this is the last task — confirm the whole feature end to end)

Using the running dev stack: load `/admin/feeds`, confirm search + orphan group + reap render; load `/admin/users`, confirm pagination controls work with more than one page of users (seed extra guests if needed to exceed the default page size).

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/api.ts web/src/routes/admin/users/+page.server.ts web/src/routes/admin/users/+page.svelte web/src/lib/api.test.ts
git commit -m "web: admin/users consumes the new cursor-paginated listUsers

listAdminUsers takes an optional cursor and returns {items, nextCursor}
instead of a bare array; the page adds prev/next controls mirroring
admin/feeds' existing pagination pattern. Closes out the users-pagination
half of the admin-governance-visibility spec.

developed with the help of AI tools"
```

---

## Final verification (after all 5 tasks)

- [ ] `docker compose exec -T core npm run -w core test && docker compose exec -T core npm run -w core typecheck` — core suite green, 0 errors.
- [ ] `docker compose exec -T web env -u CORE_API_URL npm test -w web && docker compose exec -T web npm run -w web check` — web suite green, 0 errors.
- [ ] Manual smoke on the running dev stack: `/admin/feeds` search finds a source by URL substring; the orphan group shows a retention label per row and paginates on its own; reaping a `reapable` orphan removes it; reaping a `verified_origin` orphan refuses first, then succeeds after the force-confirm with a distinct commandId; `/admin/users` paginates.
- [ ] Confirm the spec's Goal 1 (findability) is actually met for a source resembling the original incident (an active-subscriber source buried in a large page count) — `?q=` should find it even though it will never appear in the orphan group, matching the spec's own scope-honesty note.

*developed with the help of AI tools*
