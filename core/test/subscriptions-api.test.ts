import { test, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo })
  return { app, repo, service }
}

// checkCallbackUrl runs real DNS for hostnames; the test sandbox has no
// network, so success-path URLs use a public IP literal (TEST-NET-3,
// RFC 5737 — reserved for docs, not private per isPrivateIp) which
// checkCallbackUrl accepts without any DNS round-trip.
const PUBLIC_FEED_URL = 'https://203.0.113.10/f.xml'

test('POST /me/subscriptions: registered session subscribes by URL, appears in listRemoteUsers + followed', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'alice@test.example', repo)
  const res = await app.request('/me/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ url: PUBLIC_FEED_URL, type: 'webfeed' }),
  })
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.followed).toBe(true)
  expect(body.user.feedUrl).toBe(PUBLIC_FEED_URL)

  const remotes = await repo.listRemoteUsers()
  expect(remotes.filter((u) => u.feedUrl === PUBLIC_FEED_URL)).toHaveLength(1)
})

test('POST /me/subscriptions: a second identical POST does not duplicate', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'bob@test.example', repo)
  const body = JSON.stringify({ url: PUBLIC_FEED_URL, type: 'webfeed' })
  const first = await app.request('/me/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body })
  const second = await app.request('/me/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body })
  expect(first.status).toBe(201)
  expect(second.status).toBe(200)
  expect((await first.json()).followed).toBe(true)
  expect((await second.json()).followed).toBe(true)
  const remotes = await repo.listRemoteUsers()
  expect(remotes.filter((u) => u.feedUrl === PUBLIC_FEED_URL)).toHaveLength(1)
})

test('POST /me/subscriptions requires a registered session: 401 anonymous session', async () => {
  const { app } = await makeApp()
  const res = await app.request('/me/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://blog.example/f.xml', type: 'webfeed' }),
  })
  expect(res.status).toBe(401)
})

test('POST /me/subscriptions: anonymous session is rejected (registeredOnly)', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/me/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ url: 'https://blog.example/f.xml', type: 'webfeed' }),
  })
  expect(res.status).toBe(403)
})

test('POST /me/subscriptions: missing/empty url or bad type return 400', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'carol@test.example', repo)
  const missing = await app.request('/me/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'webfeed' }) })
  expect(missing.status).toBe(400)
  const empty = await app.request('/me/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ url: '', type: 'webfeed' }) })
  expect(empty.status).toBe(400)
  const badType = await app.request('/me/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ url: 'https://blog.example/f.xml', type: 'bogus' }) })
  expect(badType.status).toBe(400)
})

test('POST /me/subscriptions: a loopback URL is rejected 400 (checkCallbackUrl)', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'dave@test.example', repo)
  const res = await app.request('/me/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ url: 'http://127.0.0.1/x', type: 'webfeed' }),
  })
  expect(res.status).toBe(400)
})

test('POST /me/subscriptions: at cap returns 429', async () => {
  const { app, repo, service } = await makeApp()
  const cookie = await registeredSession(app, 'erin@test.example', repo)
  await service.setSetting('max_subs_per_user', '1')
  const first = await app.request('/me/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ url: 'https://203.0.113.11/f.xml', type: 'webfeed' }) })
  expect(first.status).toBe(201)
  const second = await app.request('/me/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ url: 'https://203.0.113.12/f.xml', type: 'webfeed' }) })
  expect(second.status).toBe(429)
  expect(await second.json()).toEqual({ error: 'subscription limit reached' })
})

test('POST /me/subscriptions: own-instance URL resolves to a local follow, not a remote shadow', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const publicUrl = 'https://203.0.113.9' // IP-literal: a hostname publicUrl would 400 at the SSRF gate first
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, feeds: { publicUrl, hubUrl: null, rssCloud: false } })

  const cookieB = await registeredSession(app, 'ownurl-b@test.example', repo)
  const meB = await (await app.request('/me', { headers: { cookie: cookieB } })).json()
  const bUrl = `${publicUrl}/users/${meB.user.handle}/feed.xml`

  const resB = await app.request('/me/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieB },
    body: JSON.stringify({ url: bUrl, type: 'webfeed' }),
  })
  expect(resB.status).toBe(200)
  const bodyB = await resB.json()
  expect(bodyB.followed).toBe(false) // own URL — self-guard
  expect(bodyB.user.kind).toBe('local')
  const remotes = await repo.listRemoteUsers()
  expect(remotes.filter((u) => u.feedUrl === bUrl)).toHaveLength(0)

  const cookieC = await registeredSession(app, 'ownurl-c@test.example', repo)
  const resC = await app.request('/me/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieC },
    body: JSON.stringify({ url: bUrl, type: 'webfeed' }),
  })
  expect(resC.status).toBe(200)
  const bodyC = await resC.json()
  expect(bodyC.followed).toBe(true)
  expect(bodyC.user.kind).toBe('local')
})

