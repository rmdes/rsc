import { test, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalPush } from '../src/logical/push.ts'
import { createScheduler } from '../src/logical/scheduler.ts'
import {
  activateLogicalV2, markReconciliationRequiredIfActive,
  ACTIVE_WITHOUT_MARKER, PREFLIGHT_FAILED,
} from '../src/logical/runtime.ts'
import type { CutoverInput } from '../src/logical/runtime.ts'
import { createApp } from '../src/api/app.ts'
import { mountLogicalHandleRoute } from '../src/api/logical-routes.ts'
import { loadConfig } from '../src/config.ts'
import { makeAuth } from './auth-helper.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

// V4 Task 8 — THE CUTOVER. Conversion extends V2 §7.1's pre-listen activation
// transaction (never a second barrier): one write transaction commits the
// conversion, the journal with its first reset generation, the cutover reset, the
// marker with its per-kind finding counts, the activation timestamps, and the
// transition to `active`. Preflight runs in-process immediately before, inside
// the same transaction, and any aborting finding fails startup committing
// NOTHING. The activation tripwire (§4.1 step 2) is exercised in both directions;
// §4.3's flag-off twin retired with the legacy branch.
//
// Nothing here does network I/O: preflight and conversion are pure SQL by
// contract, so the pre-listen barrier stays free of AWAITED network I/O exactly
// as the V3 I1 fix left it (the posture proofs themselves live in
// logical-v3-vertical.test.ts and are untouched).

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'
const LEGACY_AT = '2026-01-01T00:00:00.000Z'
const PUBLISHED_AT = '2026-02-01T00:00:00.000Z'
const HUB = 'https://hub.test/hub'
const FEED = 'https://a.test/feed.xml'
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const iso = (ms: number): string => new Date(ms).toISOString()

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  return { repo, raw, db, store }
}

// ---- legacy seeds (the migration-convert.test.ts idiom) ---------------------

const USER_COLS = `id, kind, handle, display_name, feed_url, created_at, feed_type`
function seedRemote(raw: Raw, over: Record<string, string | null> = {}): string {
  const row = {
    id: 'u1', kind: 'remote', handle: 'alice', display_name: 'Alice',
    feed_url: 'https://A.test:443/feed.xml', created_at: LEGACY_AT, feed_type: 'webfeed', ...over,
  }
  raw.prepare(`INSERT INTO users (${USER_COLS}) VALUES (@id, @kind, @handle, @display_name, @feed_url, @created_at, @feed_type)`).run(row)
  return row.id as string
}
function seedLocal(raw: Raw, id = 'l1', handle = 'localuser'): string {
  raw.prepare(`INSERT INTO users (${USER_COLS}) VALUES (?, 'local', ?, 'Local', NULL, ?, NULL)`).run(id, handle, LEGACY_AT)
  return id
}
function seedFollow(raw: Raw, followerId: string, followedId: string): void {
  raw.prepare(`INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)`).run(followerId, followedId, LEGACY_AT)
}
function seedPost(raw: Raw, over: Record<string, string | null> = {}): string {
  const row = {
    id: 'p1', author_id: 'u1', source: 'remote', guid: 'g1', title: 'Title', content: '<p>body</p>',
    url: 'https://a.test/post/1', published_at: PUBLISHED_AT, created_at: PUBLISHED_AT,
    in_reply_to: null, in_reply_to_post_id: null, thread_root_id: null,
    source_name: null, source_feed_url: null, content_markdown: null, edited_at: null,
    reply_context_author: null, reply_context_snippet: null, ...over,
  }
  raw.prepare(
    `INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at,
      in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url,
      content_markdown, edited_at, reply_context_author, reply_context_snippet)
     VALUES (@id, @author_id, @source, @guid, @title, @content, @url, @published_at, @created_at,
      @in_reply_to, @in_reply_to_post_id, @thread_root_id, @source_name, @source_feed_url,
      @content_markdown, @edited_at, @reply_context_author, @reply_context_snippet)`,
  ).run(row)
  return row.id as string
}
function seedPush(raw: Raw, over: Record<string, string | null> = {}): Record<string, string | null> {
  const row = {
    id: 'ps1', user_id: 'u1', mode: 'websub', endpoint: HUB,
    topic: 'https://A.test:443/feed.xml', // the LEGACY topic string, echoed back by the hub
    callback_token: 'legacy-token', secret: 'legacy-secret', state: 'active',
    expires_at: iso(Date.now() + 30 * 86_400_000), created_at: LEGACY_AT, ...over,
  }
  raw.prepare(
    `INSERT INTO push_subscriptions (id, user_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES (@id, @user_id, @mode, @endpoint, @topic, @callback_token, @secret, @state, @expires_at, @created_at)`,
  ).run(row)
  return row
}

