import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { drainReconciliation, retryDelayMs, MAX_OPERATIONAL_ATTEMPTS } from '../src/logical/reconcile.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-23T00:00:00.000Z'
const LATER = '2026-07-23T01:00:00.000Z'

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
  ).run(id, url, opts.mode ?? 'single_publisher', opts.operation ?? 'enabled', opts.governance ?? 'allowed', NOW)
}

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const ok = (body: string): Response => new Response(body, { status: 200 })
function fakeFetch(map: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const h = map[url]
    if (!h) throw new Error(`no route: ${url}`)
    return await h()
  }) as unknown as typeof fetch
}

const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed T</title>${items}</channel></rss>`
const guidItem = (guid: string, body = 'd'): string => `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>${body}</description></item>`
const linkItem = (link: string, body = 'd'): string => `<item><link>${link}</link><title>t</title><description>${body}</description></item>`

// Acquire (real fetch->parse->commit) then reconcile the whole queue.
async function acquire(db: ReturnType<typeof createDatabaseContext>, raw: Raw, sourceId: string, url: string, body: string, now = NOW): Promise<void> {
  const eng = createAcquisition({ db, fetchFn: fakeFetch({ [url]: () => ok(body) }), lookupFn: publicLookup, now: () => now })
  await eng.acquireSource(sourceId, { kind: 'scheduled' }, undefined)
}

// White-box: insert a run + delivery + observation version + pending job directly,
// so precise convergence/ordering/failure cases need no crafted network body.
function seedJob(raw: Raw, input: {
  sourceId: string; deliveryKey: { kind: string; key: string }; committedAt: string; wireOrdinal?: number
  material?: { title?: string | null; content?: string; permalink?: string | null; published?: string; updated?: string | null; inReplyTo?: string | null }
  runId?: string; deliveryId?: string
}): { jobId: string; versionId: string; runId: string; deliveryId: string } {
  const runId = input.runId ?? randomUUID()
  const deliveryId = input.deliveryId ?? randomUUID()
  const versionId = randomUUID()
  const jobId = randomUUID()
  const m = input.material ?? {}
  const material = { v: 1, keyKind: input.deliveryKey.kind, key: input.deliveryKey.key, title: m.title ?? 't', content: m.content ?? 'body', link: m.permalink ?? null, published: m.published ?? '', updated: m.updated ?? null, inReplyTo: m.inReplyTo ?? null, enclosures: [] }
  const canonical = Buffer.from(JSON.stringify(material), 'utf8')
  const fingerprint = createHash('sha256').update(canonical).digest('hex')
  const normalized = JSON.stringify({ keyKind: input.deliveryKey.kind, key: input.deliveryKey.key, permalink: m.permalink ?? null, inReplyTo: m.inReplyTo ?? null, enclosures: [] })
  const raw_evidence = JSON.stringify({ title: m.title ?? 't', sourceName: 'Feed T', link: m.permalink ?? null, published: m.published ?? '', updated: m.updated ?? null, enclosureCount: 0 })
  if (!raw.prepare(`SELECT id FROM acquisition_runs_v2 WHERE id = ?`).get(runId)) {
    raw.prepare(`INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json) VALUES (?, ?, 'scheduled', 'terminal', ?, ?, ?, 'parsed', '{}', NULL, NULL, NULL)`).run(runId, input.sourceId, input.committedAt, input.committedAt, input.committedAt)
  }
  if (!raw.prepare(`SELECT id FROM deliveries_v2 WHERE id = ?`).get(deliveryId)) {
    raw.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(deliveryId, input.sourceId, input.deliveryKey.kind, input.deliveryKey.key, input.committedAt, input.committedAt, runId)
  }
  raw.prepare(`INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(versionId, deliveryId, fingerprint, canonical, input.committedAt, runId, input.wireOrdinal ?? 0, input.committedAt, runId, raw_evidence, normalized)
  raw.prepare(`INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at) VALUES (?, 'observation', ?, ?, NULL, 'pending', 0, ?, NULL, NULL, ?)`).run(jobId, runId, versionId, input.committedAt, input.committedAt)
  return { jobId, versionId, runId, deliveryId }
}

