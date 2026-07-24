import { test, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createLogicalPush } from '../src/logical/push.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalRuntime } from '../src/logical/runtime.ts'
import { loadConfig } from '../src/config.ts'
import { WEBSUB_LEASE_SECONDS } from '../src/domain/push-in.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

// V4 Task 3 — the four v2 push CALLBACKS (spec §1.4) and the runtime composition
// that serves them. The route code in api/app.ts does not change: under v2 the
// server composition supplies `pushInApi` from createLogicalPush instead of
// createPushIn, so these tests drive the handlers directly (the routes are already
// pinned by the v1 push-in suite).
//
// Everything v1 hardened stays hardened: a bad/missing HMAC is a SILENT 202, an
// unknown topic is a neutral 200 no-op with the 30 s per-topic floor, and
// `hub.mode=denied` DELETES the row.

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'
const FEED = 'https://blog.test/feed.xml'
const HUB = 'https://hub.test/hub'
const CLOUD = 'http://blog.test:5337/rsscloud/pleaseNotify'
const TOKEN = 'cb-token-1'
const SECRET = 'push-secret-1'
const ENV = { RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://rsc.test' }
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]

const RSS = (items: string, extra = ''): string =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>T</title>${extra}${items}</channel></rss>`
const item = (guid: string, body = 'd'): string => `<item><guid>${guid}</guid><title>t</title><description>${body}</description></item>`
const HUB_ADVERT = `<atom:link rel="self" href="${FEED}"/><atom:link rel="hub" href="${HUB}"/>`

const iso = (ms: number): string => new Date(ms).toISOString()
const sign = (body: string, secret = SECRET): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

// The fire-and-forget thin-ping run is deliberately NOT awaited by the handler
// (the response must not time-distinguish a subscribed topic), so the test drains
// the macrotask queue instead of racing it.
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => { setTimeout(r, 0) }) }

function seedSource(raw: Raw, id: string, url: string, opts: { operation?: string; governance?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', ?, ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, opts.operation ?? 'enabled', opts.governance ?? 'allowed', NOW)
}

async function seedSubscribed(raw: Raw, repo: { createLocalUser: (u: { handle: string; displayName: string }) => Promise<{ id: string }> }, id: string, url: string, opts: { operation?: string; governance?: string } = {}): Promise<void> {
  seedSource(raw, id, url, opts)
  const owner = await repo.createLocalUser({ handle: `owner-${id}`, displayName: id })
  raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`).run(`sub-${id}`, owner.id, id, NOW)
}

function insertPushRow(raw: Raw, over: Partial<Record<string, string | null>> = {}): void {
  const row = {
    id: 'p1', source_id: 's1', mode: 'websub', endpoint: HUB, topic: FEED,
    callback_token: TOKEN, secret: SECRET, state: 'active',
    expires_at: iso(Date.now() + 86_400_000), created_at: NOW, ...over,
  }
  raw.prepare(
    `INSERT INTO push_subscriptions_v2 (id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES (@id, @source_id, @mode, @endpoint, @topic, @callback_token, @secret, @state, @expires_at, @created_at)`,
  ).run(row)
}

const pushRow = (raw: Raw, mode?: string): Record<string, string | null> | undefined =>
  raw.prepare(`SELECT * FROM push_subscriptions_v2${mode ? ' WHERE mode = ?' : ''}`).get(...(mode ? [mode] : [])) as Record<string, string | null> | undefined

const count = (raw: Raw, table: string, where = ''): number =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n

const runs = (raw: Raw): { reason: string; outcome: string; delivery_mechanism: string | null }[] =>
  raw.prepare(`SELECT reason, outcome, delivery_mechanism FROM acquisition_runs_v2 ORDER BY started_at, id`).all() as { reason: string; outcome: string; delivery_mechanism: string | null }[]

// A fetch that refuses to be called: the fat-ping path must NEVER fetch the feed
// (the delivered body IS the document, spec §1.4).
const refusingFetch = (): typeof fetch => (async (input: string | URL | Request) => {
  throw new Error(`unexpected fetch: ${String(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)}`)
}) as unknown as typeof fetch

function routedFetch(map: Record<string, () => Response>): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    const h = map[url]
    if (!h) throw new Error(`no route: ${url}`)
    return h()
  }) as unknown as typeof fetch
  return { fn, calls }
}