// A representative preflight-clean legacy instance: one local account following a
// person source that has one post and a live push lease.
function seedLegacy(raw: Raw): void {
  seedLocal(raw)
  seedRemote(raw, { feed_type: 'person' })
  seedFollow(raw, 'l1', 'u1')
  seedPost(raw)
  seedPush(raw)
}

// ---- activation helpers -----------------------------------------------------

const lines: string[] = []
function activate(db: ReturnType<typeof createDatabaseContext>, over: CutoverInput = {}): void {
  lines.length = 0
  activateLogicalV2(db, NOW, { log: (l) => lines.push(l), ...over })
}

const activationRow = (raw: Raw) =>
  raw.prepare(`SELECT state, last_activated_at, last_reconciled_at, converted_at, conversion_findings_json FROM logical_activation_v2 WHERE singleton = 1`).get() as
    { state: string; last_activated_at: string | null; last_reconciled_at: string | null; converted_at: string | null; conversion_findings_json: string | null }
const count = (raw: Raw, table: string, where = ''): number => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n
const journal = (raw: Raw) => raw.prepare(`SELECT sequence, kind FROM logical_journal_v2 ORDER BY sequence`).all() as { sequence: number; kind: string }[]
const generation = (raw: Raw) => (raw.prepare(`SELECT reset_generation AS g FROM logical_journal_meta_v2 WHERE singleton = 1`).get() as { g: number }).g

// Every v2 relation conversion can write — the V2 Appendix D fault-injection
// inventory, extended with the tables Tasks 6-7 added.
const V2_TABLES = [
  'remote_sources_v2', 'remote_publishers_v2', 'federation_relationships_v2', 'source_subscriptions_v2',
  'source_audit_v2', 'handle_reservations_v2', 'logical_items_v2', 'logical_local_origins_v2',
  'logical_identity_keys_v2', 'deliveries_v2', 'observation_versions_v2', 'presentation_entries_v2',
  'publisher_claims_v2', 'logical_conflicts_v2', 'acquisition_runs_v2', 'reconciliation_jobs_v2',
  'push_subscriptions_v2', 'logical_journal_v2',
]
const LEGACY_TABLES = ['users', 'posts', 'post_revisions', 'follows', 'push_subscriptions', 'instance_settings']

// "Byte-identical afterwards": every legacy row, plus the schema version.
function legacySnapshot(raw: Raw): Record<string, unknown> {
  const out: Record<string, unknown> = { user_version: raw.pragma('user_version', { simple: true }) }
  for (const t of LEGACY_TABLES) out[t] = raw.prepare(`SELECT * FROM ${t}`).all()
  return out
}
function expectNothingCommitted(raw: Raw, before: Record<string, unknown>): void {
  expect(legacySnapshot(raw)).toEqual(before)
  for (const t of V2_TABLES) expect(count(raw, t), t).toBe(0)
  expect(activationRow(raw)).toMatchObject({ state: 'never_activated', converted_at: null, conversion_findings_json: null })
  expect(generation(raw)).toBe(0)
}

// =============================================================================
// Step 1 — the startup decision table and the ONE transaction
// =============================================================================

