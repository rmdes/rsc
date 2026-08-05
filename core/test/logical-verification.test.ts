import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { drainReconciliation, drainReconciliationAsync, MAX_OPERATIONAL_ATTEMPTS } from '../src/logical/reconcile.ts'
import {
  scheduleVerification, createVerificationRunner, EMPTY_COUNTERS,
  VERIFICATION_MAX_NEW_PER_RESPONSE, VERIFICATION_MAX_PENDING_PER_PUBLISHER,
  VERIFICATION_MAX_PENDING_PER_SOURCE, VERIFICATION_RESPONSE_REUSE_MS,
} from '../src/logical/verification.ts'
import { presentationFingerprint } from '../src/logical/projector.ts'
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

// =============================================================================
// Task 5: outcomes, the verified rung, and publisher aliases
// =============================================================================

const ANON = { localAccountId: null, activeSourceIds: [] as string[] }

// A NewObservationVersion as the fetch would produce it (fresh ids, origin material).
function evidenceFor(opts: { permalink?: string | null; guid?: string | null; content?: string; updated?: string | null }): {
  normalizedPermalink: string | null; opaqueId: string | null
  evidence: { id: string; deliveryId: string; wireOrdinal: number; arrivalAt: string; fingerprintVersion: 1; fingerprint: string; canonicalMaterial: Uint8Array; rawEvidenceJson: string; normalizedJson: string }
} {
  const permalink = opts.permalink ?? null
  const guid = opts.guid ?? null
  const content = opts.content ?? 'd'
  const updated = opts.updated ?? null
  const canonical = Buffer.from(JSON.stringify({ title: 't', content, link: permalink, updated, inReplyTo: null }))
  const normalizedJson = JSON.stringify({ keyKind: guid ? 'opaque' : 'permalink', key: guid ?? permalink, permalink, inReplyTo: null, enclosures: [] })
  return {
    normalizedPermalink: permalink, opaqueId: guid,
    evidence: {
      id: randomUUID(), deliveryId: randomUUID(), wireOrdinal: 0, arrivalAt: NOW, fingerprintVersion: 1,
      fingerprint: createHash('sha256').update((permalink ?? guid ?? '') + content + (updated ?? '')).digest('hex'),
      canonicalMaterial: new Uint8Array(canonical), rawEvidenceJson: JSON.stringify({ title: 't', sourceName: null }), normalizedJson,
    },
  }
}

// Directly seed one pending check + its batch job (no fetch/drain), plus the
// aggregate item's identity keys the containment matcher reads.
function seedCheck(raw: Raw, opts: { itemId: string; sourceId: string; batchKey: string; permalink?: string; guid?: string; aggPub?: string; attempts?: number }): string {
  seedItem(raw, opts.itemId)
  if (opts.permalink) raw.prepare(`INSERT OR IGNORE INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('permalink', ?, ?)`).run(opts.permalink, opts.itemId)
  if (opts.guid) raw.prepare(`INSERT OR IGNORE INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES (?, ?, ?)`).run(`opaque:publisher:${opts.aggPub ?? 'p_agg'}`, opts.guid, opts.itemId)
  raw.prepare(`INSERT INTO verification_checks_v2 (id, logical_item_id, source_id, publisher_feed_url, batch_key, state, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`).run(randomUUID(), opts.itemId, opts.sourceId, opts.batchKey, opts.batchKey, NOW)
  const jobId = randomUUID()
  raw.prepare(`INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at) VALUES (?, 'verification', NULL, NULL, ?, 'processing', ?, ?, NULL, NULL, ?)`).run(jobId, opts.batchKey, opts.attempts ?? 0, NOW, NOW)
  return jobId
}

const fetched = (parsedItems: ReturnType<typeof evidenceFor>[], publisherRedirect: { fromUrl: string; toUrl: string } | null = null) =>
  ({ kind: 'fetched' as const, parsedItems, publisherRedirect })

// ---- outcomes: match, no-match, operational failure -------------------------

