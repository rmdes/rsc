import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { ingestItems, toParsedItem } from '../src/domain/ingest.ts'
import { makeAuth, anonSession } from './auth-helper.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  return createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo })
}

test('POST /posts requires a session', async () => {
  const app = await makeApp()
  const bare = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hi' }) })
  expect(bare.status).toBe(401)
  const cookie = await anonSession(app)
  const withSession = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'hi' }) })
  expect(withSession.status).toBe(201)
})

test('POST /posts then GET /timeline shows the post', async () => {
  const app = await makeApp()
  const cookie = await anonSession(app)
  const post = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'hi there' }) })
  expect(post.status).toBe(201)
  const tl = await app.request('/timeline')
  const body = await tl.json()
  expect(body.timeline[0].content).toBe('hi there')
  expect(body.timeline[0].title).toBeNull()
})

test('POST /users adds a remote user', async () => {
  const app = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }) })
  expect(res.status).toBe(201)
  expect((await res.json()).user.kind).toBe('remote')
})

test('POST /users requires the bearer token or a session', async () => {
  const app = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }) })
  expect(res.status).toBe(401)
})

test('POST /users rejects a wrong token of the same length as the real one', async () => {
  const app = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrongo' }, body: JSON.stringify({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }) })
  expect(res.status).toBe(401)
})

test('POST /users rejects a non-http(s) feedUrl', async () => {
  const app = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ handle: 'news', displayName: 'News', feedUrl: 'file:///etc/passwd' }) })
  expect(res.status).toBe(400)
})

test('POST /posts with missing content returns 400', async () => {
  const app = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({}) })
  expect(res.status).toBe(400)
})

test('POST /posts with oversized content returns 400', async () => {
  const app = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'x'.repeat(100001) }) })
  expect(res.status).toBe(400)
})

test('POST /posts rejects an over-cap body with 413 (bodyLimit fires before the length guard)', async () => {
  const app = await makeApp()
  const cookie = await anonSession(app)
  // 600 KB body > the 512 KB JSON cap → 413 from bodyLimit, never reaching the
  // in-handler isString length check (which would otherwise 400 on >100 000 chars).
  const res = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'x'.repeat(600 * 1024) }) })
  expect(res.status).toBe(413)
})

test('POST /posts with malformed JSON returns 400, not 500', async () => {
  const app = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{ not json' })
  expect(res.status).toBe(400)
})

test('POST /users with malformed JSON returns 400, not 500', async () => {
  const app = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: '{ not json' })
  expect(res.status).toBe(400)
})

test('POST /users with a handle that is already taken returns 409 (matches PATCH /me)', async () => {
  const app = await makeApp()
  await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }) })
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ handle: 'news', displayName: 'News Again', feedUrl: 'https://ex.com/g.xml' }) })
  expect(res.status).toBe(409)
})

test('timeline pages with before cursor: two pages cover all posts exactly once', async () => {
  const app = await makeApp()
  const cookie = await anonSession(app)
  for (const content of ['one', 'two', 'three']) {
    await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content }) })
  }
  const page1 = await (await app.request('/timeline?limit=2')).json()
  expect(page1.timeline.length).toBe(2)
  expect(typeof page1.nextCursor).toBe('string')
  const page2 = await (await app.request(`/timeline?before=${encodeURIComponent(page1.nextCursor)}&limit=2`)).json()
  expect(page2.nextCursor).toBeNull() // short page = no more
  const ids = [...page1.timeline, ...page2.timeline].map((e: { id: string }) => e.id)
  expect(new Set(ids).size).toBe(3) // disjoint union covers everything (robust to same-ms publishedAt ties)
})

test('timeline rejects a malformed before cursor', async () => {
  const app = await makeApp()
  expect((await app.request('/timeline?before=garbage')).status).toBe(400)
  expect((await app.request('/timeline?before=~missing-ts')).status).toBe(400)
})

test('timeline rejects a non-integer limit and clamps out-of-range limits', async () => {
  const app = await makeApp()
  expect((await app.request('/timeline?limit=abc')).status).toBe(400)
  expect((await app.request('/timeline?limit=0')).status).toBe(200) // clamped to 1
  expect((await app.request('/timeline?limit=5000')).status).toBe(200) // clamped to 100
})

