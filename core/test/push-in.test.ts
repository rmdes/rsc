import { test, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { choosePushTarget, createPushIn, runPollCycle, pushInEffective, verifySignature } from '../src/domain/push-in.ts'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { loadConfig } from '../src/config.ts'

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

const PUSHIN_ENV = { RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://b.example.com' }
const publicLookup = async () => [{ address: '93.184.216.34' }]
const HUB_DISCOVERY = { hubs: ['https://hub.example.com/hub'], self: 'https://blog.example.com/feed.xml', cloud: null }

async function pushInSetup(env: Record<string, string> = PUSHIN_ENV) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const config = loadConfig(env)
  return { repo, bus, config }
}

test('pushInEffective requires both the switch and a public URL', () => {
  expect(pushInEffective(loadConfig(PUSHIN_ENV))).toBe(true)
  expect(pushInEffective(loadConfig({ ...PUSHIN_ENV, RSC_PUSH_IN: 'off' }))).toBe(false)
  expect(pushInEffective(loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' }))).toBe(false)
})

test('maybeSubscribe creates a pending row and POSTs the hub with the STORED token', async () => {
  const { repo, config } = await pushInSetup()
  const user = await repo.createRemoteUser({ handle: 'blog', displayName: 'B', feedUrl: 'https://blog.example.com/feed.xml' })
  const calls: Array<{ url: string; body: URLSearchParams; redirect: string | undefined }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)), redirect: init?.redirect as string | undefined })
    return new Response('', { status: 202 })
  })
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await pushIn.maybeSubscribe(user, HUB_DISCOVERY)
  const row = await repo.findPushSubscription({ userId: user.id, mode: 'websub' })
  expect(row?.state).toBe('pending')
  expect(row?.secret).toBeTruthy()
  const call = calls[0]
  expect(call.url).toBe('https://hub.example.com/hub')
  expect(call.redirect).toBe('manual')
  expect(call.body.get('hub.mode')).toBe('subscribe')
  expect(call.body.get('hub.topic')).toBe('https://blog.example.com/feed.xml')
  expect(call.body.get('hub.callback')).toBe(`https://b.example.com/websub/callback/${row!.callbackToken}`)
  expect(call.body.get('hub.secret')).toBe(row!.secret)

  // R1: a retry (pending row expired) reuses the SAME token/secret in the hub POST
  await repo.upsertPushSubscription({ ...row!, state: 'pending', expiresAt: '2020-01-01T00:00:00.000Z' })
  await pushIn.maybeSubscribe(user, HUB_DISCOVERY)
  const again = calls[1]
  expect(again.body.get('hub.callback')).toBe(`https://b.example.com/websub/callback/${row!.callbackToken}`)
  expect(again.body.get('hub.secret')).toBe(row!.secret)
})

test('maybeSubscribe skips when a live subscription exists, when the endpoint is private, and when ineffective', async () => {
  const { repo, config } = await pushInSetup()
  const user = await repo.createRemoteUser({ handle: 'blog', displayName: 'B', feedUrl: 'https://blog.example.com/feed.xml' })
  const fetchFn = vi.fn(async () => new Response('', { status: 202 }))
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await pushIn.maybeSubscribe(user, HUB_DISCOVERY)
  fetchFn.mockClear()
  await pushIn.maybeSubscribe(user, HUB_DISCOVERY) // unexpired pending row exists → skip (H3 gate)
  expect(fetchFn).not.toHaveBeenCalled()

  const user2 = await repo.createRemoteUser({ handle: 'evil', displayName: 'E', feedUrl: 'https://evil.example.com/f.xml' })
  const privateLookup = async () => [{ address: '10.0.0.5' }]
  const guarded = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: privateLookup })
  await guarded.maybeSubscribe(user2, { hubs: ['https://internal.example.com/hub'], self: null, cloud: null })
  expect(fetchFn).not.toHaveBeenCalled() // guard rejected → no request, no row
  expect(await repo.findPushSubscription({ userId: user2.id, mode: 'websub' })).toBeUndefined()

  const off = createPushIn({ repo, config: loadConfig({ ...PUSHIN_ENV, RSC_PUSH_IN: 'off' }), fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await off.maybeSubscribe(user2, HUB_DISCOVERY)
  expect(fetchFn).not.toHaveBeenCalled()
})