test('containment match by opaque id → check verified + a direct-origin verified_origin author under a find-or-created source', async () => {
  const { raw, db, store } = await fresh()
  // Full flow: an aggregate item carrying the origin feed URL; the origin feed
  // contains the same guid → containment holds.
  seedSource(raw, 's_agg', 'https://agg.test/f', { mode: 'aggregate' })
  await acquire(db, raw, 's_agg', 'https://agg.test/f', RSS(guidItem('g1', ORIGIN)))
  const cf = countingFetch({ [ORIGIN]: () => ok(RSS(guidItem('g1'))) })
  const runner = createVerificationRunner({ db, store, fetchFn: cf.fn, lookupFn: publicLookup, now: () => NOW })
  await drainReconciliationAsync({ store, now: () => NOW, runVerificationBatch: (i) => runner.runVerificationBatch(i.claim, i.now) })

  const li = (raw.prepare(`SELECT id FROM logical_items_v2 WHERE origin = 'remote' LIMIT 1`).get() as { id: string }).id
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = ?`).get(li) as { state: string }).state).toBe('verified')
  // find-or-created origin source with the verification defaults
  const origin = raw.prepare(`SELECT attribution_mode, operation, governance, provenance FROM remote_sources_v2 WHERE canonical_url = ?`).get(ORIGIN) as Record<string, string>
  expect(origin).toMatchObject({ attribution_mode: 'single_publisher', operation: 'enabled', governance: 'allowed', provenance: 'origin_verification' })
  // no federation relationship for the origin source
  expect(count(raw, 'federation_relationships_v2')).toBe(0)
  // the ordinary read now attributes the item to the verified origin
  const item = store.snapshot((tx) => tx.projectItem(li, ANON))!
  expect(item.selectedAuthor.kind === 'remote_publisher' && item.selectedAuthor.attributionLevel).toBe('verified_origin')
  // exactly one system-actor audit entry
  const audit = raw.prepare(`SELECT actor_kind, actor_id FROM item_audit_v2 WHERE logical_item_id = ?`).all(li) as { actor_kind: string; actor_id: string | null }[]
  expect(audit).toEqual([{ actor_kind: 'system', actor_id: null }])
})

test('a verified origin source always gets feed_anchored, even though the aggregate that asserted it does not', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f', { mode: 'aggregate' })
  await acquire(db, raw, 's_agg', 'https://agg.test/f', RSS(guidItem('g1', ORIGIN)))
  const cf = countingFetch({ [ORIGIN]: () => ok(RSS(guidItem('g1'))) })
  const runner = createVerificationRunner({ db, store, fetchFn: cf.fn, lookupFn: publicLookup, now: () => NOW })
  await drainReconciliationAsync({ store, now: () => NOW, runVerificationBatch: (i) => runner.runVerificationBatch(i.claim, i.now) })
  const aggPub = raw.prepare(`SELECT identity_level FROM remote_publishers_v2 WHERE canonical_feed_url = 'https://agg.test/f'`).get() as { identity_level: string }
  const originPub = raw.prepare(`SELECT identity_level FROM remote_publishers_v2 WHERE canonical_feed_url = ?`).get(ORIGIN) as { identity_level: string }
  expect(aggPub.identity_level).toBe('source_scoped_fallback')
  expect(originPub.identity_level).toBe('feed_anchored')
})

test('containment match by exact normalized permalink → verified', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const perma = 'https://origin.test/post/1'
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, permalink: perma })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ permalink: perma })]), now: NOW })
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('verified')
  expect(count(raw, 'publisher_claims_v2', "WHERE evidence_level = 'verified_origin'")).toBe(1)
})

test('title/timestamp similarity never matches — only the two convergence keys do', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  // parsed origin item shares the title but has a DIFFERENT guid and no permalink
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g-other' })]), now: NOW })
  const check = raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }
  expect(check.state).toBe('unverified')
  expect(count(raw, 'publisher_claims_v2')).toBe(0)
})

test('successful fetch with no match → terminal unverified, job reconciled, no retry, no evidence', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g-nope' })]), now: NOW })
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('unverified')
  const job = raw.prepare(`SELECT status, attempts FROM reconciliation_jobs_v2 WHERE id = ?`).get(jobId) as { status: string; attempts: number }
  expect(job).toMatchObject({ status: 'reconciled', attempts: 0 })
  expect(count(raw, 'deliveries_v2')).toBe(0)
})

test('a previously-terminal unverified check gets re-matched and promoted when a later batch fetch for the same URL succeeds', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  // First fetch for this URL doesn't contain li-1's guid (a timing race, the
  // real dev-data shape: the post hadn't propagated to the author's own feed
  // yet) -> terminal unverified.
  const jobId1 = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: jobId1, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g-other' })]), now: NOW })
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('unverified')

  // A second item asserts the same origin URL; this fetch DOES contain g1 ->
  // li-1 (previously stuck) should ALSO get promoted, not just li-2.
  const LATER = '2026-07-24T01:00:00.000Z'
  const jobId2 = seedCheck(raw, { itemId: 'li-2', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g2' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: jobId2, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1' }), evidenceFor({ guid: 'g2' })]), now: LATER })

  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('verified')
  expect(count(raw, 'publisher_claims_v2', "WHERE logical_item_id = 'li-1' AND evidence_level = 'verified_origin'")).toBe(1)
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-2'`).get() as { state: string }).state).toBe('verified')
})