async function fresh(opts: { fetchFn?: typeof fetch; env?: Record<string, string> } = {}) {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  const fetchFn = opts.fetchFn ?? refusingFetch()
  const acquisition = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  const push = createLogicalPush({ db, store, config: loadConfig(opts.env ?? ENV), acquisition, fetchFn, lookupFn: publicLookup })
  return { repo, raw, db, store, push, acquisition }
}

// --- Step 1: the WebSub verification GET -------------------------------------

test('verification is state-agnostic: an ACTIVE row re-verifies on renewal and takes the granted lease', async () => {
  const { repo, raw, push } = await fresh()
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw, { state: 'active', expires_at: iso(Date.now() + 1000) })

  const res = await push.websubVerify(TOKEN, { 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.challenge': 'chal-9', 'hub.lease_seconds': '3600' })
  expect(res).toEqual({ status: 200, body: 'chal-9' })
  const row = pushRow(raw)!
  expect(row.state).toBe('active')
  // the GRANTED lease, not the requested one
  expect(Date.parse(row.expires_at as string) - Date.now()).toBeGreaterThan(3_000_000)
  expect(Date.parse(row.expires_at as string) - Date.now()).toBeLessThan(3_700_000)
  repo.close()
})

test('a pending row activates, and a non-integer or absent lease falls back to the requested one', async () => {
  const { repo, raw, push } = await fresh()
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw, { state: 'pending' })

  const res = await push.websubVerify(TOKEN, { 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.challenge': 'c1', 'hub.lease_seconds': 'not-a-number' })
  expect(res).toEqual({ status: 200, body: 'c1' })
  const row = pushRow(raw)!
  expect(row.state).toBe('active')
  const remaining = Date.parse(row.expires_at as string) - Date.now()
  expect(remaining).toBeGreaterThan(WEBSUB_LEASE_SECONDS * 1000 - 60_000)
  repo.close()
})

test('hub.mode=denied DELETES the row (v1 push-in.ts:200-202, kept)', async () => {
  const { repo, raw, push } = await fresh()
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw)

  expect(await push.websubVerify(TOKEN, { 'hub.mode': 'denied', 'hub.topic': FEED, 'hub.reason': 'nope' })).toEqual({ status: 200, body: 'ok' })
  expect(count(raw, 'push_subscriptions_v2')).toBe(0)
  repo.close()
})

test('websub activation retires a surviving rsscloud fallback row (push-in.ts:208-210)', async () => {
  const { repo, raw, push } = await fresh()
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw, { id: 'p-cloud', mode: 'rsscloud', endpoint: CLOUD, callback_token: 'cloud-tok', secret: null, state: 'active' })
  insertPushRow(raw, { state: 'pending' })

  expect((await push.websubVerify(TOKEN, { 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.challenge': 'c2' })).status).toBe(200)
  expect(count(raw, 'push_subscriptions_v2')).toBe(1)
  expect(pushRow(raw)!.mode).toBe('websub')
  repo.close()
})

test('an unknown token, a mismatched topic, and a challenge-less subscribe are all 404', async () => {
  const { repo, raw, push } = await fresh()
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw, { state: 'pending' })

  expect(await push.websubVerify('nope', { 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.challenge': 'c' })).toEqual({ status: 404, body: 'unknown subscription' })
  expect(await push.websubVerify(TOKEN, { 'hub.mode': 'subscribe', 'hub.topic': 'https://other.test/f.xml', 'hub.challenge': 'c' })).toEqual({ status: 404, body: 'unknown subscription' })
  expect(await push.websubVerify(TOKEN, { 'hub.mode': 'subscribe', 'hub.topic': FEED })).toEqual({ status: 404, body: 'unknown subscription' })
  expect(pushRow(raw)!.state).toBe('pending') // nothing activated
  repo.close()
})

test('a valid in-flight challenge completes while PAUSED or BLOCKED — and acquires nothing', async () => {
  for (const opts of [{ operation: 'paused' }, { governance: 'blocked' }] as const) {
    const { repo, raw, push } = await fresh()
    await seedSubscribed(raw, repo, 's1', FEED, opts)
    insertPushRow(raw, { state: 'pending' })

    expect(await push.websubVerify(TOKEN, { 'hub.mode': 'subscribe', 'hub.topic': FEED, 'hub.challenge': 'c3' })).toEqual({ status: 200, body: 'c3' })
    expect(pushRow(raw)!.state).toBe('active') // the hub is answered — no retry, no state oracle
    expect(count(raw, 'acquisition_runs_v2')).toBe(0) // …but nothing is acquired
    repo.close()
  }
})

// --- Step 2: the fat ping ----------------------------------------------------

test('an unknown fat-ping token is 404', async () => {
  const { repo, raw, push } = await fresh()
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw)
  const body = RSS(item('g1'))
  expect(await push.websubDeliver('nope', body, sign(body))).toBe(404)
  repo.close()
})

test('a bad or missing HMAC is a SILENT 202 — logged, discarded, never 4xx (v1 H2)', async () => {
  const { repo, raw, push } = await fresh()
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw)
  const body = RSS(item('g1'))
  const errors: unknown[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args[0]) })

  expect(await push.websubDeliver(TOKEN, body, sign(body, 'wrong-secret'))).toBe(202)
  expect(await push.websubDeliver(TOKEN, body, null)).toBe(202)
  expect(await push.websubDeliver(TOKEN, body, 'garbage')).toBe(202)
  spy.mockRestore()

  expect(errors.filter((e) => String(e).includes('bad or missing signature')).length).toBe(3)
  expect(count(raw, 'acquisition_runs_v2')).toBe(0)
  expect(count(raw, 'observation_versions_v2')).toBe(0)
  repo.close()
})

test('an authenticated fat ping enters the SAME acquisition path as a poll — no fetch, delivery_mechanism=push', async () => {
  const { repo, raw, push } = await fresh() // refusingFetch: any feed fetch fails the test
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw)
  const body = RSS(item('g1') + item('g2'), HUB_ADVERT)

  expect(await push.websubDeliver(TOKEN, body, sign(body))).toBe(202)

  // the run row: V2's EXISTING reason vocabulary + the push delivery mechanism (FC1)
  expect(runs(raw)).toEqual([{ reason: 'scheduled', outcome: 'parsed', delivery_mechanism: 'push' }])
  // the observation writer and the reconciliation jobs ran, exactly as for a poll
  expect(count(raw, 'deliveries_v2')).toBe(2)
  expect(count(raw, 'observation_versions_v2')).toBe(2)
  expect(count(raw, 'reconciliation_jobs_v2')).toBe(2)
  // the delivered body's own capability claim is captured as inert run evidence
  const cap = (raw.prepare(`SELECT push_capability_json AS c FROM acquisition_runs_v2`).get() as { c: string | null }).c
  expect(JSON.parse(cap ?? 'null')).toEqual({ mode: 'websub', endpoint: HUB, topic: FEED })
  repo.close()
})

test('a fat ping resolves a relative permalink against the SAME post-redirect base a poll would use (V4 Task 3 review pin)', async () => {
  // remote_sources_v2.canonical_url is NEVER updated on a permanent redirect —
  // only source_aliases_v2 gains a row. A push carries no fetch, so it cannot
  // re-walk the redirect chain the way a poll does; it must instead reuse the
  // post-redirect location the poll already recorded (source_validators_v2),
  // or a relative link in the pushed document resolves against the stale,
  // pre-redirect host.
  const OLD = 'https://old.blog.test/feed'
  const NEW = 'https://new.blog.test/feed'
  const hEntry = (href: string): string => `<article class="h-entry"><a class="u-url" href="${href}">l</a><h1 class="p-name">T</h1><div class="e-content">c</div><time class="dt-published">2026-01-01</time></article>`
  const hfeedHtml = (href: string): string => `<html><body><div class="h-feed">${hEntry(href)}</div></body></html>`

  const { fn: fetchFn } = routedFetch({
    [OLD]: () => new Response(null, { status: 301, headers: { location: NEW } }),
    [NEW]: () => new Response(hfeedHtml('/from-poll'), { status: 200, headers: { 'last-modified': 'Wed, 24 Jul 2026 00:00:00 GMT' } }),
  })
  const { repo, raw, acquisition } = await fresh({ fetchFn })
  seedSource(raw, 's1', OLD)

  // A normal poll follows the permanent redirect and records source_validators_v2
  // keyed at NEW — the same state readContext already trusts for conditional GETs.
  await acquisition.acquireSource('s1', { kind: 'scheduled' })
  const validatorRow = raw.prepare(`SELECT effective_url FROM source_validators_v2 WHERE source_id = ?`).get('s1') as { effective_url: string } | undefined
  expect(validatorRow?.effective_url).toBe(NEW)

  // A fat ping delivers an h-feed document with a RELATIVE permalink — the
  // engine never fetches for a push, so the base must come from the recorded
  // post-redirect location, not canonical_url (still OLD; never updated).
  await acquisition.acquireSource('s1', { kind: 'push', document: hfeedHtml('/from-push') })

  const pushDelivery = raw.prepare(`SELECT key FROM deliveries_v2 WHERE source_id = ? AND key LIKE '%from-push%'`).get('s1') as { key: string } | undefined
  expect(pushDelivery?.key).toBe(`${NEW.replace('/feed', '')}/from-push`)
  repo.close()
})

test('a fat ping arriving while an acquisition is in flight is discarded at 202 — the next poll catches up', async () => {
  const { repo, raw, push, acquisition } = await fresh()
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw)
  const body = RSS(item('g1'))
  const spy = vi.spyOn(acquisition, 'inFlight').mockReturnValue(true)
  const errors: unknown[] = []
  const logs = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args[0]) })

  expect(await push.websubDeliver(TOKEN, body, sign(body))).toBe(202)
  logs.mockRestore()
  spy.mockRestore()

  expect(count(raw, 'acquisition_runs_v2')).toBe(0)
  expect(errors.some((e) => String(e).includes('in flight'))).toBe(true)
  repo.close()
})