test('rsscloud registration marks active on 2xx with 25h expiry', async () => {
  const { repo, config } = await pushInSetup()
  const user = await repo.createRemoteUser({ handle: 'cloudy', displayName: 'C', feedUrl: 'https://cloudy.example.com/rss.xml' })
  const calls: URLSearchParams[] = []
  const fetchFn = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => { calls.push(new URLSearchParams(String(init?.body))); return new Response('', { status: 200 }) })
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await pushIn.maybeSubscribe(user, { hubs: [], self: null, cloud: { domain: 'cloudy.example.com', port: 5337, path: '/rsscloud/pleaseNotify', protocol: 'http-post' } })
  const row = await repo.findPushSubscription({ userId: user.id, mode: 'rsscloud' })
  expect(row?.state).toBe('active')
  expect(Date.parse(row!.expiresAt)).toBeGreaterThan(Date.now() + 24 * 3600 * 1000)
  expect(calls[0].get('protocol')).toBe('http-post')
  expect(calls[0].get('url1')).toBe('https://cloudy.example.com/rss.xml')
  expect(calls[0].get('path')).toBe('/rsscloud/notify')
  expect(calls[0].get('domain')).toBe('b.example.com')
})

test('rsscloud row exists BEFORE the register POST resolves, so the in-flight challenge finds it', async () => {
  const { repo, config } = await pushInSetup()
  const user = await repo.createRemoteUser({ handle: 'cloudy', displayName: 'C', feedUrl: 'https://cloudy.example.com/rss.xml' })
  let challenged: { status: number; body: string } | null = null
  const fetchFn = vi.fn(async () => {
    // Publisher's challenge GET arrives while the register POST is still in flight.
    challenged = await pushIn.handleRssCloudChallenge('https://cloudy.example.com/rss.xml', 'chal')
    return new Response('', { status: 200 })
  })
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await pushIn.maybeSubscribe(user, { hubs: [], self: null, cloud: { domain: 'cloudy.example.com', port: 5337, path: '/rsscloud/pleaseNotify', protocol: 'http-post' } })
  expect(challenged).toEqual({ status: 200, body: 'confirming chal' })
  expect((await repo.findPushSubscription({ userId: user.id, mode: 'rsscloud' }))?.state).toBe('active')
})

test('renewDue re-subscribes websub near lease end and re-registers rsscloud near expiry', async () => {
  const { repo, config } = await pushInSetup()
  const u1 = await repo.createRemoteUser({ handle: 'blog', displayName: 'B', feedUrl: 'https://blog.example.com/feed.xml' })
  const u2 = await repo.createRemoteUser({ handle: 'cloudy', displayName: 'C', feedUrl: 'https://cloudy.example.com/rss.xml' })
  const soonWebsub = new Date(Date.now() + 3600 * 1000).toISOString() // 1h left — within 1-day horizon
  const soonCloud = new Date(Date.now() + 1800 * 1000).toISOString() // 30min left — within 2h horizon
  await repo.upsertPushSubscription({ id: 'w1', userId: u1.id, mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://blog.example.com/feed.xml', callbackToken: 'tok-w', secret: 'sec-w', state: 'active', expiresAt: soonWebsub, createdAt: '2026-01-01T00:00:00.000Z' })
  await repo.upsertPushSubscription({ id: 'c1', userId: u2.id, mode: 'rsscloud', endpoint: 'http://cloudy.example.com:5337/rsscloud/pleaseNotify', topic: 'https://cloudy.example.com/rss.xml', callbackToken: 'tok-c', secret: null, state: 'active', expiresAt: soonCloud, createdAt: '2026-01-01T00:00:00.000Z' })
  const calls: Array<{ url: string; body: URLSearchParams }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)) }); return new Response('', { status: 202 }) })
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await pushIn.renewDue()
  const websubCall = calls.find((c) => c.url === 'https://hub.example.com/hub')
  expect(websubCall?.body.get('hub.callback')).toContain('tok-w') // H4: stored token reused
  expect(calls.some((c) => c.url === 'http://cloudy.example.com:5337/rsscloud/pleaseNotify')).toBe(true)
})

