import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

// checkCallbackUrl runs real DNS for hostnames and the sandbox has no network,
// so every subscribable URL is a TEST-NET-3 literal (RFC 5737) — classified
// public without a DNS round trip.
const FEED_URL = 'https://203.0.113.70/f.xml'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, store)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo,
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { app, repo, service }
}

async function renameTo(app: Awaited<ReturnType<typeof makeApp>>['app'], cookie: string, handle: string, displayName: string) {
  await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ handle, displayName }) })
}

test('POST /me/follows requires a session', async () => {
  const { app } = await makeApp()
  const res = await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'x' }) })
  expect(res.status).toBe(401)
})

// /me/follows is the LOCAL-ACCOUNT follow edge; the remote half of this route
// went with v1 (a remote shadow account is no longer followable — remote
// following is a source subscription, covered in subscriptions-api /
// source-capability-api). publicFollowing (sqlite.ts:1044) projects a local
// follow as {kind:'local',…}, so that is what the round trip asserts now.
test('follow, list, and unfollow round-trip (local accounts, v2 projection)', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'alice@test.example', repo)
  await renameTo(app, cookie, 'alice', 'Alice')
  const bobCookie = await registeredSession(app, 'bob@test.example', repo)
  await renameTo(app, bobCookie, 'bob', 'Bob')
  const bob = (await (await app.request('/me', { headers: { cookie: bobCookie } })).json()).user

  const f = await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ handle: 'bob' }) })
  expect(f.status).toBe(200)
  const list = await (await app.request('/users/alice/follows')).json()
  expect(list.following).toEqual([{ kind: 'local', id: bob.id, handle: 'bob', displayName: 'Bob' }])

  const d = await app.request('/me/follows/bob', { method: 'DELETE', headers: { cookie } })
  expect(d.status).toBe(200)
  expect((await (await app.request('/users/alice/follows')).json()).following).toEqual([])
  // A local account is never cascade-deleted by an unfollow, so the handle keeps
  // resolving (the webfeed cascade lives in unfollow-cleanup.test.ts).
  expect((await app.request('/me/follows/bob', { method: 'DELETE', headers: { cookie } })).status).toBe(200)
  expect((await app.request('/me/follows/ghost', { method: 'DELETE', headers: { cookie } })).status).toBe(404)
})

test('follow errors: 404 unknown handle; anonymous session CAN follow', async () => {
  const { app, repo } = await makeApp()
  const target = await registeredSession(app, 'target@test.example', repo)
  await renameTo(app, target, 'news', 'News')
  const cookie = await anonSession(app)
  expect((await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ handle: 'ghost' }) })).status).toBe(404)
  expect((await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ handle: 'news' }) })).status).toBe(200)
})

// OPML import is slow (multi-follow); passes ~1.8s isolated but can exceed
// vitest's 5s default under full-suite contention — headroom, not a real hang.
test('POST /me/follows/opml requires registration: 403 anonymous, 200 registered', { timeout: 30000 }, async () => {
  const { app, repo } = await makeApp()
  const opml = `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>t</title></head><body><outline type="rss" text="News" xmlUrl="${FEED_URL}"/></body></opml>`
  const anonCookie = await anonSession(app)
  expect((await app.request('/me/follows/opml', { method: 'POST', headers: { cookie: anonCookie, 'x-rsc-command-id': 'imp-anon' }, body: opml })).status).toBe(403)
  const regCookie = await registeredSession(app, 'importer@test.example', repo)
  const reg = await app.request('/me/follows/opml', { method: 'POST', headers: { cookie: regCookie, 'x-rsc-command-id': 'imp-1' }, body: opml })
  expect(reg.status).toBe(200)
  // v2 import counters (ImportSourcesResult, source-repository.ts:27) replace
  // v1's {followed,created,skipped}.
  expect(await reg.json()).toEqual({ localFollowed: 0, active: 1, pending: 0, unavailable: 0, notSubscribable: 0, capSkipped: 0 })
})

test('GET /users/:handle/stats returns posts, followers and following counts', async () => {
	const { app, repo } = await makeApp()
	const cookie = await registeredSession(app, 'alice@test.example', repo)
	await renameTo(app, cookie, 'alice', 'Alice')
	const bobCookie = await registeredSession(app, 'bob@test.example', repo)
	await renameTo(app, bobCookie, 'bob', 'Bob')

	await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'hi' }) })
	await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: bobCookie }, body: JSON.stringify({ handle: 'alice' }) })

	const res = await app.request('/users/alice/stats')
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ posts: 1, followers: 1, following: 0 })
})

test('GET /users/:handle/stats 404s for an unknown handle', async () => {
	const { app } = await makeApp()
	const res = await app.request('/users/nobody/stats')
	expect(res.status).toBe(404)
})

test('lens query params: both → 400 before resolution, unknown → 404, author lens works', async () => {
  const { app, repo, service } = await makeApp()
  await service.createLocalPostAs('x', 'X', 'x1')
  const post = (await service.getRecentLocalPosts(10))[0]!
  expect((await app.request('/timeline?followed_by=ghost&author=alsoghost')).status).toBe(400) // both, even with unknown handles
  expect((await app.request('/timeline?author=ghost')).status).toBe(404)
  const lens = await (await app.request('/timeline?author=x')).json()
  expect(lens.timeline.map((e: { id: string }) => e.id)).toEqual([post.id])
  repo.close()
})
