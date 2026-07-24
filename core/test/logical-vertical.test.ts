import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createScheduler } from '../src/logical/scheduler.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createLogicalRuntime, compose, activateLogicalV2, markReconciliationRequiredIfActive } from '../src/logical/runtime.ts'
import type { LogicalRuntime } from '../src/logical/runtime.ts'
import type { AcquisitionEngine } from '../src/logical/acquisition.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

// The WHOLE-VERTICAL integration proof for logical v2 (spec §7.3-7.5). It exercises
// the complete default-off boundary AND the enabled-v2 end-to-end flow across the
// real modules — schema, acquisition, reconciliation, threading, projection,
// journal, scheduler, activation runtime — that the per-task suites test in
// isolation. Two things it deliberately proves that no single-task suite can:
//   (1) the cross-model isolation matrix (§7.4) — flag-OFF v2 tables are inert and
//       byte-identical legacy; flag-ON legacy paths are not started; and
//   (2) the v2-path dual-path convergence FIX for the v1 bug that `ingest.test.ts`
//       and `federation-live.test.ts` still pin as `test.fails()` (see the marked
//       proof below).

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'
const LATER = '2026-07-24T01:00:00.000Z'

function count(raw: Raw, table: string, where = '', ...args: unknown[]): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args) as { n: number }).n
}

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  return { repo, raw, db, store: createLogicalStore(db) }
}

function seedSource(raw: Raw, id: string, url: string, opts: { operation?: string; governance?: string; mode?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, ?, ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, opts.mode ?? 'single_publisher', opts.operation ?? 'enabled', opts.governance ?? 'allowed', NOW)
}

