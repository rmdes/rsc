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

// =============================================================================
// Task 5: outcomes, the verified rung, and publisher aliases
// =============================================================================

const ANON = { localAccountId: null, activeSourceIds: [] as string[] }

// A NewObservationVersion as the fetch would produce it (fresh ids, origin material).
function evidenceFor(opts: { permalink?: string | null; guid?: string | null; content?: string }): {
  normalizedPermalink: string | null; opaqueId: string | null
  evidence: { id: string; deliveryId: string; wireOrdinal: number; arrivalAt: string; fingerprintVersion: 1; fingerprint: string; canonicalMaterial: Uint8Array; rawEvidenceJson: string; normalizedJson: string }
} {
  const permalink = opts.permalink ?? null
  const guid = opts.guid ?? null
  const content = opts.content ?? 'd'
  const canonical = Buffer.from(JSON.stringify({ title: 't', content, link: permalink, inReplyTo: null }))
  const normalizedJson = JSON.stringify({ keyKind: guid ? 'opaque' : 'permalink', key: guid ?? permalink, permalink, inReplyTo: null, enclosures: [] })
  return {
    normalizedPermalink: permalink, opaqueId: guid,
    evidence: {
      id: randomUUID(), deliveryId: randomUUID(), wireOrdinal: 0, arrivalAt: NOW, fingerprintVersion: 1,
      fingerprint: createHash('sha256').update((permalink ?? guid ?? '') + content).digest('hex'),
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