const drain = (store: ReturnType<typeof createLogicalStore>, now = NOW): number => drainReconciliation({ store, now: () => now })

// ---- the drain reconciles a pending observation into a logical item ---------

test('the drain reconciles a pending job into one remote logical item, publisher, claim, presentation entry, and identity keys', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, raw, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  const reconciled = drain(store)

  expect(reconciled).toBe(1)
  expect(count(raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(1)
  const item = raw.prepare(`SELECT id, timeline_sort_at, selected_delivery_id, selected_publisher_id FROM logical_items_v2`).get() as { id: string; timeline_sort_at: string; selected_delivery_id: string | null; selected_publisher_id: string | null }
  expect(count(raw, 'remote_publishers_v2')).toBe(1)
  expect(count(raw, 'publisher_claims_v2', 'WHERE logical_item_id = ?', item.id)).toBe(1)
  expect(count(raw, 'publisher_names_v2')).toBe(1)
  expect(count(raw, 'presentation_entries_v2')).toBe(1)
  expect(count(raw, 'logical_identity_keys_v2', "WHERE kind LIKE 'opaque:publisher:%'")).toBe(1)
  // job terminalised reconciled; the run's presentation hint points at the delivery
  expect((raw.prepare(`SELECT status FROM reconciliation_jobs_v2`).get() as { status: string }).status).toBe('reconciled')
  expect(item.selected_delivery_id).toBeTruthy()
  expect(item.selected_publisher_id).toBe((raw.prepare(`SELECT id FROM remote_publishers_v2`).get() as { id: string }).id)
})

test('a single_publisher source yields a bound_single_publisher claim; an aggregate source yields aggregate_assertion', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's_bound', 'https://a.test/f', { mode: 'single_publisher' })
  seedSource(raw, 's_agg', 'https://b.test/f', { mode: 'aggregate' })
  await acquire(db, raw, 's_bound', 'https://a.test/f', RSS(guidItem('g1')))
  await acquire(db, raw, 's_agg', 'https://b.test/f', RSS(guidItem('g2')))
  drain(store)
  const levels = (raw.prepare(`SELECT source_id, evidence_level FROM publisher_claims_v2`).all() as { source_id: string; evidence_level: string }[])
  expect(levels.find((l) => l.source_id === 's_bound')?.evidence_level).toBe('bound_single_publisher')
  expect(levels.find((l) => l.source_id === 's_agg')?.evidence_level).toBe('aggregate_assertion')
})

// ---- convergence (spec §2.5) ------------------------------------------------

test('two different sources delivering the same permalink converge to ONE logical item', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://agg1.test/f')
  seedSource(raw, 's2', 'https://agg2.test/f')
  await acquire(db, raw, 's1', 'https://agg1.test/f', RSS(linkItem('https://blog.test/p1')))
  await acquire(db, raw, 's2', 'https://agg2.test/f', RSS(linkItem('https://blog.test/p1')))
  drain(store)
  expect(count(raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(1)
  expect(count(raw, 'logical_identity_keys_v2', "WHERE kind = 'permalink'")).toBe(1)
  // both deliveries map to the one item via their own 'delivery' identity keys
  expect(count(raw, 'logical_identity_keys_v2', "WHERE kind = 'delivery'")).toBe(2)
})

test('re-delivery of the same opaque item creates no second logical item and no duplicate presentation entry', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, raw, 's1', 'https://feed.test/f', RSS(guidItem('g1')), NOW)
  drain(store, NOW)
  await acquire(db, raw, 's1', 'https://feed.test/f', RSS(guidItem('g1')), LATER) // unchanged refetch
  drain(store, LATER)
  expect(count(raw, 'logical_items_v2')).toBe(1)
  expect(count(raw, 'presentation_entries_v2')).toBe(1)
})