test('a still-non-matching previously-unverified check stays unverified after an unrelated batch re-run', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const jobId1 = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: jobId1, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g-other' })]), now: NOW })
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('unverified')

  // A second batch fetch for the SAME url, still without g1's content.
  const jobId2 = seedCheck(raw, { itemId: 'li-2', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g2' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: jobId2, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g2' })]), now: NOW })

  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('unverified')
  expect(count(raw, 'publisher_claims_v2', "WHERE logical_item_id = 'li-1'")).toBe(0)
})

test('operational failure retries with backoff, and exhaustion → unverified', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  // one failure short of exhaustion (MAX_OPERATIONAL_ATTEMPTS = 8): still retrying
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1', attempts: 0 })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: { kind: 'operational_failure', category: 'network', diagnostic: 'x' }, now: NOW })
  expect((raw.prepare(`SELECT status FROM reconciliation_jobs_v2 WHERE id = ?`).get(jobId) as { status: string }).status).toBe('retrying')
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('pending')

  // pre-loaded to attempt 7 → the next operational failure exhausts to unverified
  raw.prepare(`UPDATE reconciliation_jobs_v2 SET attempts = 7, status = 'processing' WHERE id = ?`).run(jobId)
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: { kind: 'operational_failure', category: 'network', diagnostic: 'x' }, now: NOW })
  expect((raw.prepare(`SELECT status FROM reconciliation_jobs_v2 WHERE id = ?`).get(jobId) as { status: string }).status).toBe('failed')
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('unverified')
})

test('a verified origin of a QUARANTINED aggregate is itself quarantined — verified but never the ordinary display', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f', { governance: 'quarantined' })
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1' })]), now: NOW })
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('verified')
  // origin source inherited quarantine
  expect((raw.prepare(`SELECT governance FROM remote_sources_v2 WHERE canonical_url = ?`).get(ORIGIN) as { governance: string }).governance).toBe('quarantined')
  // ordinary read: the quarantined verified delivery participates in NEITHER comparator → item not ordinary-visible
  expect(store.snapshot((tx) => tx.projectItem('li-1', ANON))).toBeUndefined()
})

