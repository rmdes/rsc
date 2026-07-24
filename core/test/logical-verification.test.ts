import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { drainReconciliation, drainReconciliationAsync } from '../src/logical/reconcile.ts'
import {
  scheduleVerification, createVerificationRunner,
  VERIFICATION_MAX_NEW_PER_RESPONSE, VERIFICATION_MAX_PENDING_PER_PUBLISHER,
  VERIFICATION_MAX_PENDING_PER_SOURCE, VERIFICATION_RESPONSE_REUSE_MS,
} from '../src/logical/verification.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'

function count(raw: Raw, table: string, where = '', ...args: unknown[]): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args) as { n: number }).n
}

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  return { raw, db, store: createLogicalStore(db) }
}

function seedSource(raw: Raw, id: string, url: string, opts: { mode?: string; operation?: string; governance?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, ?, ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, opts.mode ?? 'aggregate', opts.operation ?? 'enabled', opts.governance ?? 'allowed', NOW)
}

// Hand-seed a logical item so scheduleVerification's FK (logical_item_id) holds.
function seedItem(raw: Raw, id: string): void {
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'remote', ?, 'none', NULL, NULL, NULL, ?)`).run(id, NOW, NOW)
}

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const ok = (body: string): Response => new Response(body, { status: 200 })
function countingFetch(map: Record<string, () => Response | Promise<Response>>): { fn: typeof fetch; calls: () => number; callsFor: (u: string) => number } {
  const byUrl: Record<string, number> = {}
  let total = 0
  const fn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    total++; byUrl[url] = (byUrl[url] ?? 0) + 1
    const h = map[url]
    if (!h) throw new Error(`no route: ${url}`)
    return await h()
  }) as unknown as typeof fetch
  return { fn, calls: () => total, callsFor: (u) => byUrl[u] ?? 0 }
}

const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>Origin</title>${items}</channel></rss>`
const guidItem = (guid: string, sourceUrl?: string): string =>
  `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>d</description>${sourceUrl ? `<source url="${sourceUrl}">Origin Feed</source>` : ''}</item>`

async function acquire(db: ReturnType<typeof createDatabaseContext>, raw: Raw, sourceId: string, url: string, body: string): Promise<void> {
  const eng = createAcquisition({ db, fetchFn: (async () => ok(body)) as unknown as typeof fetch, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource(sourceId, { kind: 'scheduled' }, undefined)
}

const ORIGIN = 'https://origin.test/feed.xml'

// ---- scheduling: check + job rows, dedup, idempotence -----------------------

test('scheduleVerification writes one pending check + one verification job per batch key; re-seeing creates nothing', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  seedItem(raw, 'li-1'); seedItem(raw, 'li-2')

  db.write((tx) => scheduleVerification(tx, { logicalItemId: 'li-1', sourceId: 's_agg', publisherFeedUrl: ORIGIN, now: NOW }))
  expect(count(raw, 'verification_checks_v2')).toBe(1)
  const check = raw.prepare(`SELECT logical_item_id, source_id, publisher_feed_url, batch_key, state, resolved_at FROM verification_checks_v2`).get() as Record<string, unknown>
  expect(check).toMatchObject({ logical_item_id: 'li-1', source_id: 's_agg', publisher_feed_url: ORIGIN, batch_key: ORIGIN, state: 'pending', resolved_at: null })
  const job = raw.prepare(`SELECT kind, run_id, observation_version_id, verification_batch_key, status, attempts FROM reconciliation_jobs_v2 WHERE kind = 'verification'`).get() as Record<string, unknown>
  expect(job).toMatchObject({ kind: 'verification', run_id: null, observation_version_id: null, verification_batch_key: ORIGIN, status: 'pending', attempts: 0 })

  // re-seeing the SAME (item, url) creates nothing
  db.write((tx) => scheduleVerification(tx, { logicalItemId: 'li-1', sourceId: 's_agg', publisherFeedUrl: ORIGIN, now: NOW }))
  expect(count(raw, 'verification_checks_v2')).toBe(1)

  // the SAME url for a DIFFERENT item adds a check but NOT a second active job (batch dedup)
  db.write((tx) => scheduleVerification(tx, { logicalItemId: 'li-2', sourceId: 's_agg', publisherFeedUrl: ORIGIN, now: NOW }))
  expect(count(raw, 'verification_checks_v2')).toBe(2)
  expect(count(raw, 'reconciliation_jobs_v2', "WHERE kind = 'verification'")).toBe(1)
})

test('scheduleVerification creates nothing for a URL that fails normalization or the sync SSRF guard', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  seedItem(raw, 'li-1')
  for (const bad of ['not-a-url', 'ftp://x.test/f', 'http://user:pass@h.test/f', 'http://127.0.0.1/f', 'http://[::1]/f', 'http://10.0.0.1/f']) {
    db.write((tx) => scheduleVerification(tx, { logicalItemId: 'li-1', sourceId: 's_agg', publisherFeedUrl: bad, now: NOW }))
  }
  expect(count(raw, 'verification_checks_v2')).toBe(0)
  expect(count(raw, 'reconciliation_jobs_v2', "WHERE kind = 'verification'")).toBe(0)
})