// ---- local-first (spec §2.6) ------------------------------------------------

test('a remote permalink colliding with a canonical local permalink is a conflict and creates NO second ordinary item', async () => {
  const { raw, db, store } = await fresh()
  // a local logical item claiming permalink '/post/local1'
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES ('local1', 'local', ?, 'none', NULL, NULL, NULL, ?)`).run(NOW, NOW)
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('permalink', 'https://feed.test/local1', 'local1')`).run()
  seedSource(raw, 's1', 'https://feed.test/f')
  seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'permalink', key: 'https://feed.test/local1' }, committedAt: NOW, material: { permalink: 'https://feed.test/local1' } })
  drain(store)
  expect(count(raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(0) // no second item
  expect(count(raw, 'logical_conflicts_v2')).toBe(1)
  expect((raw.prepare(`SELECT status FROM reconciliation_jobs_v2`).get() as { status: string }).status).toBe('conflicted')
})

test('a remote item colliding with a deleted_local marker records a conflict and does not resurrect it', async () => {
  const { raw, db, store } = await fresh()
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES ('dead1', 'local', ?, 'none', NULL, NULL, NULL, ?)`).run(NOW, NOW)
  raw.prepare(`INSERT INTO logical_deleted_local_v2 (logical_item_id, canonical_permalink, deleted_at) VALUES ('dead1', 'https://feed.test/dead1', ?)`).run(NOW)
  seedSource(raw, 's1', 'https://feed.test/f')
  seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'permalink', key: 'https://feed.test/dead1' }, committedAt: NOW, material: { permalink: 'https://feed.test/dead1' } })
  drain(store)
  expect(count(raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(0)
  expect(count(raw, 'presentation_entries_v2')).toBe(0) // never displayed
  expect(count(raw, 'logical_conflicts_v2')).toBe(1)
})

test('a remote permalink colliding with an UNMATERIALIZED local post records a conflict, materializes the bridge row, and merges nothing', async () => {
  const { raw, store } = await fresh()
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES ('u1','person','alice','Alice',NULL,?)`).run(NOW)
  // a canonical local post WITH NO logical bridge row materialized (the default state)
  raw.prepare(`INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at) VALUES ('p1','u1','local',?,NULL,'hello','https://feed.test/p1',?,?)`).run(randomUUID(), NOW, NOW)
  expect(count(raw, 'logical_items_v2')).toBe(0) // unmaterialized: no bridge row yet
  seedSource(raw, 's1', 'https://feed.test/f')
  seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'permalink', key: 'https://feed.test/p1' }, committedAt: NOW, material: { permalink: 'https://feed.test/p1' } })
  const done = drain(store)
  expect(done).toBe(1) // a SUCCESSFUL conflicted outcome, not an operational failure
  expect((raw.prepare(`SELECT status FROM reconciliation_jobs_v2`).get() as { status: string }).status).toBe('conflicted')
  expect(count(raw, 'logical_conflicts_v2')).toBe(1)
  // the local post's bridge row was materialized so the conflict FK holds; exactly ONE local item, NO remote item
  expect(count(raw, 'logical_items_v2', "WHERE id = 'p1' AND origin = 'local'")).toBe(1)
  expect(count(raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(0)
  expect(count(raw, 'logical_items_v2')).toBe(1)
  // the remote delivery did NOT attach to the local item as ordinary content
  expect(count(raw, 'logical_identity_keys_v2', "WHERE kind = 'delivery'")).toBe(0)
  expect(count(raw, 'presentation_entries_v2')).toBe(0)
})

// ---- journal de-noise (spec §2.5, §5.1): upsert only on a visible change ------