test('PAUSED or BLOCKED + fat ping: authenticated, neutral 202, body neither parsed nor stored', async () => {
  for (const opts of [{ operation: 'paused' }, { governance: 'blocked' }] as const) {
    const { repo, raw, push } = await fresh()
    await seedSubscribed(raw, repo, 's1', FEED, opts)
    insertPushRow(raw)
    const body = RSS(item('g1'))

    expect(await push.websubDeliver(TOKEN, body, sign(body))).toBe(202)
    expect(count(raw, 'acquisition_runs_v2')).toBe(0)
    expect(count(raw, 'observation_versions_v2')).toBe(0)
    expect(count(raw, 'reconciliation_jobs_v2')).toBe(0)
    repo.close()
  }
})

test('QUARANTINED + enabled ingests normally — governance alone makes the evidence admin-only', async () => {
  const { repo, raw, push } = await fresh()
  await seedSubscribed(raw, repo, 's1', FEED, { governance: 'quarantined' })
  insertPushRow(raw)
  const body = RSS(item('g1'))

  expect(await push.websubDeliver(TOKEN, body, sign(body))).toBe(202)
  expect(runs(raw)).toEqual([{ reason: 'scheduled', outcome: 'parsed', delivery_mechanism: 'push' }])
  expect(count(raw, 'observation_versions_v2')).toBe(1)
  repo.close()
})