test('never-activated + no marker: ONE transaction commits conversion, the journal, the cutover reset, the marker, and active', async () => {
  const { repo, raw, db } = await fresh()
  seedLegacy(raw)
  expect(activationRow(raw)).toMatchObject({ state: 'never_activated', converted_at: null })

  activate(db)

  // conversion
  expect(raw.prepare(`SELECT id, canonical_url, provenance FROM remote_sources_v2`).get()).toEqual({ id: 'u1', canonical_url: FEED, provenance: 'migration' })
  expect(count(raw, 'logical_items_v2', `WHERE id = 'p1'`)).toBe(1)
  expect(count(raw, 'handle_reservations_v2', `WHERE handle = 'alice'`)).toBe(1)
  expect(count(raw, 'source_subscriptions_v2')).toBe(1)
  expect(count(raw, 'push_subscriptions_v2')).toBe(1)
  // journal initialization with its FIRST reset generation + the cutover reset
  expect(generation(raw)).toBe(1)
  expect(journal(raw)).toEqual([{ sequence: 1, kind: 'reset' }])
  // the marker: converted_at + the per-kind finding counts (spec §3.6)
  const act = activationRow(raw)
  expect(act).toMatchObject({ state: 'active', last_activated_at: NOW, converted_at: NOW })
  const counts = JSON.parse(act.conversion_findings_json!) as Record<string, number>
  expect(counts.default_person).toBe(1)
  expect(counts.push_preserved).toBe(1)
  expect(Object.keys(counts).length).toBe(12) // every kind, including the truthful zeros
  expect(Object.values(counts).every((n) => typeof n === 'number')).toBe(true)
  repo.close()
})

test('an aborting preflight finding fails startup with diagnostics and commits NOTHING', async () => {
  const { repo, raw, db } = await fresh()
  seedLegacy(raw)
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'not-a-url' }) // invalid_url: an aborting finding
  const before = legacySnapshot(raw)

  expect(() => activate(db)).toThrow(new RegExp(`${PREFLIGHT_FAILED}.*invalid_url.*u2`))

  expectNothingCommitted(raw, before)
  // …and the activation state is untouched: nothing to reconcile on the next start.
  expect(markReconciliationRequiredIfActive(db)).toBe(false)
  repo.close()
})

test('a manifest that will not load fails startup with its NAMED diagnostic and commits nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsc-cutover-'))
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{ not json')
  const wrongVersion = join(dir, 'v9.json')
  writeFileSync(wrongVersion, JSON.stringify({ schemaVersion: 9, entries: [] }))

  for (const [path, diagnostic] of [
    [join(dir, 'absent.json'), /manifest not readable/],
    [bad, /is not valid JSON/],
    [wrongVersion, /unsupported schemaVersion 9/],
  ] as [string, RegExp][]) {
    const { repo, raw, db } = await fresh()
    seedLegacy(raw)
    const before = legacySnapshot(raw)
    // loadManifest THROWS where runPreflight RETURNS: both fail startup the same
    // way, and the named diagnostic is surfaced rather than an anonymous rejection.
    expect(() => activate(db, { manifestPath: path }), path).toThrow(diagnostic)
    expect(() => activate(db, { manifestPath: path }), path).toThrow(PREFLIGHT_FAILED)
    expectNothingCommitted(raw, before)
    repo.close()
  }
})

test('marker present: conversion is SKIPPED and re-activation is V2 §7.1 unchanged', async () => {
  const { repo, raw, db } = await fresh()
  seedLegacy(raw)
  activate(db)
  const markerAt = activationRow(raw).converted_at

  // a flag-off restart marks reconciliation_required (V2 §7.1) …
  expect(markReconciliationRequiredIfActive(db)).toBe(true)
  // … and a legacy row appearing after cutover is NOT converted by re-activation
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml' })
  activate(db)

  expect(count(raw, 'remote_sources_v2')).toBe(1)
  expect(count(raw, 'handle_reservations_v2')).toBe(1)
  expect(activationRow(raw)).toMatchObject({ state: 'active', last_reconciled_at: NOW, converted_at: markerAt })
  expect(generation(raw)).toBe(1) // PRESERVED — no reconstruction
  expect(journal(raw).length).toBe(2) // the cutover reset + one reactivation barrier
  repo.close()
})