test('a hidden item stays hidden through verification success', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f', { mode: 'aggregate' })
  await acquire(db, raw, 's_agg', 'https://agg.test/f', RSS(guidItem('g1', ORIGIN)))
  drainReconciliation({ store, now: () => NOW })
  const li = (raw.prepare(`SELECT id FROM logical_items_v2 WHERE origin = 'remote' LIMIT 1`).get() as { id: string }).id
  raw.prepare(`UPDATE logical_items_v2 SET hidden_at = ? WHERE id = ?`).run(NOW, li)
  // the sync drain deferred the verification job one ms past NOW; claim it at a later now
  const later = new Date(Date.parse(NOW) + 1000).toISOString()
  const cf = countingFetch({ [ORIGIN]: () => ok(RSS(guidItem('g1'))) })
  const runner = createVerificationRunner({ db, store, fetchFn: cf.fn, lookupFn: publicLookup, now: () => later })
  await drainReconciliationAsync({ store, now: () => later, runVerificationBatch: (i) => runner.runVerificationBatch(i.claim, i.now) })
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = ?`).get(li) as { state: string }).state).toBe('verified')
  expect(store.snapshot((tx) => tx.projectItem(li, ANON))).toBeUndefined() // still hidden
})

test('verification changes no governance/federation/subscription of the asserting source', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const before = raw.prepare(`SELECT governance, operation FROM remote_sources_v2 WHERE id = 's_agg'`).get()
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1' })]), now: NOW })
  expect(raw.prepare(`SELECT governance, operation FROM remote_sources_v2 WHERE id = 's_agg'`).get()).toEqual(before)
  expect(count(raw, 'federation_relationships_v2')).toBe(0)
  expect(count(raw, 'source_subscriptions_v2')).toBe(0)
})

// ---- instance-governed members: the mint rule (spec 2026-07-25) -------------

function approveFederation(raw: Raw, sourceId: string): void {
  raw.prepare(`INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'approved', NULL, ?, ?)`).run(sourceId, NOW, NOW)
}

test('mint rule: an origin under an APPROVED ALLOWED instance is born allowed even when the asserting aggregate is quarantined', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_inst', 'https://origin.test/hub.xml', { governance: 'allowed' }) // instance, same prefix as ORIGIN
  approveFederation(raw, 's_inst')
  seedSource(raw, 's_agg', 'https://agg.test/f', { governance: 'quarantined' }) // asserting aggregate — cross-instance echo
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1' })]), now: NOW })
  expect((raw.prepare(`SELECT governance FROM remote_sources_v2 WHERE canonical_url = ?`).get(ORIGIN) as { governance: string }).governance).toBe('allowed')
})

test('mint rule: an origin under an APPROVED BLOCKED instance is born blocked', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_inst', 'https://origin.test/hub.xml', { governance: 'blocked' })
  approveFederation(raw, 's_inst')
  seedSource(raw, 's_agg', 'https://agg.test/f') // asserting aggregate, allowed
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1' })]), now: NOW })
  expect((raw.prepare(`SELECT governance FROM remote_sources_v2 WHERE canonical_url = ?`).get(ORIGIN) as { governance: string }).governance).toBe('blocked')
})

test('mint rule: with no approved instance covering the origin, it inherits the asserting aggregate governance (regression pin)', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f', { governance: 'quarantined' }) // no instance federated over origin.test at all
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1' })]), now: NOW })
  expect((raw.prepare(`SELECT governance FROM remote_sources_v2 WHERE canonical_url = ?`).get(ORIGIN) as { governance: string }).governance).toBe('quarantined')
})

// ---- publisher aliases (spec §1.6, §4.3) ------------------------------------

test('a verified direct-origin permanent redirect writes one publisher_feed_aliases_v2 row', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  const to = 'https://origin.test/new-feed.xml'
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1' })], { fromUrl: ORIGIN, toUrl: to }), now: NOW })
  const alias = raw.prepare(`SELECT url, publisher_id FROM publisher_feed_aliases_v2`).all() as { url: string; publisher_id: string }[]
  expect(alias).toHaveLength(1)
  const originPub = (raw.prepare(`SELECT id FROM remote_publishers_v2 WHERE canonical_feed_url = ?`).get(ORIGIN) as { id: string }).id
  expect(alias[0]).toMatchObject({ url: to, publisher_id: originPub })
})

test('a redirect with NO containment match merges no publisher (aggregate redirect never merges)', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g-nope' })], { fromUrl: ORIGIN, toUrl: 'https://origin.test/x' }), now: NOW })
  expect(count(raw, 'publisher_feed_aliases_v2')).toBe(0)
})

test('an alias collision records a conflict and merges nothing', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const to = 'https://origin.test/new-feed.xml'
  raw.prepare(`INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES ('p_other', 'https://other.test/f', 'feed_anchored', ?)`).run(NOW)
  raw.prepare(`INSERT INTO publisher_feed_aliases_v2 (url, publisher_id, created_at) VALUES (?, 'p_other', ?)`).run(to, NOW)
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1' })], { fromUrl: ORIGIN, toUrl: to }), now: NOW })
  // the alias still points at p_other — nothing merged
  expect((raw.prepare(`SELECT publisher_id FROM publisher_feed_aliases_v2 WHERE url = ?`).get(to) as { publisher_id: string }).publisher_id).toBe('p_other')
  expect(count(raw, 'logical_conflicts_v2', "WHERE kind = 'publisher_alias_collision'")).toBe(1)
})

// ---- convergence on ONE origin delivery + drain resilience ------------------

test('two logical items matching the SAME origin entry converge on ONE delivery — no UNIQUE collision', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  // Two aggregators carry the same guid-only item and name the same origin feed.
  // Opaque scope is per-publisher, so they are two DISTINCT logical items — and
  // matchContainment's pooled `opaque:%` lookup matches BOTH to the SAME parsed
  // origin entry, i.e. the same (origin source, 'opaque', 'g1') delivery key.
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1', aggPub: 'p_a' })
  seedCheck(raw, { itemId: 'li-2', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1', aggPub: 'p_b' }) // its own job row stays inert
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1' })]), now: NOW })

  expect((raw.prepare(`SELECT COUNT(*) AS n FROM verification_checks_v2 WHERE state = 'verified'`).get() as { n: number }).n).toBe(2)
  expect(count(raw, 'deliveries_v2')).toBe(1) // ONE origin delivery, not two
  expect(count(raw, 'observation_versions_v2')).toBe(1)
  expect(count(raw, 'publisher_claims_v2', "WHERE evidence_level = 'verified_origin'")).toBe(2) // one per item
  expect((raw.prepare(`SELECT status FROM reconciliation_jobs_v2 WHERE id = ?`).get(jobId) as { status: string }).status).toBe('reconciled')
})

test('a throwing verification batch records a failure and leaves the job claimable — never stranded at processing', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1' })
  raw.prepare(`UPDATE reconciliation_jobs_v2 SET status = 'pending' WHERE id = ?`).run(jobId)

  // ANY throw out of the batch (collision, parse, DB) must not escape the drain:
  // a job stranded at 'processing' can never be re-claimed AND blocks every future
  // job for that batch key (scheduleVerification's active-job dedup).
  const done = await drainReconciliationAsync({
    store, now: () => NOW,
    runVerificationBatch: async () => { throw new Error('boom') },
  })
  expect(done).toBe(0)
  const job = raw.prepare(`SELECT status, attempts, next_attempt_at FROM reconciliation_jobs_v2 WHERE id = ?`).get(jobId) as { status: string; attempts: number; next_attempt_at: string }
  expect(job).toMatchObject({ status: 'retrying', attempts: 1 })
  expect(Date.parse(job.next_attempt_at)).toBeGreaterThan(Date.parse(NOW))
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = 'li-1'`).get() as { state: string }).state).toBe('pending')
  // still claimable once the backoff elapses
  expect(store.claimReconciliation(job.next_attempt_at)?.jobId).toBe(jobId)
})

