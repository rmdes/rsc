import { test, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import {
  createLogicalPush, parsePushCapability, choosePushTarget, pushInEffective, verifySignature,
  PENDING_TTL_MS, RSSCLOUD_TTL_MS, WEBSUB_LEASE_SECONDS,
  WEBSUB_RENEW_HORIZON_MS, RSSCLOUD_RENEW_HORIZON_MS,
} from '../src/logical/push.ts'
import type { PushClaim, PushRowV2 } from '../src/logical/push.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'
import type { AcquisitionEngine } from '../src/logical/acquisition.ts'
import { loadConfig } from '../src/config.ts'

// V4 Task 2 — the v2 push lifecycle over push_subscriptions_v2: the capability
// parser, registration, renewal, and the purge. No callback handling (Task 3).
// Plus the pure helpers this module owns since the v1 retirement deleted
// domain/push-in.ts (target choice, signature verification, the effective switch).

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'
const HUB: PushClaim = { mode: 'websub', endpoint: 'https://hub.test/hub', topic: 'https://blog.test/feed.xml' }
const CLOUD: PushClaim = { mode: 'rsscloud', endpoint: 'http://blog.test:5337/rsscloud/pleaseNotify', topic: 'https://blog.test/feed.xml' }
const ENV = { RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://rsc.test' }
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const privateLookup: LookupFn = async () => [{ address: '10.0.0.5' }]

async function fresh(opts: { env?: Record<string, string>; lookupFn?: LookupFn; status?: number } = {}) {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  const calls: { url: string; body: URLSearchParams; redirect: string | undefined }[] = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)), redirect: init?.redirect as string | undefined })
    return new Response('', { status: opts.status ?? 202 })
  })
  // Task 2's suite covers the LIFECYCLE only; the callbacks (Task 3) are what use
  // the engine, so an inert stub is the right dependency here.
  const acquisition: AcquisitionEngine = { acquireSource: async () => ({ kind: 'unavailable', reason: 'unscheduled' }), inFlight: () => false }
  const push = createLogicalPush({
    db, store, config: loadConfig(opts.env ?? ENV), acquisition,
    fetchFn: fetchFn as unknown as typeof fetch, lookupFn: opts.lookupFn ?? publicLookup,
  })
  return { raw, repo, db, store, push, calls, fetchFn }
}