test('conversion runs AT MOST ONCE across restarts', async () => {
  const { repo, raw, db } = await fresh()
  seedLegacy(raw)
  activate(db)
  const first = activationRow(raw)
  activate(db)
  activate(db)
  expect(activationRow(raw)).toEqual(first) // continuous restarts change nothing
  expect(count(raw, 'remote_sources_v2')).toBe(1)
  expect(count(raw, 'logical_items_v2')).toBe(1)
  expect(journal(raw).length).toBe(1)
  repo.close()
})

test('a fault before the journal, the marker, or the commit leaves a legacy-intact database that retries next start', async () => {
  // The V2 Appendix D pattern: throw at each step of the one transaction and
  // assert the legacy tables AND the v2 tables are all unchanged.
  for (const phase of ['conversion', 'journal', 'marker', 'activation'] as const) {
    const { repo, raw, db } = await fresh()
    seedLegacy(raw)
    const before = legacySnapshot(raw)

    expect(() => activate(db, { step: (p) => { if (p === phase) throw new Error(`injected fault after ${p}`) } }), phase)
      .toThrow(`injected fault after ${phase}`)
    expectNothingCommitted(raw, before)

    // the next start simply retries
    activate(db)
    expect(count(raw, 'remote_sources_v2'), phase).toBe(1)
    expect(activationRow(raw).converted_at, phase).toBe(NOW)
    repo.close()
  }
})

// =============================================================================
// Step 2 — the activation tripwire. (Its twin, the flag-off "converted database
// requires v2" guard, retired with the legacy branch: there is no v1 path left to
// start, so the anomaly it caught can no longer occur.)
// =============================================================================

test('activation without the conversion marker is a NAMED startup error, never a silent skip', async () => {
  for (const state of ['active', 'reconciliation_required'] as const) {
    const { repo, raw, db } = await fresh()
    seedLegacy(raw)
    activate(db)
    // the anomaly spec §4.1 step 2 names: a hand-repaired / partially restored
    // database carrying v2 activation without the conversion marker.
    raw.prepare(`UPDATE logical_activation_v2 SET state = ?, converted_at = NULL, conversion_findings_json = NULL WHERE singleton = 1`).run(state)

    expect(() => activate(db), state).toThrow(ACTIVE_WITHOUT_MARKER)
    expect(activationRow(raw).state, state).toBe(state) // …and it did NOT silently reactivate
    repo.close()
  }
})

test('the tripwire is self-verifying: with the marker, both states start normally', async () => {
  const { repo, raw, db } = await fresh()
  seedLegacy(raw)
  activate(db)
  expect(() => activate(db)).not.toThrow() // active + marker → continuous restart
  markReconciliationRequiredIfActive(db)
  expect(() => activate(db)).not.toThrow() // reconciliation_required + marker → ordinary reactivation
  expect(activationRow(raw).state).toBe('active')
  repo.close()
})

// =============================================================================
// Step 3 — continuity across the cutover
// =============================================================================