// --- Step 3: the thin ping and the rssCloud challenge ------------------------

test('an unknown thin-ping topic is a neutral 200 no-op — no subscription-list oracle', async () => {
  const { repo, raw, push } = await fresh()
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw, { mode: 'rsscloud', endpoint: CLOUD, secret: null })

  expect(await push.rsscloudPing('https://elsewhere.test/f.xml')).toBe(200)
  await settle()
  expect(count(raw, 'acquisition_runs_v2')).toBe(0)
  repo.close()
})

test('a known eligible topic runs ONE acquisition through the ordinary gate, marked delivery_mechanism=push', async () => {
  const { fn, calls } = routedFetch({ [FEED]: () => new Response(RSS(item('g1')), { status: 200 }) })
  const { repo, raw, push } = await fresh({ fetchFn: fn })
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw, { mode: 'rsscloud', endpoint: CLOUD, secret: null })

  expect(await push.rsscloudPing(FEED)).toBe(200) // fire-and-forget: answered before the run finishes
  await settle()

  expect(calls).toEqual([FEED]) // a thin ping DOES fetch — it carries no document
  expect(runs(raw)).toEqual([{ reason: 'scheduled', outcome: 'parsed', delivery_mechanism: 'push' }])
  expect(count(raw, 'observation_versions_v2')).toBe(1)
  repo.close()
})

test('the 30-second per-topic floor bounds a ping storm (push-in.ts:238-241)', async () => {
  const { fn, calls } = routedFetch({ [FEED]: () => new Response(RSS(item('g1')), { status: 200 }) })
  const { repo, raw, push } = await fresh({ fetchFn: fn })
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw, { mode: 'rsscloud', endpoint: CLOUD, secret: null })

  for (let i = 0; i < 5; i++) expect(await push.rsscloudPing(FEED)).toBe(200)
  await settle()
  expect(calls.length).toBe(1) // four later pings inside the floor fetched nothing
  expect(count(raw, 'acquisition_runs_v2')).toBe(1)
  repo.close()
})