// ---- exhaustion through the drain's CATCH path (not the outcome path) --------

type Store = Awaited<ReturnType<typeof fresh>>['store']

// Drain repeatedly, following the job's own backoff, until it terminalizes or the
// attempt ceiling is spent. `throwFor` decides which batch key the batch throws on;
// every other verification job is a no-op (left claimed, its checks still pending).
// Returns the clock the LAST failure was recorded at.
async function drainToExhaustion(raw: Raw, store: Store, batchKey: string, throwFor = (k: string) => k === batchKey, limit = MAX_OPERATIONAL_ATTEMPTS): Promise<string> {
  let clock = NOW
  for (let i = 0; i < limit; i++) {
    await drainReconciliationAsync({
      store, now: () => clock,
      runVerificationBatch: async ({ claim }) => { if (throwFor(claim.batchKey)) throw new Error('boom') },
    })
    const j = raw.prepare(`SELECT status, next_attempt_at FROM reconciliation_jobs_v2 WHERE kind = 'verification' AND verification_batch_key = ?`).get(batchKey) as { status: string; next_attempt_at: string }
    if (j.status === 'failed') break
    clock = j.next_attempt_at
  }
  return clock
}

test('a verification job exhausting through the drain catch path terminalizes its still-pending checks', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  seedVerificationJob(raw, ORIGIN, 's_agg', ['li-1', 'li-2'])

  const at = await drainToExhaustion(raw, store, ORIGIN)

  const job = raw.prepare(`SELECT status, attempts, failure_category FROM reconciliation_jobs_v2 WHERE kind = 'verification'`).get() as { status: string; attempts: number; failure_category: string | null }
  expect(job).toMatchObject({ status: 'failed', attempts: MAX_OPERATIONAL_ATTEMPTS, failure_category: 'operational_exhausted' })
  // the checks must NOT be left pending: pending rows consume the scheduling caps forever
  const checks = raw.prepare(`SELECT state, resolved_at FROM verification_checks_v2 WHERE batch_key = ?`).all(ORIGIN) as { state: string; resolved_at: string | null }[]
  expect(checks).toHaveLength(2)
  for (const c of checks) expect(c).toEqual({ state: 'unverified', resolved_at: at })
})