test('a genuine presentation change emits exactly one journal upsert carrying the presentation mask', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, raw, 's1', 'https://feed.test/f', RSS(guidItem('g1')), NOW)
  drain(store, NOW)
  const afterFirst = count(raw, 'logical_journal_v2')
  expect(afterFirst).toBe(1) // first reconcile: one upsert
  await acquire(db, raw, 's1', 'https://feed.test/f', RSS(guidItem('g1', 'CHANGED')), LATER)
  drain(store, LATER)
  expect(count(raw, 'logical_journal_v2')).toBe(afterFirst + 1) // exactly one new upsert
  const last = raw.prepare(`SELECT kind, change_mask FROM logical_journal_v2 ORDER BY sequence DESC LIMIT 1`).get() as { kind: string; change_mask: number }
  expect(last.kind).toBe('upsert')
  expect(last.change_mask).toBe(1) // presentation bit
})

test('reconciling a new observation version that changes nothing visible appends no new journal row', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const first = seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'g1' }, committedAt: NOW, material: { content: 'body', published: '2026-01-01T00:00:00.000Z' } })
  drain(store, NOW)
  const afterFirst = count(raw, 'logical_journal_v2')
  expect(afterFirst).toBe(1)
  // a NEW observation version of the SAME delivery, differing only in published time
  // (not part of the presentation fingerprint, not an explicit update) — nothing visible changes
  seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'g1' }, committedAt: LATER, material: { content: 'body', published: '2026-02-01T00:00:00.000Z' }, deliveryId: first.deliveryId })
  drain(store, LATER)
  expect(count(raw, 'logical_journal_v2')).toBe(afterFirst) // no visible change -> no journal churn
})

// ---- cross-key disagreement (spec §2.5): isolated item, claims NEITHER key ---