// --- v2 source-control plane routes (RSC_SOURCE_MODEL_V2 on; Task 7) ---
// Everything above this line is the legacy surface and must keep passing
// unchanged while the flag is off — which is the default `makeApp` above.

async function makeV2App() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, sources: { service: createSourceService(repo, null), repo } })
  return { app, repo, service }
}

const V2_URL_A = 'https://203.0.113.40/f.xml'
const V2_URL_B = 'https://203.0.113.41/f.xml'

async function v2Subscribe(app: Hono, cookie: string, url: string, commandId: string) {
  const res = await app.request('/me/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ url, commandId }),
  })
  return (await res.json()).subscription.sourceId as string
}

function unsubscribe(app: Hono, cookie: string, sourceId: string, commandId: string) {
  return app.request(`/me/subscriptions/${sourceId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ commandId }),
  })
}

test('DELETE /me/subscriptions/:sourceId removes by stable id, replays, 404s unknown and 409s a reused command id', async () => {
  const { app, repo } = await makeV2App()
  const cookie = await registeredSession(app, 'unsub@test.example', repo)
  const a = await v2Subscribe(app, cookie, V2_URL_A, 'sub-a')
  const b = await v2Subscribe(app, cookie, V2_URL_B, 'sub-b')

  const removed = await unsubscribe(app, cookie, a, 'del-1')
  expect(removed.status).toBe(200)
  expect(await removed.json()).toEqual({ ok: true })

  const replay = await unsubscribe(app, cookie, a, 'del-1')
  expect(replay.status).toBe(200)
  expect(await replay.json()).toEqual({ ok: true })

  const unknown = await unsubscribe(app, cookie, randomUUID(), 'del-2')
  expect(unknown.status).toBe(404)

  // Same command id, different source → the fingerprint changes → conflict.
  const conflict = await unsubscribe(app, cookie, b, 'del-1')
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({ error: 'idempotency conflict' })

  expect((await unsubscribe(app, cookie, b, 'del-3')).status).toBe(200)
  const view = await (await app.request('/me/following', { headers: { cookie } })).json()
  expect(view.sourceSubscriptions).toEqual([])
  repo.close()
})

test('POST /me/follows/opml (v2) imports under an x-rsc-command-id, replays it, and conflicts on a changed body', async () => {
  const { app, repo } = await makeV2App()
  const cookie = await registeredSession(app, 'v2opml@test.example', repo)
  const opml = (url: string) => `<opml version="2.0"><body><outline type="rss" text="f" xmlUrl="${url}"/></body></opml>`
  const post = (body: string, commandId: string) =>
    app.request('/me/follows/opml', { method: 'POST', headers: { cookie, 'x-rsc-command-id': commandId }, body })

  const first = await post(opml(V2_URL_A), 'imp-1')
  expect(first.status).toBe(200)
  expect(await first.json()).toEqual({ localFollowed: 0, active: 1, pending: 0, unavailable: 0, notSubscribable: 0, capSkipped: 0 })

  const replay = await post(opml(V2_URL_A), 'imp-1')
  expect(replay.status).toBe(200)
  expect(await replay.json()).toEqual({ localFollowed: 0, active: 1, pending: 0, unavailable: 0, notSubscribable: 0, capSkipped: 0 })

  const conflict = await post(opml(V2_URL_B), 'imp-1')
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({ error: 'idempotency conflict' })
  repo.close()
})

test('v2 owner routes still require a session: 401 without one', async () => {
  const { app, repo } = await makeV2App()
  expect((await app.request('/me/following')).status).toBe(401)
  expect((await unsubscribe(app, '', randomUUID(), 'x')).status).toBe(401)
  repo.close()
})

test('POST /users (admin token) creates a feed_type=instance row and no follow edge', async () => {
  const { app, repo } = await makeApp()
  const res = await app.request('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }),
  })
  expect(res.status).toBe(201)
  const created = (await res.json()).user
  expect(created.feedType).toBe('instance')
  const remotes = await repo.listRemoteUsers()
  const row = remotes.find((u) => u.id === created.id)
  expect(row?.feedType).toBe('instance')
  // No follow edge was created for this instance row (unlike subscribeByUrl).
  const followerCount = repo.raw.prepare('SELECT COUNT(*) AS n FROM follows WHERE followed_id = ?').get(created.id) as { n: number }
  expect(followerCount.n).toBe(0)
})