test('checks of an exhausted verification job release the per-source distinct-URL cap', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  // exactly at the distinct-URL cap: 25 pending URLs for this source
  for (let i = 0; i < VERIFICATION_MAX_NEW_PER_RESPONSE; i++) {
    seedItem(raw, `li-${i}`)
    db.write((tx) => scheduleVerification(tx, { logicalItemId: `li-${i}`, sourceId: 's_agg', publisherFeedUrl: `https://origin${i}.test/f`, now: NOW }))
  }
  const extra = `https://origin${VERIFICATION_MAX_NEW_PER_RESPONSE}.test/f`
  seedItem(raw, 'li-extra')
  db.write((tx) => scheduleVerification(tx, { logicalItemId: 'li-extra', sourceId: 's_agg', publisherFeedUrl: extra, now: NOW }))
  expect(count(raw, 'verification_checks_v2', 'WHERE publisher_feed_url = ?', extra)).toBe(0) // cap boundary: dropped

  // exhaust ONE batch key through the drain's catch path
  const victim = 'https://origin0.test/f'
  await drainToExhaustion(raw, store, victim)
  expect((raw.prepare(`SELECT status FROM reconciliation_jobs_v2 WHERE verification_batch_key = ?`).get(victim) as { status: string }).status).toBe('failed')

  // one distinct URL freed → the previously-capped URL is schedulable again
  expect((raw.prepare(`SELECT COUNT(DISTINCT publisher_feed_url) AS n FROM verification_checks_v2 WHERE source_id = 's_agg' AND state = 'pending'`).get() as { n: number }).n).toBe(VERIFICATION_MAX_NEW_PER_RESPONSE - 1)
  db.write((tx) => scheduleVerification(tx, { logicalItemId: 'li-extra', sourceId: 's_agg', publisherFeedUrl: extra, now: NOW }))
  expect(count(raw, 'verification_checks_v2', 'WHERE publisher_feed_url = ?', extra)).toBe(1)
})

test('a NON-exhausting verification failure leaves its checks pending for the retry', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  seedVerificationJob(raw, ORIGIN, 's_agg', ['li-1'])

  await drainToExhaustion(raw, store, ORIGIN, undefined, MAX_OPERATIONAL_ATTEMPTS - 1) // one short of the ceiling

  const job = raw.prepare(`SELECT status, attempts FROM reconciliation_jobs_v2 WHERE kind = 'verification'`).get() as { status: string; attempts: number }
  expect(job).toMatchObject({ status: 'retrying', attempts: MAX_OPERATIONAL_ATTEMPTS - 1 })
  // terminalizing here would silently kill a verification the retry could still resolve
  expect(raw.prepare(`SELECT state, resolved_at FROM verification_checks_v2 WHERE batch_key = ?`).get(ORIGIN)).toEqual({ state: 'pending', resolved_at: null })
})

// ---- the presentation entry a verified delivery writes (spec §4.4) ----------
// A verified delivery's presentation entry must be indistinguishable in shape
// from an acquisition-written one: it runs the SAME shared applyPresentation
// path — real effective_updated_at + provenance, the unchanged-material and
// rollback-watermark decisions included.

const entries = (raw: Raw) =>
  raw.prepare(`SELECT sequence, effective_updated_at, provenance, material_fingerprint FROM presentation_entries_v2 ORDER BY sequence`).all() as
    { sequence: number; effective_updated_at: string | null; provenance: string | null; material_fingerprint: string }[]

test('a verified delivery baseline carries the explicit updated timestamp, on the normalized permalink', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const perma = 'https://origin.test/post/1#frag'
  const updated = '2026-07-23T00:00:00.000Z'
  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, permalink: perma })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ permalink: perma, updated })]), now: NOW })

  const rows = entries(raw)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ sequence: 0, effective_updated_at: updated, provenance: 'explicit' })
  // the fingerprint is taken over the NORMALIZED permalink, exactly as acquisition does
  const fpOf = (link: string | null) => presentationFingerprint({ title: 't', content: 'd', contentMarkdown: null, permalink: link, sourceLink: perma, enclosures: [], inReplyTo: null })
  expect(rows[0].material_fingerprint).toBe(fpOf('https://origin.test/post/1'))
  expect(rows[0].material_fingerprint).not.toBe(fpOf(perma))
})