test('PAUSED or BLOCKED + thin ping: 200 without fetching', async () => {
  for (const opts of [{ operation: 'paused' }, { governance: 'blocked' }] as const) {
    const { repo, raw, push } = await fresh() // refusingFetch
    await seedSubscribed(raw, repo, 's1', FEED, opts)
    insertPushRow(raw, { mode: 'rsscloud', endpoint: CLOUD, secret: null })

    expect(await push.rsscloudPing(FEED)).toBe(200)
    await settle()
    expect(count(raw, 'acquisition_runs_v2')).toBe(0)
    repo.close()
  }
})

test('an expired rsscloud lease is not a known topic — the thin ping stays a neutral 200 no-op', async () => {
  const { repo, raw, push } = await fresh()
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw, { mode: 'rsscloud', endpoint: CLOUD, secret: null, expires_at: iso(Date.now() - 1000) })

  expect(await push.rsscloudPing(FEED)).toBe(200)
  await settle()
  expect(count(raw, 'acquisition_runs_v2')).toBe(0)
  repo.close()
})

test('the rssCloud challenge confirms a known topic and 404s an unknown one (push-in.ts:231-234)', async () => {
  const { repo, raw, push } = await fresh()
  await seedSubscribed(raw, repo, 's1', FEED)
  insertPushRow(raw, { mode: 'rsscloud', endpoint: CLOUD, secret: null })

  expect(await push.rsscloudChallenge(FEED, 'ch-1')).toEqual({ status: 200, body: 'confirming ch-1' })
  expect(await push.rsscloudChallenge('https://elsewhere.test/f.xml', 'ch-1')).toEqual({ status: 404, body: 'unknown' })
  repo.close()
})

// --- the RUNTIME COMPOSITION gate --------------------------------------------
// SchedulerDeps.push can be forgotten at the runtime call site with a fully green
// suite — the failure mode this milestone has produced four times. This test is
// the guard: it drives a REAL createLogicalRuntime through a REAL poll pass over a
// real acquisition engine and asserts a push_subscriptions_v2 row is written.
// Remove `push` from runtime.ts's createScheduler call and this goes red.

test('createLogicalRuntime wires the push lifecycle into the scheduler: a poll pass registers a lease', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  const { fn: fetchFn, calls } = routedFetch({
    [FEED]: () => new Response(RSS(item('g1'), HUB_ADVERT), { status: 200 }),
    [HUB]: () => new Response('', { status: 202 }),
  })
  const acquisition = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  const runtime = createLogicalRuntime({
    db, store, acquisition, config: loadConfig({ ...ENV, RSC_POLL_SECONDS: '9999' }),
    now: () => NOW, fetchFn, lookupFn: publicLookup,
  })
  await runtime.ready
  await runtime.stop() // the startup tick polled nothing: the source is seeded below

  await seedSubscribed(raw, repo, 's1', FEED)
  expect(await runtime.scheduler.pollDue(NOW)).toBe(1)

  // The poll acquired the feed, captured its hub advertisement, and the push
  // lifecycle registered from that run's claim — all inside ONE pass.
  const row = pushRow(raw)
  expect(row).toBeTruthy()
  expect({ mode: row!.mode, endpoint: row!.endpoint, topic: row!.topic, state: row!.state })
    .toEqual({ mode: 'websub', endpoint: HUB, topic: FEED, state: 'pending' })
  expect(calls).toEqual([FEED, HUB]) // the subscribe POST actually went out
  repo.close()
})

test('the runtime exposes the four callbacks, so server.ts can route them at the v2 lifecycle', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  const runtime = createLogicalRuntime({
    db, store, acquisition: createAcquisition({ db, fetchFn: refusingFetch(), lookupFn: publicLookup, now: () => NOW }),
    config: loadConfig({ ...ENV, RSC_POLL_SECONDS: '9999' }), now: () => NOW, fetchFn: refusingFetch(), lookupFn: publicLookup,
  })
  await runtime.ready
  await runtime.stop()

  for (const name of ['websubVerify', 'websubDeliver', 'rsscloudChallenge', 'rsscloudPing'] as const) {
    expect(typeof runtime.push[name]).toBe('function')
  }
  // …and they answer against the v2 relation, not v1's push_subscriptions.
  expect(await runtime.push.websubVerify('nope', {})).toEqual({ status: 404, body: 'unknown subscription' })
  expect(count(raw, 'push_subscriptions_v2')).toBe(0)
  repo.close()
})
