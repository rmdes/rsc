import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createPush, handleWebSubRequest, resolveLocalTopic } from '../src/domain/push.ts'
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