test('unchanged presentation material on a re-verified delivery writes NO new entry', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const j1 = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1', aggPub: 'p_a' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: j1, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1' })]), now: NOW })
  // a later re-verification of the SAME origin entry: new observation material
  // (its <updated> moved) but identical presentation material.
  const j2 = seedCheck(raw, { itemId: 'li-2', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1', aggPub: 'p_b' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: j2, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1', updated: '2026-07-23T00:00:00.000Z' })]), now: NOW })

  expect(count(raw, 'deliveries_v2')).toBe(1)
  expect(count(raw, 'observation_versions_v2')).toBe(1) // phase B: overwritten in place, never a second row
  expect(entries(raw)).toHaveLength(1) // unchanged presentation ⇒ no second entry
})

test('a re-verified delivery with changed material and an at-or-below explicit timestamp records presentation_rollback and writes no entry', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const j1 = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1', aggPub: 'p_a' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: j1, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1', updated: '2026-07-23T00:00:00.000Z' })]), now: NOW })
  const j2 = seedCheck(raw, { itemId: 'li-2', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1', aggPub: 'p_b' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: j2, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1', content: 'edited', updated: '2026-07-22T00:00:00.000Z' })]), now: NOW })

  expect(count(raw, 'logical_conflicts_v2', "WHERE kind = 'presentation_rollback'")).toBe(1)
  const rows = entries(raw)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ sequence: 0, effective_updated_at: '2026-07-23T00:00:00.000Z', provenance: 'explicit' })
})

test('re-verifying EDITED origin material on an existing delivery overwrites the ONE version in place (I4) — no UNIQUE throw, one re-pended job, bounded claims', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')
  const j1 = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1', aggPub: 'p_a' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: j1, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1' })]), now: NOW })
  const versionIdAfterFirst = (raw.prepare(`SELECT id FROM observation_versions_v2`).get() as { id: string }).id
  // delivery exists, NEW fingerprint branch: edited material, no <updated>.
  const j2 = seedCheck(raw, { itemId: 'li-2', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1', aggPub: 'p_b' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId: j2, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1', content: 'edited' })]), now: NOW })

  expect(count(raw, 'deliveries_v2')).toBe(1)
  expect(count(raw, 'observation_versions_v2')).toBe(1) // overwritten in place, same id
  expect((raw.prepare(`SELECT id FROM observation_versions_v2`).get() as { id: string }).id).toBe(versionIdAfterFirst)
  const rows = entries(raw)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ sequence: 0, effective_updated_at: NOW, provenance: 'arrival' })
  // the observation job is re-pended (I4), not appended
  expect(count(raw, 'reconciliation_jobs_v2', "WHERE kind = 'observation'")).toBe(1)
  expect((raw.prepare(`SELECT status FROM reconciliation_jobs_v2 WHERE kind = 'observation'`).get() as { status: string }).status).toBe('pending')
  // bounded claims: one row per converging item (li-1, li-2), never accumulating
  expect(count(raw, 'publisher_claims_v2')).toBe(2)

  // Running the ordinary drain (which now picks up the re-pended job) must NOT
  // downgrade li-1's already-verified claim — the reconcile.ts guard this task
  // adds (an ordinary reconcileClaim pass only ever computes
  // aggregate_assertion/bound_single_publisher, never verified_origin).
  drainReconciliation({ store, now: () => NOW })
  const claims = raw.prepare(`SELECT logical_item_id, evidence_level FROM publisher_claims_v2 ORDER BY logical_item_id`).all() as { logical_item_id: string; evidence_level: string }[]
  expect(claims).toEqual([
    { logical_item_id: 'li-1', evidence_level: 'verified_origin' },
    { logical_item_id: 'li-2', evidence_level: 'verified_origin' },
  ])
  expect(count(raw, 'publisher_claims_v2')).toBe(2) // the drain updates in place, never appends
})