const RSS = (items: string): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`
const sign = (body: string, secret: string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
const refusingFetch = (): typeof fetch => (async (input: string | URL | Request) => {
  throw new Error(`unexpected fetch: ${String(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)}`)
}) as unknown as typeof fetch

test("a legacy callback token authenticates a post-conversion fat ping against the converted row", async () => {
  const { repo, raw, db, store } = await fresh()
  seedLegacy(raw)
  const legacy = raw.prepare(`SELECT * FROM push_subscriptions WHERE id = 'ps1'`).get() as Record<string, string>
  activate(db)

  // token, secret, topic and route paths all preserved onto the same-ID source
  expect(raw.prepare(`SELECT source_id, callback_token, secret, topic, state, expires_at, created_at FROM push_subscriptions_v2 WHERE mode = 'websub'`).get()).toEqual({
    source_id: 'u1', callback_token: legacy.callback_token, secret: legacy.secret,
    topic: legacy.topic, state: legacy.state, expires_at: legacy.expires_at, created_at: legacy.created_at,
  })

  // …so the hub's next fat ping — signed with the LEGACY secret, addressed to the
  // LEGACY callback token — authenticates and takes the ordinary acquisition path.
  const fetchFn = refusingFetch() // a fat ping never fetches the feed
  const acquisition = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  const push = createLogicalPush({ db, store, config: loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://rsc.test' }), acquisition, fetchFn, lookupFn: publicLookup })
  const body = RSS(`<item><guid>g2</guid><title>t</title><description>d</description></item>`)

  expect(await push.websubDeliver(legacy.callback_token, body, sign(body, legacy.secret))).toBe(202)
  expect(count(raw, 'acquisition_runs_v2', `WHERE source_id = 'u1' AND delivery_mechanism = 'push'`)).toBe(1)
  expect(count(raw, 'deliveries_v2', `WHERE key = 'g2'`)).toBe(1)
  repo.close()
})

test('the first post-cutover renewal happens on the ORDINARY poll-pass sweep', async () => {
  const { repo, raw, db, store } = await fresh()
  seedLegacy(raw)
  // a preserved lease already inside the one-day renewal horizon
  raw.prepare(`UPDATE push_subscriptions SET expires_at = ? WHERE id = 'ps1'`).run(iso(Date.now() + 3600_000))
  activate(db)

  const calls: { url: string; body: string }[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') })
    return new Response('', { status: 202 })
  }) as unknown as typeof fetch
  const acquisition = { acquireSource: async () => ({ kind: 'unavailable' as const, reason: 'unscheduled' }), inFlight: () => false }
  const push = createLogicalPush({ db, store, config: loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://rsc.test' }), acquisition, fetchFn, lookupFn: publicLookup })
  const scheduler = createScheduler({ store, acquisition, config: { pollSeconds: 9999 }, now: () => NOW, drainVerification: undefined, push, breather: undefined })

  await scheduler.pollDue(NOW) // no separate renewal timer exists — this IS the sweep

  const renewal = calls.find((c) => c.url === HUB)
  expect(renewal).toBeDefined()
  expect(renewal!.body).toContain('hub.mode=subscribe')
  expect(renewal!.body).toContain(encodeURIComponent('https://rsc.test/websub/callback/legacy-token')) // the PRESERVED token
  expect(renewal!.body).toContain('hub.secret=legacy-secret')
  repo.close()
})

test('paced acquisition resumes for enabled allowed AND enabled quarantined sources; paused and blocked stay inactive', async () => {
  const { repo, raw, db, store } = await fresh()
  seedLocal(raw)
  seedRemote(raw, { feed_type: 'person' }) // allowed + subscribed
  seedFollow(raw, 'l1', 'u1')
  seedRemote(raw, { id: 'u2', handle: 'inst', feed_url: 'https://b.test/f.xml', feed_type: 'instance' }) // quarantined + federation pending
  seedFollow(raw, 'l1', 'u2')
  activate(db)

  expect(raw.prepare(`SELECT id, governance FROM remote_sources_v2 ORDER BY id`).all()).toEqual([
    { id: 'u1', governance: 'allowed' }, { id: 'u2', governance: 'quarantined' },
  ])
  expect(store.listSchedulableSources()).toEqual(['u1', 'u2'])

  raw.prepare(`UPDATE remote_sources_v2 SET operation = 'paused' WHERE id = 'u1'`).run()
  raw.prepare(`UPDATE remote_sources_v2 SET governance = 'blocked' WHERE id = 'u2'`).run()
  expect(store.listSchedulableSources()).toEqual([])
  repo.close()
})

// ---- the capability flip is core-only ---------------------------------------

async function makeApp(opts: { v2: boolean }) {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const bus = createEventBus()
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, opts.v2 ? store : undefined)
  const acquisition = createAcquisition({ db, fetchFn: refusingFetch(), lookupFn: publicLookup, now: () => NOW })
  const app = createApp({
    service, bus, token: 'ops', auth: makeAuth(repo), users: repo, adminEmails: new Set(['boss@x.test']),
    feeds: { publicUrl: 'https://rsc.test', hubUrl: null, rssCloud: false },
    ...(opts.v2 ? { sources: { service: createSourceService(repo, null), repo }, logical: { store, acquisition, now: () => NOW } } : {}),
  })
  // server.ts mounts the reserved-handle lookup beside the stream route, so the
  // route exists only under v2 — exactly the composition this app reproduces.
  if (opts.v2) mountLogicalHandleRoute(app, { raw })
  return { app, repo, raw, db, store }
}

test('the flip is core-only: /capabilities reports V2 exact enabled shape — V4 adds no field', async () => {
  const { app, repo, raw, db } = await makeApp({ v2: true })
  seedLegacy(raw)
  activate(db)
  // EXACT equality against V2's shape (the V3 Task 10 pattern): a web already
  // deployed on the memoized-success path follows the flip without a redeploy.
  expect(await (await app.request('/capabilities')).json()).toEqual({
    sourceModelV2: true, model: 'logical-v2', journalCursorVersion: 1, streamProtocolVersion: 1,
  })
  repo.close()

  const off = await makeApp({ v2: false })
  expect(await (await off.app.request('/capabilities')).json()).toEqual({ sourceModelV2: false })
  expect((await off.app.request('/handles/alice')).status).toBe(404) // the lookup is v2-only
  off.repo.close()
})

// =============================================================================
// Step 4 — the permanent reserved-handle redirect (spec §3.5)
// =============================================================================

// RIDER 3: the end-to-end proof that a converted instance handle's /u/:handle →
// /p/:publisherId resolves 200 — §3.5 as SHIPPED, not as assumed. The fixture
// needs exactly two things beyond conversion: the source must be `allowed` (an
// unconfirmed instance is quarantined, and resolvePublisher only serves a
// publisher supported by a claim on an ALLOWED source), and it must carry at
// least one converted post (that is what mints the claim — since Task 6
// conversion writes claims itself, so no post-cutover reconcile is required).
// A manifest approval gives the first; one legacy post gives the second.
function approvedInstanceManifest(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rsc-cutover-manifest-'))
  const path = join(dir, 'manifest.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    entries: [{ sourceId: 'u1', feedUrl: 'https://A.test:443/feed.xml', attributionMode: 'aggregate', note: 'reviewed peer' }],
  }))
  return path
}

async function convertedInstance() {
  const ctx = await makeApp({ v2: true })
  seedLocal(ctx.raw)
  seedRemote(ctx.raw, { feed_type: 'instance' })
  seedFollow(ctx.raw, 'l1', 'u1')
  seedPost(ctx.raw)
  activate(ctx.db, { manifestPath: approvedInstanceManifest() })
  expect(ctx.raw.prepare(`SELECT governance FROM remote_sources_v2 WHERE id = 'u1'`).get()).toEqual({ governance: 'allowed' })
  const publisherId = (ctx.raw.prepare(`SELECT publisher_id AS p FROM handle_reservations_v2 WHERE handle = 'alice'`).get() as { p: string }).p
  return { ...ctx, publisherId }
}

test('the lookup answers a reserved handle and 404s an unreserved one', async () => {
  const { app, repo, publisherId } = await convertedInstance()
  const res = await app.request('/handles/alice')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ model: 'logical-v2', handle: 'alice', reserved: true, publisherId })

  expect((await app.request('/handles/localuser')).status).toBe(404) // a live LOCAL handle renders as today
  expect((await app.request('/handles/nobody')).status).toBe(404)
  repo.close()
})

test('RIDER 3 — end to end: a converted instance handle redirects to a publisher page that resolves 200', async () => {
  const { app, repo, publisherId } = await convertedInstance()
  // /u/alice → (lookup) → /p/<publisherId> → core's publisher lens
  const res = await app.request(`/timeline?publisher=${encodeURIComponent(publisherId)}`)
  expect(res.status).toBe(200)
  const body = await res.json() as { lens: { kind: string; publisher: { id: string; identityLevel: string } }; timeline: { id: string }[] }
  expect(body.lens.kind).toBe('publisher')
  expect(body.lens.publisher).toMatchObject({ id: publisherId, identityLevel: 'feed_anchored' })
  expect(body.timeline.map((i) => i.id)).toEqual(['p1'])
  repo.close()
})

test('the reservation OUTLIVES its target: after purge the lookup still answers and the publisher page 404s ordinarily', async () => {
  const { app, repo, raw, store, publisherId } = await convertedInstance()
  // block, then purge through the ordinary V3 command (block is a prerequisite).
  raw.prepare(`UPDATE remote_sources_v2 SET governance = 'blocked' WHERE id = 'u1'`).run()
  const result = store.purgeSource({
    command: { actorScope: 'administrator', actorId: 'admin1', commandId: 'c-purge', requestFingerprint: 'fp-purge' },
    sourceId: 'u1', category: 'operator_policy', note: null, now: NOW,
  })
  expect(result.kind).toBe('purged')
  expect(count(raw, 'remote_publishers_v2', `WHERE id = '${publisherId}'`)).toBe(0) // fully unreferenced → deleted

  // the reservation has no FKs: it survives, so the redirect still fires …
  const res = await app.request('/handles/alice')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ reserved: true, publisherId })
  // … and its target 404s through the ORDINARY not-found path. No post-purge branch.
  expect((await app.request(`/timeline?publisher=${encodeURIComponent(publisherId)}`)).status).toBe(404)
  repo.close()
})

test('a pre-cutover /post/:id permalink resolves to the same-ID logical item', async () => {
  const { app, repo } = await convertedInstance()
  const res = await app.request('/post/p1')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ model: 'logical-v2', item: { id: 'p1', origin: 'remote' } })
  repo.close()
})

// =============================================================================
// Step 5 — a user's own reply to a REMOTE post survives the cutover
// =============================================================================
// V2's materialization pass walked `posts WHERE source = 'local'` alone and
// SKIPPED any local post whose parent was not itself a local post: local.ts
// writes the parent edge unconditionally, so materializing such a reply before
// conversion would FK-violate on a parent that does not exist yet. Conversion now
// runs FIRST, minting every legacy remote post as a same-ID logical_items_v2 row,
// so the edge holds and the reply is materialized like any other.
//
// The user-visible loss it repairs is the CONVERSATION: an unmaterialized reply
// keeps its permalink and its author-timeline card (both project straight from
// `posts`), but /post/<reply>/thread 404s and the parent's thread does not contain
// it — while the parent's card still advertises the reply. Same content, one day
// later, no longer reachable in the conversation it belongs to.

const REPLY_AT = '2026-02-02T00:00:00.000Z'

// The local reply whose parent is the REMOTE post seedLegacy converts.
function seedLocalReplyToRemote(raw: Raw): void {
  seedPost(raw, {
    id: 'lr1', author_id: 'l1', source: 'local', guid: 'lg1', title: null,
    content: '<p>my reply</p>', url: '/post/lr1', published_at: REPLY_AT, created_at: REPLY_AT,
    in_reply_to: 'https://a.test/post/1', in_reply_to_post_id: 'p1', thread_root_id: 'p1',
  })
}

async function legacyWithLocalReply() {
  const ctx = await makeApp({ v2: true })
  seedLegacy(ctx.raw)
  seedLocalReplyToRemote(ctx.raw)
  return ctx
}

const threadIds = (env: { nodes: ({ kind: 'item'; item: { id: string } } | { kind: 'placeholder'; logicalItemId: string })[] }): string[] =>
  env.nodes.map((n) => (n.kind === 'item' ? n.item.id : n.logicalItemId))

// The user-visible statement, asserted end to end through the routes web calls.
async function expectReplySurvives(app: Awaited<ReturnType<typeof makeApp>>['app'], raw: Raw): Promise<void> {
  // (a) the permalink resolves …
  const perma = await app.request('/post/lr1')
  expect(perma.status).toBe(200)
  expect(await perma.json()).toMatchObject({ item: { id: 'lr1', origin: 'local', parentResolutionState: 'resolved', parentLogicalItemId: 'p1' } })
  // (b) … it is in the author's timeline …
  const author = await (await app.request('/timeline?author=localuser')).json() as { timeline: { id: string }[] }
  expect(author.timeline.map((i) => i.id)).toEqual(['lr1'])
  // (c) … its own conversation resolves, rooted on the remote parent …
  const own = await app.request('/post/lr1/thread')
  expect(own.status).toBe(200)
  const ownEnv = await own.json() as { rootId: string; nodes: never[] }
  expect(ownEnv.rootId).toBe('p1')
  expect(threadIds(ownEnv).sort()).toEqual(['lr1', 'p1'])
  // (d) … and the parent's conversation contains it, matching the count its card shows
  const parent = await (await app.request('/post/p1/thread')).json() as { nodes: never[] }
  expect(threadIds(parent).sort()).toEqual(['lr1', 'p1'])
  expect(await (await app.request('/post/p1')).json()).toMatchObject({ item: { directReplyCount: 1 } })
  // (e) … and the remote parent's comments.xml carries the converted reply too,
  // its item count agreeing with the directReplyCount above — before the fix this
  // route served an empty body for a remote parent whose only reply was an
  // unmaterialized local one (logical-routes.ts's comments.xml walks the SAME
  // thread projection projectThread does, so an unmaterialized reply was absent
  // from both).
  const commentsXml = await (await app.request('/post/p1/comments.xml')).text()
  expect(commentsXml).toContain('my reply')
  expect((commentsXml.match(/<guid/g) ?? []).length).toBe(1)
  // the durable edge behind all of it
  expect(raw.prepare(`SELECT origin, parent_state, parent_logical_item_id FROM logical_items_v2 WHERE id = 'lr1'`).get())
    .toEqual({ origin: 'local', parent_state: 'resolved', parent_logical_item_id: 'p1' })
}

test("a user's own reply to a remote post survives the cutover: permalink, timeline, and the conversation it belongs to", async () => {
  const { app, repo, raw, db } = await legacyWithLocalReply()
  activate(db)
  await expectReplySurvives(app, raw)
  repo.close()
})

test('a database converted by an EARLIER build repairs its unmaterialized local reply on the next start', async () => {
  const { app, repo, raw, db } = await legacyWithLocalReply()
  activate(db)
  // Reproduce exactly what the earlier build committed: marker present, state
  // active, and NO bridge row for the local reply. Such a database reaches only
  // the continuous-restart path forever, so materialization has to run there too
  // or the reply stays lost for good.
  raw.prepare(`DELETE FROM logical_identity_keys_v2 WHERE logical_item_id = 'lr1'`).run()
  raw.prepare(`DELETE FROM logical_local_origins_v2 WHERE logical_item_id = 'lr1'`).run()
  raw.prepare(`DELETE FROM logical_items_v2 WHERE id = 'lr1'`).run()
  expect((await app.request('/post/lr1/thread')).status).toBe(404) // the broken state
  const before = activationRow(raw)

  activate(db) // continuous-v2 restart: marker present, state active

  await expectReplySurvives(app, raw)
  // …and the repair changed nothing else: no second conversion, no reset, no
  // generation bump, timestamps preserved.
  expect(activationRow(raw)).toEqual(before)
  expect(count(raw, 'remote_sources_v2')).toBe(1)
  expect(generation(raw)).toBe(1)
  expect(journal(raw)).toEqual([{ sequence: 1, kind: 'reset' }])
  repo.close()
})

test('a fault BETWEEN conversion and materialization leaves a retryable legacy-intact database', async () => {
  const { app, repo, raw, db } = await legacyWithLocalReply()
  const before = legacySnapshot(raw)
  // The `conversion` phase fires between the two steps, so this IS the crash
  // Pin 2 names. The ONE transaction is what protects it: the marker cannot
  // commit ahead of materialization, so there is no half-cutover to repair.
  expect(() => activate(db, { step: (p) => { if (p === 'conversion') throw new Error('injected fault after conversion') } }))
    .toThrow('injected fault after conversion')
  expectNothingCommitted(raw, before)

  activate(db) // the next start simply retries, and the reply converts with it
  await expectReplySurvives(app, raw)
  repo.close()
})

test('a fresh install with no legacy data activates: conversion and materialization are both no-ops', async () => {
  const { repo, raw, db } = await fresh()
  activate(db)
  expect(activationRow(raw)).toMatchObject({ state: 'active', converted_at: NOW })
  for (const t of V2_TABLES) expect(count(raw, t), t).toBe(t === 'logical_journal_v2' ? 1 : 0)
  expect(generation(raw)).toBe(1)
  repo.close()
})
