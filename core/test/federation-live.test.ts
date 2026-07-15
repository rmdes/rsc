import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { createPush, handleWebSubRequest } from '../src/domain/push.ts'
import { createPushIn, runPollCycle } from '../src/domain/push-in.ts'
import { loadConfig } from '../src/config.ts'
import type { Hono } from 'hono'

const publicLookup = async () => [{ address: '93.184.216.34' }]

// Bridge: routes absolute URLs to the right in-process app; strips default ports.
function makeBridge(routes: Record<string, Hono>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const origin = `${u.protocol}//${u.hostname}`
    const app = routes[origin]
    if (!app) throw new Error(`bridge: no route for ${origin}`)
    return app.request(u.pathname + u.search, init)
  }) as typeof fetch
}

async function makeInstance(env: Record<string, string>) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const config = loadConfig(env)
  return { repo, bus, service, config }
}

test('REAL-TIME LOOP: B receives A post via WebSub fat ping, no polling', async () => {
  // Instance A: publisher with the M1 self-hosted hub
  const A = await makeInstance({ TEXTCASTER_TOKEN: 'a', TEXTCASTER_PUBLIC_URL: 'https://a.example', TEXTCASTER_WEBSUB: 'self' })
  // Instance B: subscriber
  const B = await makeInstance({ TEXTCASTER_TOKEN: 'b', TEXTCASTER_PUBLIC_URL: 'https://b.example' })

  const routes: Record<string, Hono> = {}
  const bridge = makeBridge(routes)

  const pushA = createPush({ repo: A.repo, config: A.config, fetchFn: bridge })
  const pushInB = createPushIn({ repo: B.repo, config: B.config, fetchFn: bridge, lookupFn: publicLookup })

  const appA = createApp({
    service: A.service, bus: A.bus, token: 'a',
    feeds: { publicUrl: 'https://a.example', hubUrl: 'https://a.example/hub', rssCloud: false },
    pushApi: { websub: (form) => handleWebSubRequest({ repo: A.repo, config: A.config, fetchFn: bridge, lookupFn: publicLookup }, form) },
  })
  const appB = createApp({
    service: B.service, bus: B.bus, token: 'b',
    pushInApi: {
      websubVerify: (token, query) => pushInB.handleWebSubVerification(token, query),
      websubDeliver: (token, body, sig) => pushInB.handleFatPing(token, body, sig, { bus: B.bus }),
    },
  })
  routes['https://a.example'] = appA
  routes['https://b.example'] = appB

  A.bus.onNewPost((e) => { void pushA.onLocalPost(e) })

  // Alice exists on A with a post; B follows her feed
  await A.service.createLocalPostAs('alice', 'Alice', 'pre-existing post')
  const aliceAtB = await B.service.addRemoteUser({ handle: 'alice-a', displayName: 'Alice (A)', feedUrl: 'https://a.example/users/alice/feed.xml' })

  // B's first poll cycle: ingests + discovers A's hub + subscribes
  await runPollCycle({ repo: B.repo, bus: B.bus, config: B.config, pushIn: pushInB, fetchFn: bridge }, 1)
  // A's hub verification is fire-and-forget; wait for B's row to flip active
  await vi.waitFor(async () => {
    const sub = await B.repo.findPushSubscription({ userId: aliceAtB.id, mode: 'websub' })
    expect(sub?.state).toBe('active')
  })

  // THE MOMENT: A posts; the fat ping crosses the bridge; B never polls again.
  const liveSeen = vi.fn()
  B.bus.onNewPost(liveSeen)
  await A.service.createLocalPostAs('alice', 'Alice', 'pushed across instances 🎯')
  await vi.waitFor(async () => {
    const contents = (await B.repo.getTimeline(10)).map((e) => e.content)
    expect(contents).toContain('pushed across instances 🎯')
  })
  expect(liveSeen).toHaveBeenCalled() // B's live timeline saw it too
})