// Review fix: a cap-era (or otherwise not-yet-collapsed) delivery can carry MORE
// than one observation_versions_v2 row for the same delivery_id — the version cap
// only stopped growing further, it never collapsed existing chains (that's Task
// 4's migration). persistVerifiedDelivery's lookup must resolve the CURRENT-
// DISPLAY version (the one backing the top-sequence presentation entry), never an
// arbitrary sibling via an unordered `WHERE delivery_id = ?` scan — hand-seed
// exactly that pre-existing multi-sibling shape (repeated persistVerifiedDelivery
// calls always converge on ONE version, so it can't build this state itself).
test('persistVerifiedDelivery on a delivery with a pre-existing sibling version resolves the CURRENT-DISPLAY one, not an arbitrary sibling', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's_agg', 'https://agg.test/f')

  const runId = 'r0'
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES ('s_origin', ?, 'single_publisher', 'enabled', 'allowed', 'origin_verification', NULL, 0, ?)`,
  ).run(ORIGIN, NOW)
  raw.prepare(
    `INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json)
     VALUES (?, 's_origin', 'scheduled', 'terminal', ?, ?, ?, 'parsed', ?, NULL, NULL, NULL)`,
  ).run(runId, NOW, NOW, NOW, EMPTY_COUNTERS)
  raw.prepare(
    `INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count)
     VALUES ('d1', 's_origin', 'opaque', 'g1', ?, ?, ?, 2)`,
  ).run(NOW, NOW, runId)
  // the sibling: an OLDER version with NO presentation entry (fingerprint sorts
  // FIRST, so an unordered `WHERE delivery_id = ?` scan hits it before current).
  raw.prepare(
    `INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json)
     VALUES ('v-sibling', 'd1', 1, 'aaa-sibling-fingerprint', ?, ?, ?, 0, ?, ?, 1, '{}', '{}')`,
  ).run(Buffer.from('sibling-material'), NOW, runId, NOW, runId)
  // the CURRENT-DISPLAY version: has the delivery's one presentation entry.
  raw.prepare(
    `INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json)
     VALUES ('v-current', 'd1', 1, 'zzz-current-fingerprint', ?, ?, ?, 0, ?, ?, 1, '{}', '{}')`,
  ).run(Buffer.from('current-material-stale'), NOW, runId, NOW, runId)
  raw.prepare(
    `INSERT INTO presentation_entries_v2 (delivery_id, sequence, observation_version_id, effective_updated_at, provenance, material_fingerprint)
     VALUES ('d1', 0, 'v-current', NULL, NULL, 'placeholder-fingerprint')`,
  ).run()
  raw.prepare(
    `INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at)
     VALUES ('j-current', 'observation', ?, 'v-current', NULL, 'reconciled', 0, ?, NULL, NULL, ?)`,
  ).run(runId, NOW, NOW)

  const jobId = seedCheck(raw, { itemId: 'li-1', sourceId: 's_agg', batchKey: ORIGIN, guid: 'g1', aggPub: 'p_a' })
  store.resolveVerificationBatch({ claim: { kind: 'verification', jobId, batchKey: ORIGIN }, outcome: fetched([evidenceFor({ guid: 'g1', content: 'fresh-content' })]), now: NOW })

  // no new sibling, no stray second presentation entry
  expect(count(raw, 'observation_versions_v2')).toBe(2)
  expect(count(raw, 'presentation_entries_v2', "WHERE delivery_id = 'd1'")).toBe(1)
  const entry = raw.prepare(`SELECT observation_version_id, effective_updated_at, provenance FROM presentation_entries_v2 WHERE delivery_id = 'd1'`).get() as { observation_version_id: string; effective_updated_at: string | null; provenance: string | null }
  expect(entry).toMatchObject({ observation_version_id: 'v-current', effective_updated_at: NOW, provenance: 'arrival' })

  // the CURRENT-DISPLAY version was overwritten (fresh content now visible)
  const cur = raw.prepare(`SELECT fingerprint, canonical_material FROM observation_versions_v2 WHERE id = 'v-current'`).get() as { fingerprint: string; canonical_material: Buffer }
  expect(cur.fingerprint).not.toBe('zzz-current-fingerprint')
  expect(Buffer.from(cur.canonical_material).toString('utf8')).not.toBe('current-material-stale')
  expect((raw.prepare(`SELECT status FROM reconciliation_jobs_v2 WHERE observation_version_id = 'v-current'`).get() as { status: string }).status).toBe('pending') // re-pended (I4)

  // the sibling is completely untouched — no overwrite, no presentation entry
  const sib = raw.prepare(`SELECT fingerprint, canonical_material FROM observation_versions_v2 WHERE id = 'v-sibling'`).get() as { fingerprint: string; canonical_material: Buffer }
  expect(sib.fingerprint).toBe('aaa-sibling-fingerprint')
  expect(Buffer.from(sib.canonical_material).toString('utf8')).toBe('sibling-material')
  expect(count(raw, 'presentation_entries_v2', "WHERE observation_version_id = 'v-sibling'")).toBe(0)
})
