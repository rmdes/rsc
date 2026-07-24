import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { appendItemAudit } from '../src/logical/moderation.ts'
import { encodeCursor, decodeCursor } from '../src/domain/cursor.ts'

type Raw = InstanceType<typeof Database>

const NOW = '2026-07-24T00:00:00.000Z'

function count(raw: Raw, table: string, where = '', ...args: unknown[]): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args) as { n: number }).n
}
function tableNames(raw: Raw): Set<string> {
  const rows = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}
function indexNames(raw: Raw): Set<string> {
  const rows = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}
function tableSql(raw: Raw, name: string): string {
  return (raw.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as { sql: string }).sql
}
async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  return { raw: repo.raw as Raw, db: createDatabaseContext(repo.raw) }
}
function seedItem(raw: Raw, id: string, at: string): void {
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at)
     VALUES (?, 'remote', ?, 'none', NULL, NULL, NULL, ?)`,
  ).run(id, at, at)
}

const V3_TABLES = [
  'item_audit_v2', 'policy_fanout_v2', 'verification_checks_v2',
  'publisher_feed_aliases_v2', 'blocked_source_tombstones_v2', 'tombstone_aliases_v2',
]

// --- Step 1: schema shape --------------------------------------------------

test('the V3 migration creates every V3 table', async () => {
  const { raw } = await fresh()
  const names = tableNames(raw)
  for (const t of V3_TABLES) expect(names, `missing table ${t}`).toContain(t)
})

test('logical_items_v2 gains hidden_at and structural_tombstone, additively', async () => {
  const { raw } = await fresh()
  const cols = (raw.prepare(`PRAGMA table_info(logical_items_v2)`).all() as { name: string }[]).map((r) => r.name)
  expect(cols).toContain('hidden_at')
  expect(cols).toContain('structural_tombstone')
  // additive: every pre-existing V2 column survives
  for (const c of ['id', 'origin', 'timeline_sort_at', 'parent_state', 'created_at']) expect(cols).toContain(c)
})

test('the item_audit_v2 page index ships', async () => {
  const { raw } = await fresh()
  expect(indexNames(raw)).toContain('item_audit_v2_page')
})

test('reconciliation_jobs_v2 (V2 lockstep amendment 1) accepts a verification row with null run_id/observation_version_id and rejects one with a null verification_batch_key', async () => {
  const { raw } = await fresh()
  const COLS = `id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at`
  expect(() =>
    raw.prepare(`INSERT INTO reconciliation_jobs_v2 (${COLS}) VALUES (?, 'verification', NULL, NULL, ?, 'pending', 0, ?, NULL, NULL, ?)`)
      .run('job-v1', 'https://pub.example/feed.xml', NOW, NOW),
  ).not.toThrow()
  expect(count(raw, 'reconciliation_jobs_v2', "WHERE kind = 'verification'")).toBe(1)
  expect(() =>
    raw.prepare(`INSERT INTO reconciliation_jobs_v2 (${COLS}) VALUES (?, 'verification', NULL, NULL, NULL, 'pending', 0, ?, NULL, NULL, ?)`)
      .run('job-v2', NOW, NOW),
  ).toThrow()
})

test('item_audit_v2 accepts the re-added categories false_positive and remediated, and rejects a made-up category', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'item-1', NOW)
  db.write((tx) => {
    appendItemAudit(tx, { logicalItemId: 'item-1', commandId: 'c1', actorId: 'admin-1', actorKind: 'administrator', action: 'restore', category: 'false_positive', note: null, result: { kind: 'applied' }, now: NOW })
  })
  db.write((tx) => {
    appendItemAudit(tx, { logicalItemId: 'item-1', commandId: 'c2', actorId: null, actorKind: 'system', action: 'tombstone-unblock', category: 'remediated', note: null, result: { kind: 'unblocked' }, now: NOW })
  })
  expect(count(raw, 'item_audit_v2')).toBe(2)
  expect(() =>
    raw.prepare(
      `INSERT INTO item_audit_v2 (id, logical_item_id, command_id, actor_id, actor_kind, action, category, note, result_json, created_at)
       VALUES ('bad1', 'item-1', 'c3', NULL, 'system', 'hide', 'not-a-real-category', NULL, '{}', ?)`,
    ).run(NOW),
  ).toThrow()
})

// The frozen V1 DDL (core/src/storage/sqlite.ts) — asserted byte-identical
// after the V3 migration to prove no rebuild ever touched source_audit_v2.
const SOURCE_AUDIT_V2_DDL = `CREATE TABLE source_audit_v2 (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL, actor_id TEXT,
      actor_kind TEXT NOT NULL CHECK(actor_kind IN ('administrator','operator_token','system')),
      action TEXT NOT NULL,
      category TEXT CHECK(category IS NULL OR category IN ('spam','abuse','illegal_content','compromised_source','migration_review','operator_policy','false_positive','remediated','other')),
      note TEXT, result_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`

test('source_audit_v2 is untouched by the V3 migration (byte-identical sql, no rebuild)', async () => {
  const { raw } = await fresh()
  expect(tableSql(raw, 'source_audit_v2')).toBe(SOURCE_AUDIT_V2_DDL)
})

// --- Step 2: item-audit primitives ------------------------------------------

test('appendItemAudit persists a row matching its input and the returned ItemAuditEvent', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'item-1', NOW)
  const event = db.write((tx) =>
    appendItemAudit(tx, { logicalItemId: 'item-1', commandId: 'c1', actorId: 'admin-1', actorKind: 'administrator', action: 'hide', category: 'spam', note: 'bad actor', result: { kind: 'applied', hiddenAt: NOW }, now: NOW }),
  )
  expect(event).toMatchObject({ logicalItemId: 'item-1', commandId: 'c1', actorId: 'admin-1', actorKind: 'administrator', action: 'hide', category: 'spam', note: 'bad actor', createdAt: NOW })
  expect(typeof event.id).toBe('string')
  expect(JSON.parse(event.resultJson)).toEqual({ kind: 'applied', hiddenAt: NOW })
  const row = raw.prepare(`SELECT * FROM item_audit_v2 WHERE id = ?`).get(event.id) as { logical_item_id: string; result_json: string }
  expect(row.logical_item_id).toBe('item-1')
  expect(row.result_json).toBe(event.resultJson)
})

test('appendItemAudit rolls back together with the item row it audits on a mid-transaction fault (Appendix D pattern)', async () => {
  const { raw, db } = await fresh()
  expect(() =>
    db.write((tx) => {
      tx.prepare(
        `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at)
         VALUES ('item-doomed', 'remote', ?, 'none', NULL, NULL, NULL, ?)`,
      ).run(NOW, NOW)
      appendItemAudit(tx, { logicalItemId: 'item-doomed', commandId: 'c1', actorId: 'admin-1', actorKind: 'administrator', action: 'hide', category: 'spam', note: null, result: { kind: 'applied' }, now: NOW })
      throw new Error('fault-before-commit')
    }),
  ).toThrow('fault-before-commit')
  expect(count(raw, 'logical_items_v2', 'WHERE id = ?', 'item-doomed')).toBe(0)
  expect(count(raw, 'item_audit_v2')).toBe(0)
})

test('listItemAudit pages newest-first over the immutable (createdAt,id) tuple, round-tripping through the shared cursor codec', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'item-1', NOW)
  const store = createLogicalStore(db)
  const T0 = '2026-07-24T00:00:00.000Z'
  const T1 = '2026-07-24T00:00:01.000Z'
  const T2 = '2026-07-24T00:00:02.000Z'
  db.write((tx) => {
    appendItemAudit(tx, { logicalItemId: 'item-1', commandId: 'c0', actorId: 'a', actorKind: 'administrator', action: 'hide', category: 'spam', note: null, result: {}, now: T0 })
    appendItemAudit(tx, { logicalItemId: 'item-1', commandId: 'c1', actorId: 'a', actorKind: 'administrator', action: 'restore', category: 'false_positive', note: null, result: {}, now: T1 })
    appendItemAudit(tx, { logicalItemId: 'item-1', commandId: 'c2', actorId: 'a', actorKind: 'administrator', action: 'hide', category: 'abuse', note: null, result: {}, now: T2 })
  })

  const page1 = store.listItemAudit('item-1', undefined, 2)
  expect(page1.items.map((e) => e.createdAt)).toEqual([T2, T1]) // newest first
  expect(page1.nextCursor).toEqual(expect.any(String))

  const decoded = decodeCursor(page1.nextCursor!)!
  const page2 = store.listItemAudit('item-1', { createdAt: decoded.tuple[0], id: decoded.tuple[1] }, 2)
  expect(page2.items.map((e) => e.createdAt)).toEqual([T0])
  expect(page2.nextCursor).toBeNull()

  const allIds = new Set([...page1.items, ...page2.items].map((e) => e.id))
  expect(allIds.size).toBe(3) // no overlap, no gap across pages
})

test('listItemAudit defaults to 50 and clamps to a max of 100', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'item-1', NOW)
  const store = createLogicalStore(db)
  const base = Date.parse(NOW)
  db.write((tx) => {
    for (let i = 0; i < 105; i++) {
      appendItemAudit(tx, { logicalItemId: 'item-1', commandId: `c${i}`, actorId: 'a', actorKind: 'administrator', action: 'hide', category: 'spam', note: null, result: {}, now: new Date(base + i).toISOString() })
    }
  })
  expect(count(raw, 'item_audit_v2')).toBe(105)

  const defaultPage = store.listItemAudit('item-1', undefined)
  expect(defaultPage.items).toHaveLength(50)
  expect(defaultPage.nextCursor).toEqual(expect.any(String))

  const clampedPage = store.listItemAudit('item-1', undefined, 1000)
  expect(clampedPage.items).toHaveLength(100) // clamped, not 1000 and not the 50 default
  expect(clampedPage.nextCursor).toEqual(expect.any(String))
})

// The shared invalid-cursor cases (VP7): every one decodes to null through the
// frozen shared codec, the same canary the route layer will 400 on (Task 8).
const INVALID_CURSORS = ['', '@@bogus@@', 'not-base64!!', Buffer.from(JSON.stringify([2, 'a', 'b'])).toString('base64url')]

test('every invalid cursor decodes to null through the shared codec', () => {
  for (const bad of INVALID_CURSORS) expect(decodeCursor(bad), bad).toBeNull()
  // sanity: a validly-encoded cursor is never null
  expect(decodeCursor(encodeCursor(1, ['x', 'y']))).not.toBeNull()
})