test('tampered fat ping is silently discarded end to end (H2)', async () => {
  const B = await makeInstance({ TEXTCASTER_TOKEN: 'b', TEXTCASTER_PUBLIC_URL: 'https://b.example' })
  const pushInB = createPushIn({ repo: B.repo, config: B.config, lookupFn: publicLookup })
  const u = await B.repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://x.example/f.xml' })
  await B.repo.upsertPushSubscription({ id: 't1', userId: u.id, mode: 'websub', endpoint: 'https://hub.x/h', topic: 'https://x.example/f.xml', callbackToken: 'tok-t', secret: 'shh', state: 'active', expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: '2026-01-01T00:00:00.000Z' })
  const appB = createApp({ service: createService(B.repo, B.bus), bus: B.bus, token: 'b', pushInApi: { websubVerify: (t, q) => pushInB.handleWebSubVerification(t, q), websubDeliver: (t, b2, s) => pushInB.handleFatPing(t, b2, s, { bus: B.bus }) } })
  const body = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><link>https://x</link><description>d</description><item><guid>evil-1</guid><description>evil</description></item></channel></rss>'
  const res = await appB.request('/websub/callback/tok-t', { method: 'POST', headers: { 'x-hub-signature': 'sha256=deadbeef' }, body })
  expect(res.status).toBe(202) // never a 4xx — no oracle, no hub-drop
  expect((await B.repo.getTimeline(10)).length).toBe(0)
})

test('REAL-TIME LOOP (rssCloud): thin ping triggers immediate re-fetch', async () => {
  const A = await makeInstance({ TEXTCASTER_TOKEN: 'a', TEXTCASTER_PUBLIC_URL: 'https://a.example', TEXTCASTER_RSSCLOUD: 'on' })
  const B = await makeInstance({ TEXTCASTER_TOKEN: 'b', TEXTCASTER_PUBLIC_URL: 'https://b.example' })
  const routes: Record<string, Hono> = {}
  const bridge = makeBridge(routes)
  const { handleRssCloudRequest } = await import('../src/domain/push.ts')
  const pushA = createPush({ repo: A.repo, config: A.config, fetchFn: bridge })
  const pushInB = createPushIn({ repo: B.repo, config: B.config, fetchFn: bridge, lookupFn: publicLookup })
  routes['https://a.example'] = createApp({
    service: A.service, bus: A.bus, token: 'a',
    feeds: { publicUrl: 'https://a.example', hubUrl: null, rssCloud: true },
    pushApi: { rsscloud: (form, ip) => handleRssCloudRequest({ repo: A.repo, config: A.config, fetchFn: bridge, lookupFn: publicLookup }, form, ip) },
  })
  routes['https://b.example'] = createApp({
    service: B.service, bus: B.bus, token: 'b',
    pushInApi: {
      websubVerify: (t, q) => pushInB.handleWebSubVerification(t, q),
      websubDeliver: (t, b2, s) => pushInB.handleFatPing(t, b2, s, { bus: B.bus }),
      rsscloudChallenge: (url, ch) => pushInB.handleRssCloudChallenge(url, ch),
      rsscloudPing: (url) => pushInB.handleThinPing(url, { bus: B.bus }),
    },
  })
  A.bus.onNewPost((e) => { void pushA.onLocalPost(e) })

  await A.service.createLocalPostAs('alice', 'Alice', 'cloud seed')
  const aliceAtB = await B.service.addRemoteUser({ handle: 'alice-c', displayName: 'Alice (cloud)', feedUrl: 'https://a.example/users/alice/feed.xml' })
  await runPollCycle({ repo: B.repo, bus: B.bus, config: B.config, pushIn: pushInB, fetchFn: bridge }, 1)
  await vi.waitFor(async () => expect((await B.repo.findPushSubscription({ userId: aliceAtB.id, mode: 'rsscloud' }))?.state).toBe('active'))

  await A.service.createLocalPostAs('alice', 'Alice', 'thin-pinged across 🌩')
  await vi.waitFor(async () => {
    expect((await B.repo.getTimeline(10)).map((e) => e.content)).toContain('thin-pinged across 🌩')
  })
})
