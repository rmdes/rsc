import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { fingerprintRequest } from '../src/domain/source-repository.ts'
import type { CommandEnvelope } from '../src/domain/types.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

// Task 3 (spec §4.1): generation-qualified policy fan-out on the ONE V2 drain. A
// generation-advancing transition enqueues a policy_fanout_v2 row in the SAME
// transaction as its reset + generation advance; the drain claims and processes
// it in bounded batches through the SHARED comparator, converging materialized
// selection hints and writing NO journal/visibility/audit. Stale-generation
// batches self-abort. This suite asserts fan-out STATE / CURSOR / SUPERSESSION;
// the no-journal §6 row lives in logical-journal-effects.test.ts.

type Raw = InstanceType<typeof Database>
type Db = ReturnType<typeof createDatabaseContext>
const T0 = '2026-01-01T00:00:00.000Z'
const NOW = '2026-07-24T00:00:00.000Z'

function count(raw: Raw, table: string, where = '', ...args: unknown[]): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args) as { n: number }).n
}
function generation(raw: Raw, sourceId: string): number {
  return (raw.prepare(`SELECT policy_generation AS g FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { g: number }).g
}
interface FanoutRow { source_id: string; generation: number; last_item_cursor: string | null; state: string }
function fanoutRow(raw: Raw, sourceId: string): FanoutRow | undefined {
  return raw.prepare(`SELECT source_id, generation, last_item_cursor, state FROM policy_fanout_v2 WHERE source_id = ?`).get(sourceId) as FanoutRow | undefined
}
function selectedDelivery(raw: Raw, itemId: string): string | null {
  return (raw.prepare(`SELECT selected_delivery_id AS d FROM logical_items_v2 WHERE id = ?`).get(itemId) as { d: string | null }).d
}

function adminCmd(actorId: string, commandId: string): CommandEnvelope {
  return { actorScope: 'administrator', actorId, commandId, requestFingerprint: fingerprintRequest(['t', commandId]) }
}

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  return { repo, raw, db, store: createLogicalStore(db) }
}
type Store = Awaited<ReturnType<typeof fresh>>['store']

function seedSource(raw: Raw, opts: { url: string; governance?: string }): string {
  const id = randomUUID()
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, opts.url, opts.governance ?? 'allowed', T0)
  return id
}

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const ok = (body: string): Response => new Response(body, { status: 200 })
const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed T</title>${items}</channel></rss>`
const guidItem = (guid: string): string => `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>d</description></item>`
async function acquire(db: Db, sourceId: string, url: string, body: string): Promise<void> {
  const eng = createAcquisition({ db, fetchFn: (async (i: string | URL | Request) => { const u = typeof i === 'string' ? i : i instanceof URL ? i.toString() : i.url; if (u !== url) throw new Error(`no route ${u}`); return ok(body) }) as unknown as typeof fetch, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource(sourceId, { kind: 'scheduled' }, undefined)
}
const drain = (store: Store): number => drainReconciliation({ store, now: () => NOW })

// Acquire `n` guid items from one allowed source and drain them into logical
// items, each holding one delivery from the source. Returns the source id and
// the item ids in ascending order.
async function seedItems(db: Db, raw: Raw, store: Store, n: number): Promise<{ sourceId: string; itemIds: string[] }> {
  const url = 'https://feed.test/many'
  const sourceId = seedSource(raw, { url })
  const items = Array.from({ length: n }, (_, i) => guidItem(`g-${String(i).padStart(4, '0')}`)).join('')
  await acquire(db, sourceId, url, RSS(items))
  drain(store)
  const itemIds = (raw.prepare(
    `SELECT DISTINCT ik.logical_item_id AS id FROM logical_identity_keys_v2 ik
     JOIN deliveries_v2 d ON d.id = ik.key
     WHERE ik.kind = 'delivery' AND d.source_id = ? ORDER BY ik.logical_item_id ASC`,
  ).all(sourceId) as { id: string }[]).map((r) => r.id)
  return { sourceId, itemIds }
}

// --- enqueue: a generation-advancing transition upserts a pending row --------

test('a governance transition upserts a pending fan-out row {new generation, null cursor} atomically with its reset', async () => {
  const { repo, raw } = await fresh()
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const id = seedSource(raw, { url: 'https://gov.test/f' })
  expect(fanoutRow(raw, id)).toBeUndefined()

  await repo.transition({ command: adminCmd(admin.id, 'g1'), sourceId: id, action: 'quarantine', category: 'spam', note: null, actorKind: 'administrator', now: NOW })
  expect(generation(raw, id)).toBe(1)
  expect(fanoutRow(raw, id)).toMatchObject({ generation: 1, last_item_cursor: null, state: 'pending' })
})

test('federation establishment enqueues a pending fan-out row', async () => {
  const { repo, raw } = await fresh()
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  await repo.establishFederation({ command: adminCmd(admin.id, 'f1'), canonicalUrl: 'https://fed.test/f', attributionMode: 'aggregate', category: 'operator_policy', note: null, actorKind: 'administrator', now: NOW })
  const src = raw.prepare(`SELECT id FROM remote_sources_v2 WHERE canonical_url = ?`).get('https://fed.test/f') as { id: string }
  expect(fanoutRow(raw, src.id)).toMatchObject({ generation: 1, last_item_cursor: null, state: 'pending' })
})

test('pause and resume advance no generation and enqueue NO fan-out', async () => {
  const { repo, raw } = await fresh()
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const id = seedSource(raw, { url: 'https://pr.test/f' })
  await repo.transition({ command: adminCmd(admin.id, 'p1'), sourceId: id, action: 'pause', category: null, note: null, actorKind: 'administrator', now: NOW })
  await repo.transition({ command: adminCmd(admin.id, 'r1'), sourceId: id, action: 'resume', category: null, note: null, actorKind: 'administrator', now: NOW })
  expect(generation(raw, id)).toBe(0)
  expect(count(raw, 'policy_fanout_v2')).toBe(0)
})

test('a fault before commit rolls back the fan-out row together with the transition', async () => {
  const { repo, raw } = await fresh()
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const id = seedSource(raw, { url: 'https://fault.test/f' })
  raw.exec('DROP TABLE command_ledger_v2') // storeCommand (last write) throws → whole BEGIN IMMEDIATE rolls back
  await expect(repo.transition({ command: adminCmd(admin.id, 'x1'), sourceId: id, action: 'quarantine', category: 'spam', note: null, actorKind: 'administrator', now: NOW })).rejects.toThrow()
  expect(generation(raw, id)).toBe(0)
  expect(count(raw, 'policy_fanout_v2')).toBe(0)
})

// --- batching: 100 per transaction, ascending id, converge hints, resume -----

test('batches process 100 items in ascending id, recompute hints, persist the cursor, and resume from it', async () => {
  const { repo, raw, db, store } = await fresh()
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const { sourceId, itemIds } = await seedItems(db, raw, store, 105)
  expect(itemIds).toHaveLength(105)
  // Allowed source: every item has a selected delivery after the drain.
  expect(itemIds.every((id) => selectedDelivery(raw, id) !== null)).toBe(true)

  // Quarantine (advances generation, enqueues fan-out) WITHOUT touching item hints.
  await repo.transition({ command: adminCmd(admin.id, 'q1'), sourceId, action: 'quarantine', category: 'spam', note: null, actorKind: 'administrator', now: NOW })
  expect(itemIds.every((id) => selectedDelivery(raw, id) !== null)).toBe(true) // still stale

  const claim1 = store.claimFanout(NOW)!
  expect(claim1).toMatchObject({ sourceId, generation: 1, lastItemCursor: null })
  const batch1 = store.processFanoutBatch({ claim: claim1, now: NOW })
  expect(batch1).toEqual({ kind: 'progress', processed: 100 })
  expect(fanoutRow(raw, sourceId)!.last_item_cursor).toBe(itemIds[99]) // ascending: cursor = 100th id
  // First 100 converged (quarantined ⇒ no eligible delivery ⇒ null); tail untouched.
  expect(itemIds.slice(0, 100).every((id) => selectedDelivery(raw, id) === null)).toBe(true)
  expect(itemIds.slice(100).every((id) => selectedDelivery(raw, id) !== null)).toBe(true)

  const claim2 = store.claimFanout(NOW)!
  expect(claim2.lastItemCursor).toBe(itemIds[99]) // resumes from the durable cursor
  const batch2 = store.processFanoutBatch({ claim: claim2, now: NOW })
  expect(batch2).toEqual({ kind: 'done', processed: 5 })
  expect(itemIds.every((id) => selectedDelivery(raw, id) === null)).toBe(true) // fully converged
})

test('the drain converges a whole source in one pass with no second loop', async () => {
  const { repo, raw, db, store } = await fresh()
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const { sourceId, itemIds } = await seedItems(db, raw, store, 105)
  await repo.transition({ command: adminCmd(admin.id, 'q1'), sourceId, action: 'quarantine', category: 'spam', note: null, actorKind: 'administrator', now: NOW })
  drain(store) // the ONE drain processes fan-out alongside jobs
  expect(itemIds.every((id) => selectedDelivery(raw, id) === null)).toBe(true)
  expect(fanoutRow(raw, sourceId)!.state).toBe('done')
})

// --- supersession: a stale-generation batch writes nothing (Appendix D) ------

test('a running batch whose captured generation no longer matches supersedes and writes nothing', async () => {
  const { repo, raw, db, store } = await fresh()
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const { sourceId, itemIds } = await seedItems(db, raw, store, 3)

  // Rapid quarantine -> allow -> block: three generation advances, one row.
  await repo.transition({ command: adminCmd(admin.id, 't1'), sourceId, action: 'quarantine', category: 'spam', note: null, actorKind: 'administrator', now: NOW })
  await repo.transition({ command: adminCmd(admin.id, 't2'), sourceId, action: 'allow', category: 'false_positive', note: null, actorKind: 'administrator', now: NOW })
  await repo.transition({ command: adminCmd(admin.id, 't3'), sourceId, action: 'block', category: 'abuse', note: null, actorKind: 'administrator', now: NOW })
  expect(generation(raw, sourceId)).toBe(3)

  const before = itemIds.map((id) => selectedDelivery(raw, id))
  const claim = store.claimFanout(NOW)!
  // A batch carrying a stale generation self-aborts and touches no hints.
  expect(store.processFanoutBatch({ claim: { ...claim, generation: claim.generation - 1 }, now: NOW }))
    .toEqual({ kind: 'superseded', processed: 0 })
  expect(itemIds.map((id) => selectedDelivery(raw, id))).toEqual(before) // no hint write

  // The current-generation batch still converges (blocked ⇒ no eligible delivery).
  const good = store.claimFanout(NOW)!
  expect(good.generation).toBe(3)
  expect(store.processFanoutBatch({ claim: good, now: NOW }).kind).toBe('done')
  expect(itemIds.every((id) => selectedDelivery(raw, id) === null)).toBe(true)
})