async function seedSubscribed(raw: Raw, repo: { createLocalUser: (u: { handle: string; displayName: string }) => Promise<{ id: string }> }, id: string, url: string): Promise<void> {
  seedSource(raw, id, url)
  const owner = await repo.createLocalUser({ handle: `owner-${id}`, displayName: id })
  raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`).run(`sub-${id}`, owner.id, id, NOW)
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
const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`
const linkItem = (link: string, body = 'd'): string => `<item><link>${link}</link><title>t</title><description>${body}</description></item>`

// White-box: insert a delivery + observation version + pending reconciliation job
// directly, so the reply half of the convergence proof needs no crafted wire body.
// Mirrors the seedJob helper the reconcile/projector suites already use.
function seedJob(raw: Raw, input: { sourceId: string; deliveryKey: { kind: string; key: string }; committedAt: string; material?: { permalink?: string | null; inReplyTo?: string | null; content?: string } }): { jobId: string } {
  const runId = randomUUID(), deliveryId = randomUUID(), versionId = randomUUID(), jobId = randomUUID()
  const m = input.material ?? {}
  const material = { v: 1, keyKind: input.deliveryKey.kind, key: input.deliveryKey.key, title: 't', content: m.content ?? 'body', link: m.permalink ?? null, published: '', updated: null, inReplyTo: m.inReplyTo ?? null, enclosures: [] }
  const canonical = Buffer.from(JSON.stringify(material), 'utf8')
  const fingerprint = createHash('sha256').update(canonical).digest('hex')
  const normalized = JSON.stringify({ keyKind: input.deliveryKey.kind, key: input.deliveryKey.key, permalink: m.permalink ?? null, inReplyTo: m.inReplyTo ?? null, enclosures: [] })
  const rawEvidence = JSON.stringify({ title: 't', sourceName: 'T', link: m.permalink ?? null, published: '', updated: null, enclosureCount: 0 })
  raw.prepare(`INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json) VALUES (?, ?, 'scheduled', 'terminal', ?, ?, ?, 'parsed', '{}', NULL, NULL, NULL)`).run(runId, input.sourceId, input.committedAt, input.committedAt, input.committedAt)
  raw.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(deliveryId, input.sourceId, input.deliveryKey.kind, input.deliveryKey.key, input.committedAt, input.committedAt, runId)
  raw.prepare(`INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json) VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)`).run(versionId, deliveryId, fingerprint, canonical, input.committedAt, runId, input.committedAt, runId, rawEvidence, normalized)
  raw.prepare(`INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at) VALUES (?, 'observation', ?, ?, NULL, 'pending', 0, ?, NULL, NULL, ?)`).run(jobId, runId, versionId, input.committedAt, input.committedAt)
  return { jobId }
}

const ANON = { localAccountId: null, activeSourceIds: [] as string[] }
const stubEngine: AcquisitionEngine = { acquireSource: async () => ({ kind: 'unavailable', reason: 'unscheduled' }), inFlight: () => false }
const mkRuntime = (deps: Awaited<ReturnType<typeof fresh>>, acquisition: AcquisitionEngine = stubEngine, order?: string[]): LogicalRuntime =>
  createLogicalRuntime({ db: deps.db, store: deps.store, acquisition, config: { pollSeconds: 9999 }, now: () => NOW, ...(order ? { trace: (p: string) => order.push(p) } : {}) })

// ============================================================================
// Cross-model isolation — v2 DISABLED (§7.4): v2 tables inert, legacy byte-identical
// ============================================================================

test('disabled: compose starts legacy poll + inbound push and no v2 worker', () => {
  expect(compose({ sourceModelV2: false, runtime: null })).toEqual({ legacyPoll: true, legacyPushIn: true })
})

test('disabled: a service built WITHOUT the logical store writes NO v2 rows (flag-off byte-identical)', async () => {
  const { repo, raw } = await fresh()
  const service = createService(repo, createEventBus(), null) // no logical store — exactly the OFF path
  await service.createLocalPostAs('bob', 'Bob', 'hello from v1')
  expect(count(raw, 'logical_items_v2')).toBe(0)
  expect(count(raw, 'logical_journal_v2')).toBe(0)
})

test('disabled: the reconciliation marker is a no-op on a never-activated instance (no write)', async () => {
  const deps = await fresh()
  expect(markReconciliationRequiredIfActive(deps.db)).toBe(false)
  expect(deps.store.snapshot((tx) => tx.getActivation()).state).toBe('never_activated')
})

// ============================================================================
// Cross-model isolation — v2 ENABLED (§7.4)
// ============================================================================

test('enabled: compose installs NEITHER legacy poll nor inbound push', () => {
  expect(compose({ sourceModelV2: true, runtime: {} as LogicalRuntime })).toEqual({ legacyPoll: false, legacyPushIn: false })
})

test('enabled: capability is unavailable until activation commits (activate strictly precedes listen)', async () => {
  const deps = await fresh()
  expect(deps.store.snapshot((tx) => tx.getActivation()).state).toBe('never_activated') // no capability before activation
  const order: string[] = []
  const runtime = mkRuntime(deps, stubEngine, order)
  await runtime.ready
  order.push('listen') // server.ts accepts traffic (→ reports capability) only after ready
  expect(order).toEqual(['journal', 'projector', 'scheduler', 'reconcile', 'orphan', 'activate', 'listen'])
  expect(deps.store.snapshot((tx) => tx.getActivation()).state).toBe('active')
  await runtime.stop()
})

test('enabled: legacy remote posts in `posts` are NOT dual-read into the v2 timeline', async () => {
  const deps = await fresh()
  // a legacy remote post the v1 way (source='remote') — activation materializes
  // LOCAL posts only, so this never becomes a v2 logical item.
  deps.raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES ('r1','person','peer','Peer','https://peer.test/f',?)`).run(NOW)
  deps.raw.prepare(`INSERT INTO posts (id, author_id, source, guid, content, url, published_at, created_at) VALUES ('rp1','r1','remote','g','remote body','https://peer.test/rp1',?,?)`).run(NOW, NOW)
  const runtime = mkRuntime(deps); await runtime.ready; await runtime.stop()
  const tl = deps.store.snapshot((tx) => tx.projectTimeline({ lens: { kind: 'public' }, before: null, limit: 50, viewer: ANON }))
  expect(count(deps.raw, 'logical_items_v2')).toBe(0) // no legacy dual-read
  expect(tl.timeline.length).toBe(0)
})

// ============================================================================
// Activation-state matrix (§7.1, Task 10)
// ============================================================================

test('first activation creates generation 1 + one reset and goes active', async () => {
  const deps = await fresh()
  const runtime = mkRuntime(deps); await runtime.ready; await runtime.stop()
  expect(deps.store.snapshot((tx) => tx.getActivation())).toMatchObject({ state: 'active', lastActivatedAt: NOW })
  expect(deps.store.snapshot((tx) => tx.getJournalMetadata()).resetGeneration).toBe(1)
  expect(count(deps.raw, 'logical_journal_v2', "WHERE kind = 'reset'")).toBe(1)
})

test('continuous restart preserves the generation and appends no reset; a disabled interval then reactivates with one barrier reset', async () => {
  const deps = await fresh()
  const rt1 = mkRuntime(deps); await rt1.ready; await rt1.stop()
  const journalRows = count(deps.raw, 'logical_journal_v2')

  // continuous restart (state === active): no new reset, generation preserved
  const rt2 = mkRuntime(deps); await rt2.ready; await rt2.stop()
  expect(count(deps.raw, 'logical_journal_v2')).toBe(journalRows)
  expect(deps.store.snapshot((tx) => tx.getJournalMetadata()).resetGeneration).toBe(1)

  // a disabled process marks reconciliation_required; re-enabling reactivates
  expect(markReconciliationRequiredIfActive(deps.db)).toBe(true)
  expect(deps.store.snapshot((tx) => tx.getActivation()).state).toBe('reconciliation_required')
  const rt3 = mkRuntime(deps); await rt3.ready; await rt3.stop()
  expect(deps.store.snapshot((tx) => tx.getActivation())).toMatchObject({ state: 'active', lastReconciledAt: NOW })
  expect(deps.store.snapshot((tx) => tx.getJournalMetadata()).resetGeneration).toBe(1) // PRESERVED
  expect(count(deps.raw, 'logical_journal_v2', "WHERE kind = 'reset'")).toBe(2) // activation reset + reactivation barrier
})

// ============================================================================
// Scheduler → observation → job → projection → journal, end to end
// ============================================================================

test('a scheduled poll acquires an observation, reconciliation converges it, the projector serves it, the journal records it', async () => {
  const deps = await fresh()
  await seedSubscribed(deps.raw, deps.repo, 's1', 'https://feed.test/s1')
  activateLogicalV2(deps.db, NOW)
  const engine = createAcquisition({ db: deps.db, fetchFn: fakeFetch({ 'https://feed.test/s1': () => ok(RSS(linkItem('https://blog.test/hello'))) }), lookupFn: publicLookup, now: () => NOW })
  // Mirror runtime.ts: after each committed acquisition, drain reconciliation.
  const wrapped: AcquisitionEngine = {
    inFlight: (id) => engine.inFlight(id),
    async acquireSource(id, reason, sig) { const r = await engine.acquireSource(id, reason, sig); if (!('kind' in r)) drainReconciliation({ store: deps.store, now: () => NOW }); return r },
  }
  const sched = createScheduler({ store: deps.store, acquisition: wrapped, config: { pollSeconds: 60 }, now: () => NOW, drainVerification: undefined })
  const upsertsBefore = count(deps.raw, 'logical_journal_v2', "WHERE kind = 'upsert'")

  expect(await sched.pollDue(NOW)).toBe(1)

  expect(count(deps.raw, 'observation_versions_v2')).toBe(1)                       // observation acquired
  expect((deps.raw.prepare(`SELECT status FROM reconciliation_jobs_v2`).get() as { status: string }).status).toBe('reconciled') // job converged
  expect(count(deps.raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(1)   // one logical item
  const tl = deps.store.snapshot((tx) => tx.projectTimeline({ lens: { kind: 'public' }, before: null, limit: 50, viewer: ANON }))
  expect(tl.timeline.length).toBe(1)                                              // projector serves it
  expect(count(deps.raw, 'logical_journal_v2', "WHERE kind = 'upsert'")).toBeGreaterThan(upsertsBefore) // journal records it
})

// ============================================================================
// Crash boundaries (§7.2)
// ============================================================================

test('crash recovery: the startup drain picks up a pending reconciliation job a crash left behind', async () => {
  const deps = await fresh()
  seedSource(deps.raw, 's1', 'https://feed.test/s1')
  // an acquisition committed an observation + pending job, then the process died
  // BEFORE reconciliation ran (no drain).
  const engine = createAcquisition({ db: deps.db, fetchFn: fakeFetch({ 'https://feed.test/s1': () => ok(RSS(linkItem('https://blog.test/x'))) }), lookupFn: publicLookup, now: () => NOW })
  await engine.acquireSource('s1', { kind: 'scheduled' }, undefined)
  expect((deps.raw.prepare(`SELECT status FROM reconciliation_jobs_v2`).get() as { status: string }).status).toBe('pending')

  // a fresh runtime's startup drain (inside ready) reconciles it
  const runtime = mkRuntime(deps, engine); await runtime.ready; await runtime.stop()
  expect((deps.raw.prepare(`SELECT status FROM reconciliation_jobs_v2`).get() as { status: string }).status).toBe('reconciled')
  expect(count(deps.raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(1)
})

test('crash recovery: a crashed `processing` run is NOT resumed; the in-flight flag clears with the process', async () => {
  const deps = await fresh()
  seedSource(deps.raw, 's1', 'https://feed.test/s1')
  // a run the crash left mid-flight (nonterminal history)
  deps.raw.prepare(`INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json) VALUES ('crashed','s1','scheduled','processing',?,NULL,NULL,'pending','{}',NULL,NULL,NULL)`).run(NOW)
  // a fresh acquisition engine begins with no in-flight state (the flag is process
  // state, an in-memory Map — it died with the crashed process, NOT the DB row).
  const engine = createAcquisition({ db: deps.db, fetchFn: fakeFetch({}), lookupFn: publicLookup, now: () => NOW })
  expect(engine.inFlight('s1')).toBe(false)
  // starting the runtime never resumes the crashed run — it stays nonterminal history.
  const runtime = mkRuntime(deps, stubEngine); await runtime.ready; await runtime.stop()
  expect((deps.raw.prepare(`SELECT status FROM acquisition_runs_v2 WHERE id = 'crashed'`).get() as { status: string }).status).toBe('processing')
})

// ============================================================================
// Local/remote convergence (§2.5-2.6): local origin wins
// ============================================================================

test('a local post and a remote delivery of the same permalink converge to ONE logical item, local origin winning', async () => {
  const deps = await fresh()
  const service = createService(deps.repo, createEventBus(), null, deps.store)
  const entry = await service.createLocalPostAs('alice', 'Alice', 'my local note')
  expect(count(deps.raw, 'logical_items_v2', "WHERE id = ? AND origin = 'local'", entry.id)).toBe(1)
  // the local item also owns the absolute permalink a remote source will echo
  // (the exact-unique-local-identifier a remote echo can attach evidence through).
  deps.raw.prepare(`INSERT OR IGNORE INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('permalink', 'https://blog.test/echo', ?)`).run(entry.id)

  seedSource(deps.raw, 's1', 'https://feed.test/s1')
  const engine = createAcquisition({ db: deps.db, fetchFn: fakeFetch({ 'https://feed.test/s1': () => ok(RSS(linkItem('https://blog.test/echo'))) }), lookupFn: publicLookup, now: () => NOW })
  await engine.acquireSource('s1', { kind: 'scheduled' }, undefined)
  drainReconciliation({ store: deps.store, now: () => NOW })

  // local origin wins: NO second (remote) ordinary item, the collision is a conflict
  expect(count(deps.raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(0)
  expect(count(deps.raw, 'logical_items_v2')).toBe(1)
  expect((deps.raw.prepare(`SELECT origin FROM logical_items_v2 WHERE id = ?`).get(entry.id) as { origin: string }).origin).toBe('local')
  expect(count(deps.raw, 'logical_conflicts_v2')).toBeGreaterThanOrEqual(1)
})

// ============================================================================
// THE v2-PATH DUAL-PATH CONVERGENCE PROOF (§7.3 acceptance intent)
// ----------------------------------------------------------------------------
// `ingest.test.ts` and `federation-live.test.ts` carry `test.fails()` markers for
// the v1 dual-path duplicate bug: one post reached by TWO subscription/source paths
// is stored twice and stops resolving as a parent. Those markers STAY expected-fail
// here — v2 is flag-OFF by default and does NOT replace the v1 ingestion path they
// exercise; that replacement is the Vertical 4 cutover, at which point those two
// markers flip from `test.fails()` to `test()`. This test is the POSITIVE assertion
// that the logical model fixes what v1 cannot, and it is what becomes the live
// guarantee at V4: the same dual-path scenario against the v2 logical model
// converges to exactly ONE logical item that resolves correctly AS A PARENT.
// ============================================================================

test('v2 fix: one item reached by TWO source paths converges to ONE logical item that still resolves as a parent', async () => {
  const deps = await fresh()
  seedSource(deps.raw, 's1', 'https://agg1.test/f')
  seedSource(deps.raw, 's2', 'https://agg2.test/f')
  // the SAME item delivered by two independent sources (the v1 dual-path scenario)
  const eng1 = createAcquisition({ db: deps.db, fetchFn: fakeFetch({ 'https://agg1.test/f': () => ok(RSS(linkItem('https://blog.test/p1'))) }), lookupFn: publicLookup, now: () => NOW })
  await eng1.acquireSource('s1', { kind: 'scheduled' }, undefined)
  const eng2 = createAcquisition({ db: deps.db, fetchFn: fakeFetch({ 'https://agg2.test/f': () => ok(RSS(linkItem('https://blog.test/p1'))) }), lookupFn: publicLookup, now: () => LATER })
  await eng2.acquireSource('s2', { kind: 'scheduled' }, undefined)
  drainReconciliation({ store: deps.store, now: () => LATER })

  // EXACTLY ONE logical item — not two (this is what v1 gets wrong)
  expect(count(deps.raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(1)
  expect(count(deps.raw, 'logical_identity_keys_v2', "WHERE kind = 'permalink'")).toBe(1)
  expect(count(deps.raw, 'logical_identity_keys_v2', "WHERE kind = 'delivery'")).toBe(2) // both paths point at the one item
  const parentId = (deps.raw.prepare(`SELECT id FROM logical_items_v2 WHERE origin = 'remote'`).get() as { id: string }).id

  // a reply referencing that permalink resolves to the ONE converged item (v1's
  // duplicate parent would make this resolution ambiguous / fail).
  seedJob(deps.raw, { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'reply1' }, committedAt: LATER, material: { content: 'a reply', inReplyTo: 'https://blog.test/p1' } })
  drainReconciliation({ store: deps.store, now: () => LATER })
  const reply = deps.raw.prepare(`SELECT parent_state, parent_logical_item_id FROM logical_items_v2 WHERE id != ? AND origin = 'remote'`).get(parentId) as { parent_state: string; parent_logical_item_id: string | null }
  expect(reply.parent_state).toBe('resolved')
  expect(reply.parent_logical_item_id).toBe(parentId)
})