test('POST /hub is 404 when no pushApi is wired', async () => {
  const app = await makeApp()
  expect((await app.request('/hub', { method: 'POST', body: new URLSearchParams({ 'hub.mode': 'subscribe' }) })).status).toBe(404)
})

test('websub callback routes are 404 when pushInApi is not wired', async () => {
  const app = await makeApp()
  expect((await app.request('/websub/callback/some-token?hub.mode=subscribe')).status).toBe(404)
  expect((await app.request('/websub/callback/some-token', { method: 'POST', body: 'x' })).status).toBe(404)
})

test('fat-ping route enforces the 5MB body cap before delivery', async () => {
  const deliver = vi.fn(async () => 202)
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, pushInApi: { websubVerify: async () => ({ status: 404, body: '' }), websubDeliver: deliver } })
  // content-length pre-check path
  const lying = await app.request('/websub/callback/tok', { method: 'POST', headers: { 'content-length': String(10 * 1024 * 1024) }, body: 'small' })
  expect(lying.status).toBe(413)
  // post-read actual-size path (no content-length header large body)
  const big = 'x'.repeat(5 * 1024 * 1024 + 1)
  const res = await app.request('/websub/callback/tok', { method: 'POST', body: big })
  expect(res.status).toBe(413)
  expect(deliver).not.toHaveBeenCalled()
})

test('rsscloud notify routes are 404 when pushInApi is not wired', async () => {
  const app = await makeApp()
  expect((await app.request('/rsscloud/notify?url=x&challenge=y')).status).toBe(404)
  expect((await app.request('/rsscloud/notify', { method: 'POST', body: new URLSearchParams({ url: 'x' }) })).status).toBe(404)
})

test('reply-context is nulled on a resolved reply, kept on an orphan (timeline + revisions)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo })
  const feed = await repo.createRemoteUser({ handle: 'aaron', displayName: 'Aaron', feedUrl: 'https://e/f.xml' })
  await repo.insertPost({ id: 'P', authorId: feed.id, source: 'remote', guid: 'pg', title: null, content: 'parent', url: 'https://a/1', publishedAt: '2026-07-19T00:00:00Z', createdAt: '2026-07-19T00:00:00Z', inReplyTo: null, inReplyToPostId: null, threadRootId: null })
  const items = [
    toParsedItem('rg', null, 'my reply', 'https://a/2', '2026-07-19T00:01:00Z', new Date().toISOString(), 'https://a/1', undefined, null, null, { author: 'aaronpk', snippet: 'nice one' }),
    toParsedItem('rg-orphan', null, 'orphan reply', 'https://a/3', '2026-07-19T00:02:00Z', new Date().toISOString(), 'https://a/unknown', undefined, null, null, { author: 'someone', snippet: 'orphaned' }),
  ]
  await ingestItems(repo, bus, feed, items)
  const { timeline } = await (await app.request('/timeline')).json()
  const resolved = timeline.find((e: any) => e.inReplyToPostId)
  const orphan = timeline.find((e: any) => !e.inReplyToPostId && e.replyContextAuthor)
  expect(resolved.replyContextAuthor).toBeNull()
  expect(orphan.replyContextAuthor).not.toBeNull()
  // P2: the revisions route serializes getPost — also gated
  const rev = await (await app.request(`/posts/${resolved.id}/revisions`)).json()
  expect(rev.post.replyContextAuthor).toBeNull()
})

test('rsscloud notify route enforces the 64KB form body cap', async () => {
  const ping = vi.fn(async () => 200)
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, pushInApi: { websubVerify: async () => ({ status: 404, body: '' }), websubDeliver: async () => 202, rsscloudPing: ping } })
  const big = new URLSearchParams({ url: 'x'.repeat(64 * 1024 + 1) })
  const res = await app.request('/rsscloud/notify', { method: 'POST', body: big })
  expect(res.status).toBe(413)
  expect(ping).not.toHaveBeenCalled()
})