test('cap: at most 25 distinct unseen publisher URLs per source; the 26th is dropped', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  for (let i = 0; i < 26; i++) {
    seedItem(raw, `li-${i}`)
    db.write((tx) => scheduleVerification(tx, { logicalItemId: `li-${i}`, sourceId: 's_agg', publisherFeedUrl: `https://origin${i}.test/f`, now: NOW }))
  }
  expect((raw.prepare(`SELECT COUNT(DISTINCT publisher_feed_url) AS n FROM verification_checks_v2`).get() as { n: number }).n).toBe(VERIFICATION_MAX_NEW_PER_RESPONSE)
  expect(count(raw, 'verification_checks_v2', "WHERE publisher_feed_url = 'https://origin25.test/f'")).toBe(0)
})

test('cap: at most 50 pending checks per publisher URL; the 51st is not created', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  for (let i = 0; i < 51; i++) {
    seedItem(raw, `li-${i}`)
    db.write((tx) => scheduleVerification(tx, { logicalItemId: `li-${i}`, sourceId: 's_agg', publisherFeedUrl: ORIGIN, now: NOW }))
  }
  expect(count(raw, 'verification_checks_v2', 'WHERE publisher_feed_url = ?', ORIGIN)).toBe(VERIFICATION_MAX_PENDING_PER_PUBLISHER)
})

test('cap: at most 200 pending checks per source; the 201st is not created', async () => {
  const { raw, db } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  // 4 urls * 50 = 200 (each url at its per-publisher cap, 4 distinct urls < 25)
  let n = 0
  for (let u = 0; u < 4; u++) {
    for (let i = 0; i < VERIFICATION_MAX_PENDING_PER_PUBLISHER; i++) {
      seedItem(raw, `li-${n}`)
      db.write((tx) => scheduleVerification(tx, { logicalItemId: `li-${n}`, sourceId: 's_agg', publisherFeedUrl: `https://origin${u}.test/f`, now: NOW }))
      n++
    }
  }
  expect(count(raw, 'verification_checks_v2', "WHERE source_id = 's_agg'")).toBe(VERIFICATION_MAX_PENDING_PER_SOURCE)
  // a 5th distinct url (fresh per-publisher count) is still dropped by the per-source cap
  seedItem(raw, 'li-over')
  db.write((tx) => scheduleVerification(tx, { logicalItemId: 'li-over', sourceId: 's_agg', publisherFeedUrl: 'https://origin4.test/f', now: NOW }))
  expect(count(raw, 'verification_checks_v2', "WHERE source_id = 's_agg'")).toBe(VERIFICATION_MAX_PENDING_PER_SOURCE)
})

// ---- reconcile integration: only the aggregate path schedules ---------------

test('an aggregate claim with a valid <source url> schedules verification; single_publisher and missing/invalid source url schedule nothing', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f', { mode: 'aggregate' })
  seedSource(raw, 's_bound', 'https://bound.test/f', { mode: 'single_publisher' })
  await acquire(db, raw, 's_agg', 'https://agg.test/f', RSS(guidItem('g-agg', ORIGIN)))
  await acquire(db, raw, 's_bound', 'https://bound.test/f', RSS(guidItem('g-bound', ORIGIN)))
  drainReconciliation({ store, now: () => NOW })
  // exactly one check, for the aggregate item, keyed by the origin feed url
  expect(count(raw, 'verification_checks_v2')).toBe(1)
  expect(count(raw, 'verification_checks_v2', 'WHERE publisher_feed_url = ?', ORIGIN)).toBe(1)

  // aggregate item with NO <source> element schedules nothing
  await acquire(db, raw, 's_agg', 'https://agg.test/f', RSS(guidItem('g-nosrc')))
  drainReconciliation({ store, now: () => NOW })
  expect(count(raw, 'verification_checks_v2')).toBe(1)
})

