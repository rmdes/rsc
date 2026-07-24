import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { scheduleFanout } from '../src/logical/fanout.ts'
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

const ORIGIN = 'https://origin.test/feed.xml'
const guidSrcItem = (guid: string, sourceUrl: string): string =>
  `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>d</description><source url="${sourceUrl}">O</source></item>`
function seedAggSource(raw: Raw, id: string, url: string, governance = 'allowed'): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'aggregate', 'enabled', ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, governance, NOW)
}
// A fetched origin-feed candidate matching a guid, as resolveVerificationBatch consumes it.
function evidenceFor(guid: string) {
  const canonical = Buffer.from(JSON.stringify({ title: 't', content: 'd', link: null, inReplyTo: null }))
  return {
    normalizedPermalink: null, opaqueId: guid,
    evidence: { id: randomUUID(), deliveryId: randomUUID(), wireOrdinal: 0, arrivalAt: NOW, fingerprintVersion: 1 as const, fingerprint: createHash('sha256').update(guid).digest('hex'), canonicalMaterial: new Uint8Array(canonical), rawEvidenceJson: JSON.stringify({ title: 't', sourceName: null }), normalizedJson: JSON.stringify({ keyKind: 'opaque', key: guid, permalink: null, inReplyTo: null, enclosures: [] }) },
  }
}
const verifyJobId = (raw: Raw): string => (raw.prepare(`SELECT id FROM reconciliation_jobs_v2 WHERE kind = 'verification' LIMIT 1`).get() as { id: string }).id

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
  {
    // Fan-out converges materialized hints only; it appends NO journal record,
    // even when it MOVES a hint (here: quarantine drops the selected delivery).
    // The transition's own reset was the client barrier (spec §2, §4.1).
    name: 'fan-out batch converging an item hint → no record',
    expected: [],
    run: async ({ db, raw, store }) => {
      const id = await remoteItem(db, raw, store, 's1')
      // Advance the source's policy generation, quarantine it, and enqueue fan-out
      // — exactly the co-transaction a governance transition performs.
      raw.prepare(`UPDATE remote_sources_v2 SET governance = 'quarantined', policy_generation = policy_generation + 1 WHERE id = ?`).run('s1')
      db.write((tx) => scheduleFanout(tx, { sourceId: 's1', generation: 1, now: NOW }))
      return { id, mutate: () => drain(store) } // the drain processes the fan-out row
    },
  },
  {
    // A verified origin flips the item's selected author to verified_origin →
    // one upsert (the ordinary author changed). The fetch is elided: the outcome
    // is handed straight to the synchronous resolveVerificationBatch.
    name: 'verification success changing the selected author → one upsert',
    expected: ['upsert'],
    run: async ({ db, raw, store }) => {
      seedAggSource(raw, 's_agg', 'https://agg.test/f')
      await acquire(db, 's_agg', 'https://agg.test/f', RSS(guidSrcItem('g1', ORIGIN)))
      drain(store) // creates the item + the pending check + the verification job
      const id = remoteId(raw, 's_agg')
      const jobId = verifyJobId(raw)
      return { id, mutate: () => store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: { kind: 'fetched', parsedItems: [evidenceFor('g1')], publisherRedirect: null }, now: NOW }) }
    },
  },
  {
    // A verified origin of a quarantined aggregate is itself quarantined —
    // ineligible for both ordinary comparators, so nothing ordinary changes.
    name: 'verification success changing nothing ordinary → no record',
    expected: [],
    run: async ({ db, raw, store }) => {
      seedAggSource(raw, 's_agg', 'https://agg.test/f', 'quarantined')
      await acquire(db, 's_agg', 'https://agg.test/f', RSS(guidSrcItem('g1', ORIGIN)))
      drain(store)
      const id = remoteId(raw, 's_agg')
      const jobId = verifyJobId(raw)
      return { id, mutate: () => store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: { kind: 'fetched', parsedItems: [evidenceFor('g1')], publisherRedirect: null }, now: NOW }) }
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