test('active rsscloud upgrades to websub when the feed starts advertising a hub; websub never downgrades', async () => {
  const { repo, config } = await pushInSetup()
  const user = await repo.createRemoteUser({ handle: 'blog', displayName: 'B', feedUrl: 'https://blog.example.com/feed.xml' })
  await repo.upsertPushSubscription({ id: 'c1', userId: user.id, mode: 'rsscloud', endpoint: 'http://blog.example.com:5337/rsscloud/pleaseNotify', topic: 'https://blog.example.com/feed.xml', callbackToken: 'tok-c', secret: null, state: 'active', expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const fetchFn = vi.fn(async () => new Response('', { status: 202 }))
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })

  await pushIn.maybeSubscribe(user, HUB_DISCOVERY) // feed now advertises a hub
  const websub = await repo.findPushSubscription({ userId: user.id, mode: 'websub' })
  expect(websub?.state).toBe('pending') // upgrade attempted despite the live rsscloud row

  // the hub verifies → websub activates → the rsscloud fallback row is deleted
  await pushIn.handleWebSubVerification(websub!.callbackToken, { 'hub.mode': 'subscribe', 'hub.topic': websub!.topic, 'hub.challenge': 'ch', 'hub.lease_seconds': '3600' })
  expect(await repo.findPushSubscription({ userId: user.id, mode: 'rsscloud' })).toBeUndefined()
  expect((await repo.findPushSubscription({ userId: user.id, mode: 'websub' }))?.state).toBe('active')

  // reverse direction: an active websub sub is never replaced by a cloud fallback
  const user2 = await repo.createRemoteUser({ handle: 'w', displayName: 'W', feedUrl: 'https://w.example.com/feed.xml' })
  await repo.upsertPushSubscription({ id: 'w9', userId: user2.id, mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://w.example.com/feed.xml', callbackToken: 'tok-w9', secret: 's', state: 'active', expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  await pushIn.maybeSubscribe(user2, { hubs: [], self: null, cloud: { domain: 'w.example.com', port: 5337, path: '/rsscloud/pleaseNotify', protocol: 'http-post' } })
  expect(await repo.findPushSubscription({ userId: user2.id, mode: 'rsscloud' })).toBeUndefined()
})

test('renewDue floors retries per subscription — a dead hub is retried hourly, not every tick', async () => {
  const { repo, config } = await pushInSetup()
  const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'B', feedUrl: 'https://blog.example.com/feed.xml' })
  const soon = new Date(Date.now() + 3600 * 1000).toISOString()
  await repo.upsertPushSubscription({ id: 'w1', userId: u.id, mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://blog.example.com/feed.xml', callbackToken: 'tok-w', secret: 'sec', state: 'active', expiresAt: soon, createdAt: '2026-01-01T00:00:00.000Z' })
  const fetchFn = vi.fn(async () => new Response('', { status: 502 })) // hub is down
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await pushIn.renewDue()
  await pushIn.renewDue() // same tick-cadence call — must be floored, not re-sent
  expect(fetchFn).toHaveBeenCalledTimes(1)
})

test('runPollCycle slow-polls push-active feeds and discovers on polled ones', async () => {
  const { repo, bus, config } = await pushInSetup()
  const pushed = await repo.createRemoteUser({ handle: 'pushed', displayName: 'P', feedUrl: 'https://pushed.example.com/feed.xml' })
  const plain = await repo.createRemoteUser({ handle: 'plain', displayName: 'Q', feedUrl: 'https://plain.example.com/feed.xml' })
  await repo.upsertPushSubscription({ id: 'a1', userId: pushed.id, mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://pushed.example.com/feed.xml', callbackToken: 'tok-a', secret: 's', state: 'active', expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const fetched: string[] = []
  const emptyRss = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><link>https://x</link><description>d</description></channel></rss>'
  const fetchFn = vi.fn(async (url: string | URL | Request) => { fetched.push(String(url)); return new Response(emptyRss, { headers: { 'content-type': 'application/rss+xml' } }) })
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })
  await runPollCycle({ repo, bus, config, pushIn, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup }, 1)
  expect(fetched).toContain('https://plain.example.com/feed.xml')
  expect(fetched).not.toContain('https://pushed.example.com/feed.xml') // slow-polled away on tick 1
  fetched.length = 0
  await runPollCycle({ repo, bus, config, pushIn, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup }, 10)
  expect(fetched).toContain('https://pushed.example.com/feed.xml') // 10th tick polls everything
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

test('websub verification GET is state-agnostic, flips to active with granted lease, handles denied', async () => {
  const { repo, config } = await pushInSetup()
  const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'B', feedUrl: 'https://blog.example.com/feed.xml' })
  await repo.upsertPushSubscription({ id: 'v1', userId: u.id, mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://blog.example.com/feed.xml', callbackToken: 'tok-v', secret: 'sec-v', state: 'pending', expiresAt: new Date(Date.now() + 600000).toISOString(), createdAt: '2026-01-01T00:00:00.000Z' })
  const pushIn = createPushIn({ repo, config, lookupFn: publicLookup })

  const ok = await pushIn.handleWebSubVerification('tok-v', { 'hub.mode': 'subscribe', 'hub.topic': 'https://blog.example.com/feed.xml', 'hub.challenge': 'chal-123', 'hub.lease_seconds': '432000' })
  expect(ok).toEqual({ status: 200, body: 'chal-123' })
  const row = await repo.findPushSubscription({ token: 'tok-v' })
  expect(row?.state).toBe('active')
  expect(Date.parse(row!.expiresAt)).toBeGreaterThan(Date.now() + 4 * 86400 * 1000)
  const firstExpiresAt = row!.expiresAt

  // re-verification while ACTIVE (renewal) still echoes — state-agnostic; renewal with larger lease bumps expiry
  const again = await pushIn.handleWebSubVerification('tok-v', { 'hub.mode': 'subscribe', 'hub.topic': 'https://blog.example.com/feed.xml', 'hub.challenge': 'chal-456', 'hub.lease_seconds': '864000' })
  expect(again.status).toBe(200)
  const newRow = await repo.findPushSubscription({ token: 'tok-v' })
  expect(Date.parse(newRow!.expiresAt)).toBeGreaterThan(Date.parse(firstExpiresAt))

  expect((await pushIn.handleWebSubVerification('tok-v', { 'hub.mode': 'subscribe', 'hub.topic': 'https://WRONG.example.com/x', 'hub.challenge': 'c' })).status).toBe(404)
  expect((await pushIn.handleWebSubVerification('unknown', { 'hub.mode': 'subscribe', 'hub.topic': 'https://blog.example.com/feed.xml', 'hub.challenge': 'c' })).status).toBe(404)

  expect((await pushIn.handleWebSubVerification('tok-v', { 'hub.mode': 'denied', 'hub.topic': 'https://blog.example.com/feed.xml' })).status).toBe(200)
  expect(await repo.findPushSubscription({ token: 'tok-v' })).toBeUndefined()
})

test('fat ping with a valid signature ingests and emits; invalid → 202 discard (H2)', async () => {
  const { repo, bus, config } = await pushInSetup()
  const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'B', feedUrl: 'https://blog.example.com/feed.xml' })
  await repo.insertPost({ id: 'seed2', authorId: u.id, source: 'remote', guid: 'sg', title: null, content: 'seed', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  await repo.upsertPushSubscription({ id: 'f1', userId: u.id, mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://blog.example.com/feed.xml', callbackToken: 'tok-f', secret: 'sec-f', state: 'active', expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: '2026-01-01T00:00:00.000Z' })
  const pushIn = createPushIn({ repo, config, lookupFn: publicLookup })
  const seen = vi.fn()
  bus.onNewPost(seen)
  const feedBody = '<?xml version="1.0"?><rss version="2.0"><channel><title>P</title><link>https://blog.example.com</link><description>d</description><item><guid>fat-1</guid><description>pushed content</description></item></channel></rss>'
  const goodSig = 'sha1=' + createHmac('sha1', 'sec-f').update(feedBody).digest('hex')

  expect(await pushIn.handleFatPing('tok-f', feedBody, goodSig, { bus })).toBe(202)
  expect(seen).toHaveBeenCalledTimes(1)
  expect((await repo.getTimeline(10)).map((e) => e.guid)).toContain('fat-1')

  const tampered = feedBody.replace('pushed content', 'evil content')
  expect(await pushIn.handleFatPing('tok-f', tampered, goodSig, { bus })).toBe(202) // H2: silent discard, not 4xx
  expect((await repo.getTimeline(10)).some((e) => e.content === 'evil content')).toBe(false)
  expect(await pushIn.handleFatPing('tok-f', feedBody, null, { bus })).toBe(202) // missing sig: same
  expect(await pushIn.handleFatPing('unknown-token', feedBody, goodSig, { bus })).toBe(404)
})

async function rsscloudSetup() {
  const { repo, bus, config } = await pushInSetup()
  const u = await repo.createRemoteUser({ handle: 'cloudy', displayName: 'C', feedUrl: 'https://cloudy.example.com/rss.xml' })
  await repo.upsertPushSubscription({ id: 'rc9', userId: u.id, mode: 'rsscloud', endpoint: 'http://cloudy.example.com:5337/rsscloud/pleaseNotify', topic: 'https://cloudy.example.com/rss.xml', callbackToken: 'tok-rc9', secret: null, state: 'active', expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: '2026-01-01T00:00:00.000Z' })
  return { repo, bus, config, user: u }
}

test('rsscloud challenge echoes only for known topics', async () => {
  const { repo, config } = await rsscloudSetup()
  const pushIn = createPushIn({ repo, config, lookupFn: publicLookup })
  const r = await pushIn.handleRssCloudChallenge('https://cloudy.example.com/rss.xml', 'chz-1')
  expect(r.status).toBe(200)
  expect(r.body).toContain('chz-1')
  expect((await pushIn.handleRssCloudChallenge('https://unknown.example.com/x', 'chz-2')).status).toBe(404)
})

test('thin ping re-fetches the STORED feedUrl once per 30s floor (H5)', async () => {
  const { repo, bus, config } = await rsscloudSetup()
  const rss = '<?xml version="1.0"?><rss version="2.0"><channel><title>C</title><link>https://c</link><description>d</description><item><guid>tp-1</guid><description>thin pinged</description></item></channel></rss>'
  const fetched: string[] = []
  const fetchFn = vi.fn(async (url: string | URL | Request) => { fetched.push(String(url)); return new Response(rss, { headers: { 'content-type': 'application/rss+xml' } }) })
  const pushIn = createPushIn({ repo, config, fetchFn: fetchFn as unknown as typeof fetch, lookupFn: publicLookup })

  expect(await pushIn.handleThinPing('https://cloudy.example.com/rss.xml', { bus })).toBe(200)
  await vi.waitFor(() => expect(fetched).toEqual(['https://cloudy.example.com/rss.xml'])) // stored feedUrl, not the ping url
  await vi.waitFor(async () => expect((await repo.getTimeline(10)).map((e) => e.guid)).toContain('tp-1'))

  expect(await pushIn.handleThinPing('https://cloudy.example.com/rss.xml', { bus })).toBe(200) // within 30s → coalesced
  expect(fetched.length).toBe(1)

  expect(await pushIn.handleThinPing('https://never-subscribed.example.com/x', { bus })).toBe(200) // unknown: 200 no-op, no oracle
  expect(fetched.length).toBe(1)
})
