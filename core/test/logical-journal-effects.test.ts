import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import type { CommandEnvelope, AuditCategory } from '../src/domain/types.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

// The ONE parametrized §6 journal-effects table (rev 2, TP2). This is the ONLY
// suite that asserts journal-effect COUNTS: each row seeds a scenario, snapshots
// the journal high-water, performs the mutation, and asserts exactly which journal
// kinds it appended for the subject item. Tasks 3/5/6/7 append their own §6 rows
// here (fan-out no-event, verification upsert-on-change / terminal no-event,
// purge's single reset, cleanup's conditional reset, unblock no-event).

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'
const ADMIN = 'admin-1'

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  return { raw, db, store: createLogicalStore(db) }
}
type Store = Awaited<ReturnType<typeof fresh>>['store']
type Db = ReturnType<typeof createDatabaseContext>

const fp = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const env = (commandId: string, requestFingerprint: string): CommandEnvelope =>
  ({ actorScope: 'administrator', actorId: ADMIN, commandId, requestFingerprint })
const hide = (store: Store, id: string, commandId: string, category: AuditCategory = 'spam') =>
  store.hideItem({ command: env(commandId, fp(['hide', id, ADMIN, category])), logicalItemId: id, category, note: null, now: NOW })
const restore = (store: Store, id: string, commandId: string, category: AuditCategory = 'false_positive') =>
  store.restoreItem({ command: env(commandId, fp(['restore', id, ADMIN, category])), logicalItemId: id, category, note: null, now: NOW })

function seedSource(raw: Raw, id: string, url: string, governance = 'allowed'): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, governance, NOW)
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
const remoteId = (raw: Raw, sourceId: string): string =>
  (raw.prepare(`SELECT ik.logical_item_id AS id FROM logical_identity_keys_v2 ik JOIN deliveries_v2 d ON d.id = ik.key WHERE ik.kind = 'delivery' AND d.source_id = ?`).get(sourceId) as { id: string }).id

const highWater = (raw: Raw): number => (raw.prepare(`SELECT high_water_seq AS n FROM logical_journal_meta_v2 WHERE singleton = 1`).get() as { n: number }).n
// Journal kinds this item accrued strictly AFTER `sinceSeq` — isolates the
// mutation's own effect from any seeding upserts.
const journalKindsSince = (raw: Raw, id: string, sinceSeq: number): string[] =>
  (raw.prepare(`SELECT kind FROM logical_journal_v2 WHERE sequence > ? AND logical_item_id = ? ORDER BY sequence`).all(sinceSeq, id) as { kind: string }[]).map((r) => r.kind)

// Seed a remote item; `governance='quarantined'` makes it ordinarily absent.
async function remoteItem(db: Db, raw: Raw, store: Store, sourceId: string, governance = 'allowed'): Promise<string> {
  const url = `https://feed.test/${sourceId}`
  seedSource(raw, sourceId, url, governance)
  await acquire(db, sourceId, url, RSS(guidItem(`${sourceId}-g`)))
  drain(store)
  return remoteId(raw, sourceId)
}

interface Row {
  name: string
  // Returns the subject item already in its pre-mutation state, then the mutation
  // to measure and the exact journal kinds it must append for that item.
  run: (ctx: { db: Db; raw: Raw; store: Store }) => Promise<{ id: string; mutate: () => void }>
  expected: string[]
}

const ROWS: Row[] = [
  {
    name: 'hide of an ordinarily-visible item → one remove',
    expected: ['remove'],
    run: async ({ db, raw, store }) => {
      const id = await remoteItem(db, raw, store, 's1')
      return { id, mutate: () => hide(store, id, 'c1') }
    },
  },
  {
    name: 'hide of an already ordinarily-absent item → no record',
    expected: [],
    run: async ({ db, raw, store }) => {
      const id = await remoteItem(db, raw, store, 's1', 'quarantined')
      return { id, mutate: () => hide(store, id, 'c1') }
    },
  },
  {
    name: 'restore of an item with an eligible delivery → one upsert',
    expected: ['upsert'],
    run: async ({ db, raw, store }) => {
      const id = await remoteItem(db, raw, store, 's1')
      hide(store, id, 'c1')
      return { id, mutate: () => restore(store, id, 'c2') }
    },
  },
  {
    name: 'restore with no eligible delivery → no record',
    expected: [],
    run: async ({ db, raw, store }) => {
      const id = await remoteItem(db, raw, store, 's1', 'quarantined')
      hide(store, id, 'c1')
      return { id, mutate: () => restore(store, id, 'c2') }
    },
  },
]

test.each(ROWS)('§6 journal effect: $name', async ({ run, expected }) => {
  const ctx = await fresh()
  const { id, mutate } = await run(ctx)
  const before = highWater(ctx.raw)
  mutate()
  expect(journalKindsSince(ctx.raw, id, before)).toEqual(expected)
})