// ---- the bounded batched fetch on the one drain -----------------------------

function seedVerificationJob(raw: Raw, batchKey: string, sourceId: string, items: string[]): void {
  for (const li of items) {
    seedItem(raw, li)
    raw.prepare(`INSERT INTO verification_checks_v2 (id, logical_item_id, source_id, publisher_feed_url, batch_key, state, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`).run(randomUUID(), li, sourceId, batchKey, batchKey, NOW)
  }
  raw.prepare(`INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at) VALUES (?, 'verification', NULL, NULL, ?, 'pending', 0, ?, NULL, NULL, ?)`).run(randomUUID(), batchKey, NOW, NOW)
}

test('one bounded fetch serves ALL pending checks for a batch key', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  seedVerificationJob(raw, ORIGIN, 's_agg', ['li-1', 'li-2', 'li-3'])
  const cf = countingFetch({ [ORIGIN]: () => ok(RSS(guidItem('g1'))) })
  const runner = createVerificationRunner({ db, store, fetchFn: cf.fn, lookupFn: publicLookup, now: () => NOW })
  const claim = store.claimReconciliation(NOW)!
  expect(claim.kind).toBe('verification')
  await runner.runVerificationBatch(claim as { kind: 'verification'; jobId: string; batchKey: string }, NOW)
  expect(cf.callsFor(ORIGIN)).toBe(1)
})

test('a response fetched within 10 minutes serves newly queued checks without refetching; a later fetch refetches', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  seedVerificationJob(raw, ORIGIN, 's_agg', ['li-1'])
  const cf = countingFetch({ [ORIGIN]: () => ok(RSS(guidItem('g1'))) })
  const runner = createVerificationRunner({ db, store, fetchFn: cf.fn, lookupFn: publicLookup, now: () => NOW })
  const claim = { kind: 'verification' as const, jobId: 'j', batchKey: ORIGIN }
  await runner.runVerificationBatch(claim, NOW)
  await runner.runVerificationBatch(claim, NOW) // within reuse window: cache hit
  expect(cf.callsFor(ORIGIN)).toBe(1)
  const later = new Date(Date.parse(NOW) + VERIFICATION_RESPONSE_REUSE_MS + 1000).toISOString()
  await runner.runVerificationBatch(claim, later) // cache expired: refetch
  expect(cf.callsFor(ORIGIN)).toBe(2)
})

test('paused or blocked targets are never fetched', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's_blocked', ORIGIN, { governance: 'blocked' })
  seedVerificationJob(raw, ORIGIN, 's_blocked', ['li-1'])
  const cf = countingFetch({ [ORIGIN]: () => ok(RSS(guidItem('g1'))) })
  const runner = createVerificationRunner({ db, store, fetchFn: cf.fn, lookupFn: publicLookup, now: () => NOW })
  await runner.runVerificationBatch({ kind: 'verification', jobId: 'j', batchKey: ORIGIN }, NOW)
  expect(cf.calls()).toBe(0)

  // paused target: also never fetched
  raw.prepare(`UPDATE remote_sources_v2 SET governance = 'allowed', operation = 'paused' WHERE id = 's_blocked'`).run()
  await runner.runVerificationBatch({ kind: 'verification', jobId: 'j', batchKey: ORIGIN }, NOW)
  expect(cf.calls()).toBe(0)
})

test('the one async drain dispatches on kind: it reconciles observations AND fetches verification jobs', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f', { mode: 'aggregate' })
  await acquire(db, raw, 's_agg', 'https://agg.test/f', RSS(guidItem('g-agg', ORIGIN)))
  const cf = countingFetch({ [ORIGIN]: () => ok(RSS(guidItem('g-origin'))) })
  const runner = createVerificationRunner({ db, store, fetchFn: cf.fn, lookupFn: publicLookup, now: () => NOW })
  const done = await drainReconciliationAsync({
    store,
    now: () => NOW,
    runVerificationBatch: (i) => runner.runVerificationBatch(i.claim, i.now),
  })
  // the observation reconciled into a logical item AND scheduled + fetched verification
  expect(done).toBeGreaterThanOrEqual(1)
  expect(count(raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(1)
  expect(count(raw, 'verification_checks_v2', 'WHERE publisher_feed_url = ?', ORIGIN)).toBe(1)
  expect(cf.callsFor(ORIGIN)).toBe(1)
})