test('when permalink and publisher-opaque resolve to different items the delivery is isolated and claims neither disputed key', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  // pre-existing remote items X (owns the opaque key) and Y (owns the permalink)
  const pub = randomUUID()
  raw.prepare(`INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, 'https://feed.test/f', 'feed_anchored', ?)`).run(pub, NOW)
  for (const id of ['itemX', 'itemY']) raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'remote', ?, 'none', NULL, NULL, NULL, ?)`).run(id, NOW, NOW)
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES (?, 'g1', 'itemX')`).run(`opaque:publisher:${pub}`)
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('permalink', 'https://feed.test/p1', 'itemY')`).run()
  // a delivery keyed opaque g1, whose material also carries permalink p1
  seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'g1' }, committedAt: NOW, material: { permalink: 'https://feed.test/p1' } })
  drain(store)
  expect(count(raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(3) // X, Y, plus one ISOLATED new item
  expect(count(raw, 'logical_conflicts_v2')).toBe(1)
  // neither disputed key was re-pointed
  expect((raw.prepare(`SELECT logical_item_id FROM logical_identity_keys_v2 WHERE kind=? AND key='g1'`).get(`opaque:publisher:${pub}`) as { logical_item_id: string }).logical_item_id).toBe('itemX')
  expect((raw.prepare(`SELECT logical_item_id FROM logical_identity_keys_v2 WHERE kind='permalink' AND key='https://feed.test/p1'`).get() as { logical_item_id: string }).logical_item_id).toBe('itemY')
  expect((raw.prepare(`SELECT status FROM reconciliation_jobs_v2`).get() as { status: string }).status).toBe('conflicted')
})

// ---- job failure bookkeeping is separate from logical effects (spec §2.3) ----

test('retryDelayMs follows min(5s * 2^(attempt-1), 15min) and eight failures exhaust', () => {
  expect(retryDelayMs(1)).toBe(5000)
  expect(retryDelayMs(2)).toBe(10000)
  expect(retryDelayMs(7)).toBe(320000) // longest under the cap
  expect(retryDelayMs(20)).toBe(900000) // capped at 15 minutes
  expect(MAX_OPERATIONAL_ATTEMPTS).toBe(8)
})

test('an operational failure increments the attempt and reschedules; the eighth is terminal operational_exhausted', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const { jobId } = seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'g1' }, committedAt: NOW, material: {} })
  for (let i = 1; i <= 7; i++) store.recordReconciliationFailure({ jobId, now: NOW, category: 'operational_exhausted', diagnostic: 'op', retryAt: null })
  const retrying = raw.prepare(`SELECT status, attempts, next_attempt_at, failure_category FROM reconciliation_jobs_v2`).get() as { status: string; attempts: number; next_attempt_at: string | null; failure_category: string | null }
  expect(retrying.status).toBe('retrying')
  expect(retrying.attempts).toBe(7)
  expect(retrying.next_attempt_at).toBe(new Date(Date.parse(NOW) + retryDelayMs(7)).toISOString())
  expect(retrying.failure_category).toBeNull() // category not set while retrying
  store.recordReconciliationFailure({ jobId, now: NOW, category: 'operational_exhausted', diagnostic: 'op', retryAt: null })
  const failed = raw.prepare(`SELECT status, attempts, failure_category, diagnostic FROM reconciliation_jobs_v2`).get() as { status: string; attempts: number; failure_category: string | null; diagnostic: string | null }
  expect(failed.status).toBe('failed')
  expect(failed.attempts).toBe(8)
  expect(failed.failure_category).toBe('operational_exhausted')
  expect(failed.diagnostic).toBe('op')
})

test('a deterministic invariant/data failure is terminal immediately', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  const { jobId } = seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'g1' }, committedAt: NOW, material: {} })
  store.recordReconciliationFailure({ jobId, now: NOW, category: 'invariant_or_data_failure', diagnostic: 'bad', retryAt: null })
  const row = raw.prepare(`SELECT status, attempts, failure_category FROM reconciliation_jobs_v2`).get() as { status: string; attempts: number; failure_category: string | null }
  expect(row.status).toBe('failed')
  expect(row.attempts).toBe(1)
  expect(row.failure_category).toBe('invariant_or_data_failure')
})

// ---- first-arrival serialization (spec §2.3) --------------------------------

test('jobs for one delivery finalize in first-arrival order: a later version waits until the earlier is terminal', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  // two DISTINCT versions of ONE delivery; wireOrdinal 0 arrives first
  const shared = { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'g1' }, committedAt: NOW }
  const first = seedJob(raw, { ...shared, wireOrdinal: 0, material: { content: 'a' } })
  const second = seedJob(raw, { ...shared, wireOrdinal: 1, material: { content: 'b' }, runId: first.runId, deliveryId: first.deliveryId })
  // claim once: it must be the EARLIER version (wireOrdinal 0)
  const claim = store.claimReconciliation(NOW)
  expect(claim?.jobId).toBe(first.jobId)
  // while the first is still processing, the second is NOT claimable
  expect(store.claimReconciliation(NOW)).toBeNull()
  void second
})

test('claimReconciliation takes jobs in (nextAttemptAt ASC, jobId ASC) order', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  // two independent deliveries; the one with the earlier next_attempt_at goes first
  seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'gLate' }, committedAt: LATER })
  const early = seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'gEarly' }, committedAt: NOW })
  expect(store.claimReconciliation(LATER)?.jobId).toBe(early.jobId)
})

// ---- supersession (spec §2.3): consumes no attempt --------------------------

test('a blocked source supersedes reconciliation: the job is left unclaimed with no attempt consumed', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f', { governance: 'blocked' })
  const { jobId } = seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'g1' }, committedAt: NOW })
  expect(store.claimReconciliation(NOW)).toBeNull() // blocked-source jobs are left
  const row = raw.prepare(`SELECT status, attempts FROM reconciliation_jobs_v2 WHERE id = ?`).get(jobId) as { status: string; attempts: number }
  expect(row.status).toBe('pending')
  expect(row.attempts).toBe(0)
})

// ---- chronology (spec §3.3): immutable timelineSortAt -----------------------

test('timelineSortAt uses the pub time when it is <= arrival, else the durable arrival time', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'gPast' }, committedAt: LATER, material: { published: '2026-07-23T00:30:00.000Z' } }) // between NOW and LATER
  seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'gFuture' }, committedAt: NOW, material: { published: '2099-01-01T00:00:00.000Z' } })
  drain(store, LATER)
  const past = raw.prepare(`SELECT timeline_sort_at FROM logical_items_v2 li JOIN logical_identity_keys_v2 k ON k.logical_item_id = li.id WHERE k.kind='delivery' AND k.key IN (SELECT id FROM deliveries_v2 WHERE key='gPast')`).get() as { timeline_sort_at: string }
  const future = raw.prepare(`SELECT timeline_sort_at FROM logical_items_v2 li JOIN logical_identity_keys_v2 k ON k.logical_item_id = li.id WHERE k.kind='delivery' AND k.key IN (SELECT id FROM deliveries_v2 WHERE key='gFuture')`).get() as { timeline_sort_at: string }
  expect(past.timeline_sort_at).toBe('2026-07-23T00:30:00.000Z') // pub <= arrival
  expect(future.timeline_sort_at).toBe(NOW) // future pub -> arrival
})

// ---- immutable terminal runs (spec §2.1) ------------------------------------

test('a reconciled job is not reprocessed on a subsequent drain', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, raw, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  expect(drain(store)).toBe(1)
  expect(drain(store)).toBe(0) // nothing left to do
  expect(count(raw, 'logical_items_v2')).toBe(1)
})

// ---- hints are recomputed, never trusted (spec §3.1) ------------------------

test('reconciliation recomputes selection hints from current data rather than trusting a stale stored hint', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, raw, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  drain(store)
  const item = raw.prepare(`SELECT id, selected_delivery_id FROM logical_items_v2`).get() as { id: string; selected_delivery_id: string }
  // corrupt the stored pointer, then reconcile a NEW version of the same delivery
  raw.prepare(`UPDATE logical_items_v2 SET selected_delivery_id = 'garbage' WHERE id = ?`).run(item.id)
  await acquire(db, raw, 's1', 'https://feed.test/f', RSS(guidItem('g1', 'CHANGED')), LATER)
  drain(store, LATER)
  const after = raw.prepare(`SELECT selected_delivery_id FROM logical_items_v2 WHERE id = ?`).get(item.id) as { selected_delivery_id: string }
  expect(after.selected_delivery_id).not.toBe('garbage') // recomputed from scratch
  expect(after.selected_delivery_id).toBe(item.selected_delivery_id)
})

// ---- carried acceptance test (Task 4 re-review): dateless h-entry identity ---

const HFEED_DATELESS = `<html><body><div class="h-feed"><div class="h-entry"><p class="e-content">dateless and linkless note</p></div></div></body></html>`

test('a dateless, url-less h-entry polled across two polls does NOT create a second logical item', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://indie.test/')
  await acquire(db, raw, 's1', 'https://indie.test/', HFEED_DATELESS, NOW)
  drain(store, NOW)
  await acquire(db, raw, 's1', 'https://indie.test/', HFEED_DATELESS, LATER)
  drain(store, LATER)
  expect(count(raw, 'logical_items_v2')).toBe(1) // stable identity across polls
  expect(count(raw, 'deliveries_v2')).toBe(1)
})

// ---- publisher naming: channel title, never the item title (§2.4) -----------

test('a single-publisher item without <source> names its publisher from the CHANNEL title, never the item title', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, raw, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  drain(store)
  const name = raw.prepare(`SELECT normalized_name FROM publisher_names_v2`).get() as { normalized_name: string | null }
  expect(name.normalized_name).toBe('Feed T')
  expect(name.normalized_name).not.toBe('t')
})

test('an aggregate item WITH <source> still names its publisher from the attribution, not the channel', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://agg.test/f', { mode: 'aggregate' })
  const item = `<item><guid isPermaLink="false">g1</guid><title>t</title><description>d</description><source url="https://alice.test/feed.xml">Alice</source></item>`
  await acquire(db, raw, 's1', 'https://agg.test/f', RSS(item))
  drain(store)
  const name = raw.prepare(`SELECT normalized_name FROM publisher_names_v2`).get() as { normalized_name: string | null }
  expect(name.normalized_name).toBe('Alice')
})
