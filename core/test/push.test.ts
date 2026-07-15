import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createPush, handleWebSubRequest, handleRssCloudRequest, resolveLocalTopic } from '../src/domain/push.ts'
import { loadConfig } from '../src/config.ts'

const EXT_ENV = { TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com', TEXTCASTER_WEBSUB: 'https://hub.example.com/hub' }

async function setup(env: Record<string, string>) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const config = loadConfig(env)
  return { repo, bus, service, config }
}

test('external mode publishes a ping per topic on a local post', async () => {
  const { repo, service, config } = await setup(EXT_ENV)
  const fetchFn = vi.fn(async () => new Response('ok', { status: 204 }))
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  const entry = await service.createLocalPostAs('alice', 'Alice', 'ping-worthy')
  await push.onLocalPost(entry)
  expect(fetchFn).toHaveBeenCalledTimes(2)
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://hub.example.com/hub')
  const params = new URLSearchParams(init.body as string)
  expect(params.get('hub.mode')).toBe('publish')
  expect(params.get('hub.topic')).toBe('https://cast.example.com/users/alice/feed.xml')
  expect(params.get('hub.url')).toBe(params.get('hub.topic'))
})

test('remote posts and websub-off both produce no pings', async () => {
  const { repo, service, config } = await setup(EXT_ENV)
  const fetchFn = vi.fn(async () => new Response('ok'))
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  const remote = await service.addRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://news.example.com/f.xml' })
  await push.onLocalPost({ id: 'x', authorId: remote.id, source: 'remote', guid: 'g', title: null, content: 'c', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', author: remote })
  expect(fetchFn).not.toHaveBeenCalled()

  const off = await setup({ TEXTCASTER_TOKEN: 't' })
  const offPush = createPush({ repo: off.repo, config: off.config, fetchFn: fetchFn as unknown as typeof fetch })
  const entry = await off.service.createLocalPostAs('bob', 'Bob', 'silent')
  await offPush.onLocalPost(entry)
  expect(fetchFn).not.toHaveBeenCalled()
})

test('onLocalPost never rejects, even when fetch explodes (H4)', async () => {
  const { repo, service, config } = await setup(EXT_ENV)
  const fetchFn = vi.fn(async () => { throw new Error('network down') })
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  const entry = await service.createLocalPostAs('alice', 'Alice', 'doomed ping')
  await expect(push.onLocalPost(entry)).resolves.toBeUndefined()
})

const SELF_ENV = { TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com', TEXTCASTER_WEBSUB: 'self' }
const publicLookup = async () => ({ address: '93.184.216.34' })

function subForm(over: Record<string, string> = {}): Record<string, string> {
  return { 'hub.mode': 'subscribe', 'hub.topic': 'https://cast.example.com/users/alice/feed.xml', 'hub.callback': 'https://cb.example.com/receive', ...over }
}

test('resolveLocalTopic: exact equality only, local users only', async () => {
  const { repo, service } = await setup(SELF_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const publicUrl = 'https://cast.example.com'
  expect(await resolveLocalTopic(repo, publicUrl, 'https://cast.example.com/users/alice/feed.xml')).toMatchObject({ format: 'xml' })
  expect(await resolveLocalTopic(repo, publicUrl, 'https://cast.example.com/users/alice/feed.json')).toMatchObject({ format: 'json' })
  expect(await resolveLocalTopic(repo, publicUrl, 'https://cast.example.com/users/alice/feed.xml/')).toBeNull() // trailing slash
  expect(await resolveLocalTopic(repo, publicUrl, 'https://cast.example.com/users/ALICE/feed.xml')).toBeNull() // case variant
  expect(await resolveLocalTopic(repo, publicUrl, 'https://cast.example.com/users/nobody/feed.xml')).toBeNull()
})

test('websub subscribe: challenge echoed -> stored; wrong echo -> not stored', async () => {
  const { repo, service, config } = await setup(SELF_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  let challenged: URL | null = null
  const goodFetch = vi.fn(async (url: string | URL | Request) => {
    challenged = new URL(String(url))
    return new Response(challenged.searchParams.get('hub.challenge') ?? '', { status: 200 })
  })
  const r = await handleWebSubRequest({ repo, config, fetchFn: goodFetch as unknown as typeof fetch, lookupFn: publicLookup }, subForm({ 'hub.secret': 'shh' }))
  expect(r.status).toBe(202)
  await vi.waitFor(async () => {
    const subs = await repo.listActiveSubscriptions('https://cast.example.com/users/alice/feed.xml', '2020-01-01T00:00:00.000Z')
    expect(subs.length).toBe(1)
    expect(subs[0].secret).toBe('shh')
  })
  expect(challenged!.searchParams.get('hub.mode')).toBe('subscribe')
  expect(challenged!.searchParams.get('hub.lease_seconds')).toBeTruthy() // present on subscribe (H7)

  const badFetch = vi.fn(async () => new Response('nope', { status: 200 }))
  const r2 = await handleWebSubRequest({ repo, config, fetchFn: badFetch as unknown as typeof fetch, lookupFn: publicLookup }, subForm({ 'hub.callback': 'https://cb2.example.com/x' }))
  expect(r2.status).toBe(202) // 202 first, verification decides later
  await vi.waitFor(() => expect(badFetch).toHaveBeenCalledTimes(1)) // verification GET happened...
  await new Promise((res) => setImmediate(res)) // ...and its rejection settled
  expect(await repo.countActiveSubscriptions({ callbackHost: 'cb2.example.com' }, '2020-01-01T00:00:00.000Z')).toBe(0)
})

test('websub unsubscribe verification carries NO lease_seconds and deletes (H7)', async () => {
  const { repo, service, config } = await setup(SELF_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const echo = vi.fn(async (url: string | URL | Request) => new Response(new URL(String(url)).searchParams.get('hub.challenge') ?? '', { status: 200 }))
  const deps = { repo, config, fetchFn: echo as unknown as typeof fetch, lookupFn: publicLookup }
  await handleWebSubRequest(deps, subForm())
  await vi.waitFor(async () => expect(await repo.countActiveSubscriptions({ callbackHost: 'cb.example.com' }, '2020-01-01T00:00:00.000Z')).toBe(1))
  await handleWebSubRequest(deps, subForm({ 'hub.mode': 'unsubscribe' }))
  await vi.waitFor(async () => expect(await repo.countActiveSubscriptions({ callbackHost: 'cb.example.com' }, '2020-01-01T00:00:00.000Z')).toBe(0))
  const unsubUrl = new URL(String(echo.mock.calls[1][0]))
  expect(unsubUrl.searchParams.get('hub.mode')).toBe('unsubscribe')
  expect(unsubUrl.searchParams.get('hub.lease_seconds')).toBeNull()
})

test('websub subscribe rejects bad topics, private callbacks, and over-cap hosts', async () => {
  const { repo, service, config } = await setup(SELF_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const echo = vi.fn(async (url: string | URL | Request) => new Response(new URL(String(url)).searchParams.get('hub.challenge') ?? '', { status: 200 }))
  const deps = { repo, config, fetchFn: echo as unknown as typeof fetch, lookupFn: publicLookup }
  expect((await handleWebSubRequest(deps, subForm({ 'hub.topic': 'https://elsewhere.example.com/feed.xml' }))).status).toBe(404)
  expect((await handleWebSubRequest(deps, subForm({ 'hub.callback': 'http://127.0.0.1/x' }))).status).toBe(400)
  expect((await handleWebSubRequest(deps, subForm({ 'hub.mode': 'dance' }))).status).toBe(400)
  // fill the per-host cap directly, then one more is refused
  for (let i = 0; i < 20; i++) {
    await repo.upsertSubscription({ id: `cap${i}`, protocol: 'websub', topic: 'https://cast.example.com/users/alice/feed.xml', callback: `https://full.example.com/cb${i}`, callbackHost: 'full.example.com', secret: null, expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  }
  const capLookup = async () => ({ address: '93.184.216.34' })
  expect((await handleWebSubRequest({ ...deps, lookupFn: capLookup }, subForm({ 'hub.callback': 'https://full.example.com/one-more' }))).status).toBe(429)
})

test('self mode delivers the fat ping with HMAC signature; expired subs skipped; failures retried once', async () => {
  const { repo, service, config } = await setup(SELF_ENV)
  const entrySeed = await service.createLocalPostAs('alice', 'Alice', 'first body')
  const topic = 'https://cast.example.com/users/alice/feed.xml'
  await repo.upsertSubscription({ id: 's1', protocol: 'websub', topic, callback: 'https://cb.example.com/receive', callbackHost: 'cb.example.com', secret: 'shh', expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  await repo.upsertSubscription({ id: 's2', protocol: 'websub', topic, callback: 'https://dead.example.com/receive', callbackHost: 'dead.example.com', secret: null, expiresAt: '2020-01-01T00:00:00.000Z', createdAt: '2019-01-01T00:00:00.000Z' })
  const calls: Array<{ url: string; body: string; sig: string | null; ct: string | null }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body), sig: new Headers(init?.headers).get('x-hub-signature'), ct: new Headers(init?.headers).get('content-type') })
    return new Response('', { status: 200 })
  })
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  await push.onLocalPost(entrySeed)
  const xmlDeliveries = calls.filter((c) => c.url === 'https://cb.example.com/receive')
  expect(xmlDeliveries.length).toBe(1)
  expect(xmlDeliveries[0].ct).toContain('application/rss+xml')
  expect(xmlDeliveries[0].body).toContain('first body')
  const { createHmac } = await import('node:crypto')
  expect(xmlDeliveries[0].sig).toBe('sha256=' + createHmac('sha256', 'shh').update(xmlDeliveries[0].body).digest('hex'))
  expect(calls.some((c) => c.url === 'https://dead.example.com/receive')).toBe(false)

  // failure path: one retry then drop, never throwing
  const flaky = vi.fn(async () => { throw new Error('conn refused') })
  const push2 = createPush({ repo, config, fetchFn: flaky as unknown as typeof fetch })
  await expect(push2.onLocalPost(entrySeed)).resolves.toBeUndefined()
  expect(flaky.mock.calls.length).toBe(2) // 1 attempt + 1 retry for the one live xml-topic subscriber
})

test('renewing an existing subscription is not blocked by the per-host cap', async () => {
  const { repo, service, config } = await setup(SELF_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const topic = 'https://cast.example.com/users/alice/feed.xml'
  // fill the host cap, with cb0 being the one we will renew
  for (let i = 0; i < 20; i++) {
    await repo.upsertSubscription({ id: `cap${i}`, protocol: 'websub', topic, callback: `https://full.example.com/cb${i}`, callbackHost: 'full.example.com', secret: null, expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  }
  const echo = vi.fn(async (url: string | URL | Request) => new Response(new URL(String(url)).searchParams.get('hub.challenge') ?? '', { status: 200 }))
  const deps = { repo, config, fetchFn: echo as unknown as typeof fetch, lookupFn: publicLookup }
  // renewal of an existing triple: allowed despite the full cap
  const renew = await handleWebSubRequest(deps, subForm({ 'hub.callback': 'https://full.example.com/cb0', 'hub.secret': 'renewed' }))
  expect(renew.status).toBe(202)
  await vi.waitFor(async () => {
    const subs = await repo.listActiveSubscriptions(topic, '2020-01-01T00:00:00.000Z')
    expect(subs.find((s) => s.callback === 'https://full.example.com/cb0')?.secret).toBe('renewed')
  })
  // a genuinely new callback on the same host is still capped
  expect((await handleWebSubRequest(deps, subForm({ 'hub.callback': 'https://full.example.com/brand-new' }))).status).toBe(429)
})

const CLOUD_ENV = { TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com', TEXTCASTER_RSSCLOUD: 'on' }

function cloudForm(over: Record<string, string> = {}): Record<string, string> {
  return { notifyProcedure: '', port: '5337', path: '/rsscloud/notify', protocol: 'http-post', url1: 'https://cast.example.com/users/alice/feed.xml', domain: 'cb.example.com', ...over }
}

test('rsscloud registration is challenge-verified even without domain (spec deviation, deliberate)', async () => {
  const { repo, service, config } = await setup(CLOUD_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const echo = vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url))
    return new Response('confirming challenge ' + u.searchParams.get('challenge'), { status: 200 })
  })
  const deps = { repo, config, fetchFn: echo as unknown as typeof fetch, lookupFn: publicLookup }
  // with domain
  expect((await handleRssCloudRequest(deps, cloudForm(), null)).status).toBe(202)
  await vi.waitFor(async () => expect(await repo.countActiveSubscriptions({ callbackHost: 'cb.example.com' }, '2020-01-01T00:00:00.000Z')).toBe(1))
  // without domain: requester IP becomes the callback host — still challenged
  expect((await handleRssCloudRequest(deps, cloudForm({ domain: '' }), '93.184.216.34')).status).toBe(202)
  await vi.waitFor(async () => expect(await repo.countActiveSubscriptions({ callbackHost: '93.184.216.34' }, '2020-01-01T00:00:00.000Z')).toBe(1))
  // registered callback shape: http://host:port/path
  const subs = await repo.listActiveSubscriptions('https://cast.example.com/users/alice/feed.xml', '2020-01-01T00:00:00.000Z')
  expect(subs.map((s) => s.callback).sort()).toEqual(['http://93.184.216.34:5337/rsscloud/notify', 'http://cb.example.com:5337/rsscloud/notify'])
  // 25h expiry
  const in24h = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  const in26h = new Date(Date.now() + 26 * 3600 * 1000).toISOString()
  expect(await repo.countActiveSubscriptions({ topic: 'https://cast.example.com/users/alice/feed.xml' }, in24h)).toBe(2)
  expect(await repo.countActiveSubscriptions({ topic: 'https://cast.example.com/users/alice/feed.xml' }, in26h)).toBe(0)
})

test('rsscloud rejects non-http-post, unknown topics, and missing ip+domain', async () => {
  const { repo, service, config } = await setup(CLOUD_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const deps = { repo, config, fetchFn: (async () => new Response('')) as unknown as typeof fetch, lookupFn: publicLookup }
  expect((await handleRssCloudRequest(deps, cloudForm({ protocol: 'xml-rpc' }), null)).status).toBe(400)
  expect((await handleRssCloudRequest(deps, cloudForm({ url1: 'https://cast.example.com/users/alice/feed.json' }), null)).status).toBe(404) // rssCloud is RSS-only
  expect((await handleRssCloudRequest(deps, cloudForm({ domain: '' }), null)).status).toBe(400)
})

test('rsscloud thin ping goes to xml-topic subscribers on a local post', async () => {
  const { repo, service, config } = await setup(CLOUD_ENV)
  const entry = await service.createLocalPostAs('alice', 'Alice', 'ping me thin')
  await repo.upsertSubscription({ id: 'rc1', protocol: 'rsscloud', topic: 'https://cast.example.com/users/alice/feed.xml', callback: 'http://cb.example.com:5337/rsscloud/notify', callbackHost: 'cb.example.com', secret: null, expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('', { status: 200 }))
  const push = createPush({ repo, config, fetchFn: fetchFn as unknown as typeof fetch })
  await push.onLocalPost(entry)
  const call = fetchFn.mock.calls.find((c2) => String(c2[0]) === 'http://cb.example.com:5337/rsscloud/notify')
  expect(call).toBeTruthy()
  const init = call![1] as RequestInit
  expect(new URLSearchParams(String(init.body)).get('url')).toBe('https://cast.example.com/users/alice/feed.xml')
})

test('renewing an existing rsscloud subscription is not blocked by the per-host cap', async () => {
  const { repo, service, config } = await setup(CLOUD_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const topic = 'https://cast.example.com/users/alice/feed.xml'
  // fill the host cap, with cb0 being the one we will renew
  for (let i = 0; i < 20; i++) {
    await repo.upsertSubscription({ id: `cap${i}`, protocol: 'rsscloud', topic, callback: `http://full.example.com:5337/cb${i}`, callbackHost: 'full.example.com', secret: null, expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  }
  const echo = vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url))
    return new Response('confirming challenge ' + u.searchParams.get('challenge'), { status: 200 })
  })
  const deps = { repo, config, fetchFn: echo as unknown as typeof fetch, lookupFn: publicLookup }
  // renewal of an existing triple: allowed despite the full cap
  const renew = await handleRssCloudRequest(deps, cloudForm({ domain: 'full.example.com', path: '/cb0' }), null)
  expect(renew.status).toBe(202)
  await vi.waitFor(async () => {
    const subs = await repo.listActiveSubscriptions(topic, '2020-01-01T00:00:00.000Z')
    const renewed = subs.find((s) => s.callback === 'http://full.example.com:5337/cb0')
    expect(renewed).toBeTruthy()
    expect(new Date(renewed!.expiresAt).getTime()).toBeGreaterThan(Date.now() + 20 * 3600 * 1000) // fresh 25h lease
  })
  // a genuinely new callback on the same host is still capped
  expect((await handleRssCloudRequest(deps, cloudForm({ domain: 'full.example.com', path: '/brand-new' }), null)).status).toBe(429)
})

test('rsscloud registration whose callback fails the challenge is never stored', async () => {
  const { repo, service, config } = await setup(CLOUD_ENV)
  await service.createLocalPostAs('alice', 'Alice', 'seed')
  const badFetch = vi.fn(async () => new Response('no challenge here', { status: 200 }))
  const deps = { repo, config, fetchFn: badFetch as unknown as typeof fetch, lookupFn: publicLookup }
  const r = await handleRssCloudRequest(deps, cloudForm({ domain: 'never-consented.example.com' }), null)
  expect(r.status).toBe(202) // 202 first; verification decides later
  await vi.waitFor(() => expect(badFetch).toHaveBeenCalledTimes(1)) // challenge GET happened...
  await new Promise((res) => setImmediate(res)) // ...and its rejection settled
  expect(await repo.countActiveSubscriptions({ callbackHost: 'never-consented.example.com' }, '2020-01-01T00:00:00.000Z')).toBe(0)
})

test('all callback-bound fetches opt out of redirect following (SSRF bypass guard)', async () => {
  const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = []
  const recorder = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), redirect: init?.redirect })
    const u = new URL(String(url))
    return new Response(u.searchParams.get('hub.challenge') ?? 'confirming ' + (u.searchParams.get('challenge') ?? ''), { status: 200 })
  })

  // websub challenge GET
  const ws = await setup(SELF_ENV)
  await ws.service.createLocalPostAs('alice', 'Alice', 'seed')
  await handleWebSubRequest({ repo: ws.repo, config: ws.config, fetchFn: recorder as unknown as typeof fetch, lookupFn: publicLookup }, subForm())
  await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1))

  // rsscloud challenge GET
  const rc = await setup(CLOUD_ENV)
  await rc.service.createLocalPostAs('alice', 'Alice', 'seed')
  await handleRssCloudRequest({ repo: rc.repo, config: rc.config, fetchFn: recorder as unknown as typeof fetch, lookupFn: publicLookup }, cloudForm(), null)
  await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2))

  // delivery POST (fat ping via self mode)
  const topic = 'https://cast.example.com/users/alice/feed.xml'
  await ws.repo.upsertSubscription({ id: 'rd1', protocol: 'websub', topic, callback: 'https://cb.example.com/receive', callbackHost: 'cb.example.com', secret: null, expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const entry = await ws.service.createLocalPostAs('alice', 'Alice', 'redirect-guard post')
  const push = createPush({ repo: ws.repo, config: ws.config, fetchFn: recorder as unknown as typeof fetch })
  await push.onLocalPost(entry)

  const callbackCalls = seen.filter((c) => c.url.includes('cb.example.com'))
  expect(callbackCalls.length).toBeGreaterThanOrEqual(3) // 2 challenges + at least 1 delivery
  for (const call of callbackCalls) expect(call.redirect).toBe('manual')
})