function seedSource(raw: Raw, id: string, opts: { operation?: string; governance?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', ?, ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, `https://feed.test/${id}`, opts.operation ?? 'enabled', opts.governance ?? 'allowed', NOW)
}

async function seedSubscribed(raw: Raw, repo: { createLocalUser: (u: { handle: string; displayName: string }) => Promise<{ id: string }> }, id: string, opts: { operation?: string; governance?: string } = {}): Promise<void> {
  seedSource(raw, id, opts)
  const owner = await repo.createLocalUser({ handle: `owner-${id}`, displayName: id })
  raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`)
    .run(`sub-${id}`, owner.id, id, NOW)
}

const RUN_COLS = `id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json`
function seedRun(raw: Raw, input: { id: string; sourceId: string; startedAt: string; outcome: string; capability: string | null }): void {
  raw.prepare(
    `INSERT INTO acquisition_runs_v2 (${RUN_COLS}) VALUES (?, ?, 'scheduled', 'terminal', ?, ?, ?, ?, '{}', NULL, NULL, ?)`,
  ).run(input.id, input.sourceId, input.startedAt, input.startedAt, input.startedAt, input.outcome, input.capability)
}

const rowOf = (raw: Raw, sourceId: string, mode?: string): Record<string, string | null> | undefined =>
  raw.prepare(`SELECT * FROM push_subscriptions_v2 WHERE source_id = ?${mode ? ' AND mode = ?' : ''}`)
    .get(...(mode ? [sourceId, mode] : [sourceId])) as Record<string, string | null> | undefined

const iso = (ms: number): string => new Date(ms).toISOString()

function insertRow(raw: Raw, over: Partial<Record<string, string | null>> = {}): void {
  const row = {
    id: 'p1', source_id: 's1', mode: 'websub', endpoint: HUB.endpoint, topic: HUB.topic,
    callback_token: 'tok-1', secret: 'sec-1', state: 'active', expires_at: iso(Date.now() + 86_400_000), created_at: NOW, ...over,
  }
  raw.prepare(
    `INSERT INTO push_subscriptions_v2 (id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES (@id, @source_id, @mode, @endpoint, @topic, @callback_token, @secret, @state, @expires_at, @created_at)`,
  ).run(row)
}

// --- Step 1: the capability claim -------------------------------------------

test('parsePushCapability round-trips the pinned {mode,endpoint,topic} shape', () => {
  expect(parsePushCapability(JSON.stringify(HUB))).toEqual(HUB)
  expect(parsePushCapability(JSON.stringify(CLOUD))).toEqual(CLOUD)
})

test('parsePushCapability returns null for SQL NULL, silently — an absent claim is not a fault', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(parsePushCapability(null)).toBeNull()
  expect(spy).not.toHaveBeenCalled()
  spy.mockRestore()
})

test('parsePushCapability is total over attacker-influenced stored JSON: null + one log line, never a throw', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const bad = ['{', 'null', '"a string"', '[]', '{"mode":"carrier-pigeon","endpoint":"https://h.test","topic":"t"}', '{"mode":"websub"}', '{"mode":"websub","endpoint":1,"topic":"t"}']
  for (const json of bad) expect(parsePushCapability(json)).toBeNull()
  expect(spy).toHaveBeenCalledTimes(bad.length) // exactly one line per malformed claim
  spy.mockRestore()
})

test('registration acts only on the latest successful run: a stale claim on an older run is inert', async () => {
  const { raw, repo, push, fetchFn } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  seedRun(raw, { id: 'r-old', sourceId: 's1', startedAt: '2026-07-20T00:00:00.000Z', outcome: 'parsed', capability: JSON.stringify(HUB) })
  seedRun(raw, { id: 'r-new', sourceId: 's1', startedAt: '2026-07-24T00:00:00.000Z', outcome: 'parsed', capability: null })

  expect(push.latestClaim('s1')).toBeNull() // the newest parse advertises nothing
  await push.maybeRegister('s1', push.latestClaim('s1'))
  expect(rowOf(raw, 's1')).toBeUndefined()
  expect(fetchFn).not.toHaveBeenCalled()
  raw.close()
})

test('a later not-modified run does not erase the latest parse’s claim (304 saw no document)', async () => {
  const { raw, repo, push } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  seedRun(raw, { id: 'r-parse', sourceId: 's1', startedAt: '2026-07-23T00:00:00.000Z', outcome: 'parsed', capability: JSON.stringify(HUB) })
  seedRun(raw, { id: 'r-304', sourceId: 's1', startedAt: '2026-07-24T00:00:00.000Z', outcome: 'not_modified', capability: null })
  expect(push.latestClaim('s1')).toEqual(HUB)
  raw.close()
})

// --- Step 2: registration ----------------------------------------------------

test('a websub claim writes a pending row with the 10-minute TTL BEFORE the subscribe POST', async () => {
  const { raw, repo, push, calls } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const before = Date.now()
  await push.maybeRegister('s1', HUB)

  const row = rowOf(raw, 's1')!
  expect(row.state).toBe('pending')
  expect(row.mode).toBe('websub')
  expect(row.endpoint).toBe(HUB.endpoint)
  expect(row.topic).toBe(HUB.topic)
  expect(row.secret).toBeTruthy()
  const ttl = Date.parse(row.expires_at as string) - before
  expect(ttl).toBeGreaterThan(PENDING_TTL_MS - 5_000)
  expect(ttl).toBeLessThan(PENDING_TTL_MS + 5_000)

  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe(HUB.endpoint)
  expect(calls[0].redirect).toBe('manual')
  expect(calls[0].body.get('hub.mode')).toBe('subscribe')
  expect(calls[0].body.get('hub.topic')).toBe(HUB.topic)
  expect(calls[0].body.get('hub.callback')).toBe(`https://rsc.test/websub/callback/${row.callback_token}`)
  expect(calls[0].body.get('hub.lease_seconds')).toBe(String(WEBSUB_LEASE_SECONDS))
  expect(calls[0].body.get('hub.secret')).toBe(row.secret)
  raw.close()
})

test('an rsscloud claim writes pending before register and flips active with the 25 h TTL on 2xx', async () => {
  const { raw, repo, push, calls } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const before = Date.now()
  await push.maybeRegister('s1', CLOUD)

  const row = rowOf(raw, 's1')!
  expect(row.state).toBe('active')
  expect(row.secret).toBeNull() // rsscloud carries no HMAC secret
  const ttl = Date.parse(row.expires_at as string) - before
  expect(ttl).toBeGreaterThan(RSSCLOUD_TTL_MS - 5_000)
  expect(ttl).toBeLessThan(RSSCLOUD_TTL_MS + 5_000)
  expect(calls[0].url).toBe(CLOUD.endpoint)
  expect(calls[0].body.get('protocol')).toBe('http-post')
  expect(calls[0].body.get('url1')).toBe(CLOUD.topic)
  expect(calls[0].body.get('domain')).toBe('rsc.test')
  expect(calls[0].body.get('path')).toBe('/rsscloud/notify')
  raw.close()
})

test('an rsscloud register that fails leaves the row pending on its 10-minute TTL', async () => {
  const { raw, repo, push } = await fresh({ status: 500 })
  await seedSubscribed(raw, repo, 's1')
  await push.maybeRegister('s1', CLOUD)
  const row = rowOf(raw, 's1')!
  expect(row.state).toBe('pending')
  expect(Date.parse(row.expires_at as string) - Date.now()).toBeLessThanOrEqual(PENDING_TTL_MS)
  raw.close()
})

test('eligibility composes three axes: paused, blocked, and unschedulable all refuse — no row, no request', async () => {
  const { raw, repo, push, fetchFn } = await fresh()
  await seedSubscribed(raw, repo, 'paused', { operation: 'paused' })
  await seedSubscribed(raw, repo, 'blocked', { governance: 'blocked' })
  seedSource(raw, 'lonely') // enabled + allowed, but nobody subscribes and no federation

  for (const id of ['paused', 'blocked', 'lonely']) {
    await push.maybeRegister(id, HUB)
    expect(rowOf(raw, id)).toBeUndefined()
  }
  expect(fetchFn).not.toHaveBeenCalled()
  raw.close()
})

test('quarantined + enabled registers normally — quarantine is an evidence gate, not a push gate', async () => {
  const { raw, repo, push, fetchFn } = await fresh()
  await seedSubscribed(raw, repo, 's1', { governance: 'quarantined' })
  await push.maybeRegister('s1', HUB)
  expect(rowOf(raw, 's1')?.state).toBe('pending')
  expect(fetchFn).toHaveBeenCalledTimes(1)
  raw.close()
})

test('a pending-federation source with no subscriber is schedulable and registers', async () => {
  const { raw, push } = await fresh()
  seedSource(raw, 'fed')
  raw.prepare(`INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES ('fed', 'pending', NULL, ?, ?)`).run(NOW, NOW)
  await push.maybeRegister('fed', HUB)
  expect(rowOf(raw, 'fed')?.state).toBe('pending')
  raw.close()
})

test('the SSRF gate revalidates the claimed endpoint at use: a private endpoint yields no row and no request', async () => {
  const { raw, repo, push, fetchFn } = await fresh({ lookupFn: privateLookup })
  await seedSubscribed(raw, repo, 's1')
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await push.maybeRegister('s1', { mode: 'websub', endpoint: 'https://internal.test/hub', topic: HUB.topic })
  await push.maybeRegister('s1', { mode: 'websub', endpoint: 'http://127.0.0.1/hub', topic: HUB.topic })
  spy.mockRestore()
  expect(rowOf(raw, 's1')).toBeUndefined()
  expect(fetchFn).not.toHaveBeenCalled()
  raw.close()
})

test('an unexpired pending or active row blocks a new attempt', async () => {
  const { raw, repo, push, fetchFn } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  await push.maybeRegister('s1', HUB)
  expect(fetchFn).toHaveBeenCalledTimes(1)
  await push.maybeRegister('s1', HUB) // unexpired pending row → skip
  expect(fetchFn).toHaveBeenCalledTimes(1)
  raw.close()
})

test('an unexpired rsscloud fallback is UPGRADED when the feed now advertises a hub', async () => {
  const { raw, repo, push, calls } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  await push.maybeRegister('s1', CLOUD)
  expect(rowOf(raw, 's1', 'rsscloud')?.state).toBe('active')

  await push.maybeRegister('s1', HUB) // websub is preferred → upgrade, not skip
  expect(rowOf(raw, 's1', 'websub')?.state).toBe('pending')
  expect(rowOf(raw, 's1', 'rsscloud')).toBeDefined() // retired only when the hub verifies (Task 3)
  expect(calls[1].url).toBe(HUB.endpoint)
  raw.close()
})

test('R1: re-registration against a surviving (source, mode) row reuses its token and secret', async () => {
  const { raw, repo, push, calls } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  await push.maybeRegister('s1', HUB)
  const first = rowOf(raw, 's1')!

  // The pending row lapses; the row itself survives, so its identity must too.
  raw.prepare(`UPDATE push_subscriptions_v2 SET expires_at = '2020-01-01T00:00:00.000Z' WHERE source_id = 's1'`).run()
  await push.maybeRegister('s1', HUB)
  const second = rowOf(raw, 's1')!
  expect(second.id).toBe(first.id)
  expect(second.callback_token).toBe(first.callback_token)
  expect(second.secret).toBe(first.secret)
  expect(second.created_at).toBe(first.created_at)
  expect(calls[1].body.get('hub.callback')).toBe(`https://rsc.test/websub/callback/${first.callback_token}`)
  expect(calls[1].body.get('hub.secret')).toBe(first.secret)

  // …and a source with NO row at all gets fresh material.
  await seedSubscribed(raw, repo, 's2')
  await push.maybeRegister('s2', HUB)
  expect(rowOf(raw, 's2')!.callback_token).not.toBe(first.callback_token)
  raw.close()
})

test('registration is inert when push is ineffective: no row is ever written and no request is made', async () => {
  for (const env of [{ ...ENV, RSC_PUSH_IN: 'off' }, { RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' }]) {
    const { raw, repo, push, fetchFn } = await fresh({ env })
    await seedSubscribed(raw, repo, 's1')
    await push.maybeRegister('s1', HUB)
    expect(rowOf(raw, 's1')).toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
    await push.renewDue() // the sweep never runs either
    expect(fetchFn).not.toHaveBeenCalled()
    raw.close()
  }
})

// --- Step 3: renewal, the retry floor, and the purge -------------------------

test('renewDue re-subscribes a websub row inside its renew horizon with the SAME token and secret', async () => {
  const { raw, repo, push, calls } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  insertRow(raw, { expires_at: iso(Date.now() + WEBSUB_RENEW_HORIZON_MS - 60_000) })

  await push.renewDue()
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe(HUB.endpoint)
  expect(calls[0].body.get('hub.callback')).toBe('https://rsc.test/websub/callback/tok-1')
  expect(calls[0].body.get('hub.secret')).toBe('sec-1')

  // the hourly per-row retry floor: a second sweep in the same hour sends nothing
  await push.renewDue()
  expect(calls).toHaveLength(1)
  raw.close()
})

test('renewDue leaves a websub row outside its renew horizon alone', async () => {
  const { raw, repo, push, fetchFn } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  insertRow(raw, { expires_at: iso(Date.now() + WEBSUB_RENEW_HORIZON_MS + 3_600_000) })
  await push.renewDue()
  expect(fetchFn).not.toHaveBeenCalled()
  raw.close()
})

test('renewDue re-registers an rsscloud row only inside its own 2 h horizon, and extends it on 2xx', async () => {
  const { raw, repo, push, fetchFn } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  await seedSubscribed(raw, repo, 's2')
  // s1: listed by the websub horizon but far from the rsscloud one → untouched
  insertRow(raw, { id: 'p1', source_id: 's1', mode: 'rsscloud', secret: null, callback_token: 'tok-1', endpoint: CLOUD.endpoint, topic: CLOUD.topic, expires_at: iso(Date.now() + RSSCLOUD_RENEW_HORIZON_MS + 3_600_000) })
  // s2: inside the 2 h horizon → re-registered
  insertRow(raw, { id: 'p2', source_id: 's2', mode: 'rsscloud', secret: null, callback_token: 'tok-2', endpoint: CLOUD.endpoint, topic: CLOUD.topic, expires_at: iso(Date.now() + RSSCLOUD_RENEW_HORIZON_MS - 60_000) })

  await push.renewDue()
  expect(fetchFn).toHaveBeenCalledTimes(1)
  expect(Date.parse(rowOf(raw, 's2')!.expires_at as string) - Date.now()).toBeGreaterThan(RSSCLOUD_TTL_MS - 5_000)
  expect(rowOf(raw, 's1')!.callback_token).toBe('tok-1')
  raw.close()
})

test('renewal is filtered by CURRENT eligibility and NO unsubscribe is ever sent — the lease simply lapses', async () => {
  for (const drop of ['pause', 'block', 'unsubscribe'] as const) {
    const { raw, repo, push, fetchFn } = await fresh()
    await seedSubscribed(raw, repo, 's1')
    insertRow(raw, { expires_at: iso(Date.now() + WEBSUB_RENEW_HORIZON_MS - 60_000) })
    if (drop === 'pause') raw.prepare(`UPDATE remote_sources_v2 SET operation = 'paused' WHERE id = 's1'`).run()
    if (drop === 'block') raw.prepare(`UPDATE remote_sources_v2 SET governance = 'blocked' WHERE id = 's1'`).run()
    if (drop === 'unsubscribe') raw.prepare(`DELETE FROM source_subscriptions_v2 WHERE source_id = 's1'`).run()

    await push.renewDue()
    expect(fetchFn).not.toHaveBeenCalled() // zero requests: no renewal, and never an unsubscribe
    expect(rowOf(raw, 's1')).toBeDefined() // the row is left to expire on its own
    raw.close()
  }
})

test('purgeExpired deletes expired rows at pass end and keeps live ones', async () => {
  const { raw, repo, push } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  await seedSubscribed(raw, repo, 's2')
  insertRow(raw, { id: 'p1', source_id: 's1', expires_at: '2020-01-01T00:00:00.000Z' })
  insertRow(raw, { id: 'p2', source_id: 's2', callback_token: 'tok-2' })
  push.purgeExpired(new Date().toISOString())
  expect(rowOf(raw, 's1')).toBeUndefined()
  expect(rowOf(raw, 's2')).toBeDefined()
  raw.close()
})

test('hasActivePush is true only for an active unexpired row', async () => {
  const { raw, repo, push } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const now = new Date().toISOString()
  insertRow(raw, { state: 'pending' })
  expect(push.hasActivePush('s1', now)).toBe(false)
  raw.prepare(`UPDATE push_subscriptions_v2 SET state = 'active' WHERE source_id = 's1'`).run()
  expect(push.hasActivePush('s1', now)).toBe(true)
  raw.prepare(`UPDATE push_subscriptions_v2 SET expires_at = '2020-01-01T00:00:00.000Z' WHERE source_id = 's1'`).run()
  expect(push.hasActivePush('s1', now)).toBe(false)
  raw.close()
})

// --- the store primitives ----------------------------------------------------

test('the store push primitives: filtered find, identity-preserving upsert, delete', async () => {
  const { raw, repo, db, store } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const row: PushRowV2 = {
    id: 'p1', sourceId: 's1', mode: 'websub', endpoint: HUB.endpoint, topic: HUB.topic,
    callbackToken: 'tok-1', secret: 'sec-1', state: 'pending', expiresAt: iso(Date.now() + 60_000), createdAt: NOW,
  }
  db.write((tx) => { store.upsertPushRow(tx, row) })
  expect(store.findPushRow({ token: 'tok-1' })).toEqual(row)
  expect(store.findPushRow({ sourceId: 's1', mode: 'rsscloud' })).toBeUndefined()
  expect(store.findPushRow({ topic: HUB.topic }, { state: 'active' })).toBeUndefined()
  expect(store.findPushRow({ sourceId: 's1' }, { unexpiredAt: iso(Date.now() + 120_000) })).toBeUndefined()

  // H4: an upsert on the same (source, mode) never rewrites token/secret/creation.
  db.write((tx) => { store.upsertPushRow(tx, { ...row, id: 'p1', callbackToken: 'other', secret: 'other', state: 'active', expiresAt: iso(Date.now() + 600_000) }) })
  const stored = store.findPushRow({ sourceId: 's1' })!
  expect(stored.callbackToken).toBe('tok-1')
  expect(stored.secret).toBe('sec-1')
  expect(stored.state).toBe('active')

  db.write((tx) => { store.deletePushRow(tx, 'p1') })
  expect(store.findPushRow({ sourceId: 's1' })).toBeUndefined()
  raw.close()
})

test('listRenewablePushRows lists only ACTIVE rows expiring before the horizon', async () => {
  const { raw, repo, store } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  await seedSubscribed(raw, repo, 's2')
  await seedSubscribed(raw, repo, 's3')
  insertRow(raw, { id: 'p1', source_id: 's1', callback_token: 'tok-1', expires_at: iso(Date.now() + 60_000) })
  insertRow(raw, { id: 'p2', source_id: 's2', callback_token: 'tok-2', state: 'pending', expires_at: iso(Date.now() + 60_000) })
  insertRow(raw, { id: 'p3', source_id: 's3', callback_token: 'tok-3', expires_at: iso(Date.now() + 86_400_000) })
  const due = store.listRenewablePushRows(iso(Date.now() + 600_000))
  expect(due.map((r) => r.id)).toEqual(['p1'])
  raw.close()
})

// ---- the pure helpers (relocated here with domain/push-in.ts's deletion) -----

const FEED = 'https://blog.example.com/feed.xml'

test('choosePushTarget prefers websub, topic = advertised self else feedUrl', () => {
  expect(choosePushTarget({ hubs: ['https://hub.example.com/hub'], self: 'https://blog.example.com/rss', cloud: null }, FEED))
    .toEqual({ mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://blog.example.com/rss' })
  expect(choosePushTarget({ hubs: ['https://hub.example.com/hub'], self: null, cloud: null }, FEED))
    .toEqual({ mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: FEED })
})

test('choosePushTarget falls back to an http-post cloud, and yields null otherwise', () => {
  const cloud = { domain: 'blog.example.com', port: 5337, path: '/rsscloud/pleaseNotify', protocol: 'http-post' }
  expect(choosePushTarget({ hubs: [], self: null, cloud }, FEED))
    .toEqual({ mode: 'rsscloud', endpoint: 'http://blog.example.com:5337/rsscloud/pleaseNotify', topic: FEED })
  expect(choosePushTarget({ hubs: ['https://hub.example.com/hub'], self: null, cloud }, FEED)?.mode).toBe('websub') // websub preferred
  expect(choosePushTarget({ hubs: [], self: null, cloud: { ...cloud, protocol: 'xml-rpc' } }, FEED)).toBeNull()
  expect(choosePushTarget({ hubs: [], self: null, cloud: null }, FEED)).toBeNull()
})

test('cloud endpoints derive scheme from port: 443 is https, others http', () => {
  const cloud = (port: number) => ({ domain: 'a.example', port, path: '/rsscloud/pleaseNotify', protocol: 'http-post' })
  expect(choosePushTarget({ hubs: [], self: null, cloud: cloud(443) }, 'https://a.example/users/x/feed.xml')?.endpoint).toBe('https://a.example:443/rsscloud/pleaseNotify')
  expect(choosePushTarget({ hubs: [], self: null, cloud: cloud(5337) }, 'https://a.example/users/x/feed.xml')?.endpoint).toBe('http://a.example:5337/rsscloud/pleaseNotify')
})

test('pushInEffective requires both the switch and a public URL', () => {
  expect(pushInEffective(loadConfig(ENV))).toBe(true)
  expect(pushInEffective(loadConfig({ ...ENV, RSC_PUSH_IN: 'off' }))).toBe(false)
  expect(pushInEffective(loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' }))).toBe(false)
})

test('verifySignature accepts all four W3C algorithms and rejects tampering (H1)', () => {
  const body = 'the payload'
  for (const algo of ['sha1', 'sha256', 'sha384', 'sha512'] as const) {
    const sig = `${algo}=` + createHmac(algo, 'sec').update(body).digest('hex')
    expect(verifySignature(body, 'sec', sig)).toBe(true)
    expect(verifySignature(body + 'x', 'sec', sig)).toBe(false)
  }
  expect(verifySignature(body, 'sec', null)).toBe(false)
  expect(verifySignature(body, 'sec', 'md5=abc')).toBe(false)
  expect(verifySignature(body, 'sec', 'sha256=zzzz')).toBe(false)
})
