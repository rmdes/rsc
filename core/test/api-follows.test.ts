import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo })
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

test('follow, list, and unfollow round-trip', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'alice@test.example', repo)
  await renameTo(app, cookie, 'alice', 'Alice')
  await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const f = await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ handle: 'news' }) })
  expect(f.status).toBe(200)
  const list = await (await app.request('/users/alice/follows')).json()
  expect(list.following.map((u: { handle: string }) => u.handle)).toEqual(['news'])
  const d = await app.request('/me/follows/news', { method: 'DELETE', headers: { cookie } })
  expect(d.status).toBe(200) // alice was the last follower of this webfeed → cascade-deleted (task 6)
  const d2 = await app.request('/me/follows/news', { method: 'DELETE', headers: { cookie } }) // handle no longer resolves
  expect(d2.status).toBe(404)
})

test('follow errors: 404 unknown handle; anonymous session CAN follow', async () => {
  const { app, repo } = await makeApp()
  const cookie = await anonSession(app)
  await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  expect((await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ handle: 'ghost' }) })).status).toBe(404)
  expect((await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ handle: 'news' }) })).status).toBe(200)
})

// OPML import is slow (multi-follow); passes ~1.8s isolated but can exceed
// vitest's 5s default under full-suite contention — headroom, not a real hang.
test('POST /me/follows/opml requires registration: 403 anonymous, 200 registered', { timeout: 15000 }, async () => {
  const { app, repo } = await makeApp()
  const opml = '<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>t</title></head><body><outline type="rss" text="News" xmlUrl="https://ex.com/f.xml"/></body></opml>'
  const anonCookie = await anonSession(app)
  expect((await app.request('/me/follows/opml', { method: 'POST', headers: { cookie: anonCookie }, body: opml })).status).toBe(403)
  const regCookie = await registeredSession(app, 'importer@test.example', repo)
  const reg = await app.request('/me/follows/opml', { method: 'POST', headers: { cookie: regCookie }, body: opml })
  expect(reg.status).toBe(200)
  expect(await reg.json()).toEqual({ followed: 1, created: 1, skipped: 0 })
})

test('lens query params: both → 400 before resolution, unknown → 404, author lens works', async () => {
  const { app, repo } = await makeApp()
  const x = await repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://ex.com/x.xml' })
  await repo.insertPost({ id: 'x1', authorId: x.id, source: 'remote', guid: 'x1', title: null, content: 'x1', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  expect((await app.request('/timeline?followed_by=ghost&author=alsoghost')).status).toBe(400) // both, even with unknown handles
  expect((await app.request('/timeline?author=ghost')).status).toBe(404)
  const lens = await (await app.request('/timeline?author=x')).json()
  expect(lens.timeline.map((e: { id: string }) => e.id)).toEqual(['x1'])
})
