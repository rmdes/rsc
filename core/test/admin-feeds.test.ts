import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

async function makeApp(adminEmails: string[] = ['boss@x.test']) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, adminEmails: new Set(adminEmails) })
  return { app, repo }
}
const body = (handle: string) => JSON.stringify({ handle, displayName: handle, feedUrl: 'https://ex.com/f.xml' })

test('POST /users: bearer token allowed', async () => {
  const { app } = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: body('news') })
  expect(res.status).toBe(201)
})
test('POST /users: admin session allowed', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: body('news2') })
  expect(res.status).toBe(201)
})
test('POST /users: non-admin registered session → 403', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'peon@x.test', repo)
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: body('news3') })
  expect(res.status).toBe(403)
})
test('POST /users: anonymous session → 403 (a session, just not admin — matches SP1 /admin/status)', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: body('news4') })
  expect(res.status).toBe(403)
})
test('POST /users: no session at all → 401', async () => {
  const { app } = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body('news5') })
  expect(res.status).toBe(401)
})
test('DELETE /users/:handle removes a remote feed and cascades', async () => {
  const { app } = await makeApp()
  await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: body('gone') })
  const del = await app.request('/users/gone', { method: 'DELETE', headers: { authorization: 'Bearer secret' } })
  expect(del.status).toBe(200)
  // A remote user's /users/:handle/feed.xml 302-redirects to its external feed
  // while it exists; once removed it 404s — proving the row is gone.
  const gone = await app.request('/users/gone/feed.xml', { redirect: 'manual' })
  expect(gone.status).toBe(404)
})
test('DELETE /users/:handle: 404 unknown handle', async () => {
  const { app } = await makeApp()
  const res = await app.request('/users/nope', { method: 'DELETE', headers: { authorization: 'Bearer secret' } })
  expect(res.status).toBe(404)
})
test('DELETE /users/:handle: 409 on a local user', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'hi' }) })
  const me = await (await app.request('/me', { headers: { cookie } })).json()
  const res = await app.request(`/users/${me.user.handle}`, { method: 'DELETE', headers: { authorization: 'Bearer secret' } })
  expect(res.status).toBe(409)
})
test('DELETE cascades but a local reply to a removed post survives (orphaned)', async () => {
  const { app, repo } = await makeApp()
  const remote = await repo.createRemoteUser({ handle: 'gone2', displayName: 'Gone2', feedUrl: 'https://ex.com/g.xml' })
  await repo.insertPost({ id: 'rp', authorId: remote.id, source: 'remote', guid: 'rg', title: null, content: 'remote post', url: 'https://ex.com/post/rp', publishedAt: '2026-07-18T00:00:00Z', createdAt: '2026-07-18T00:00:00Z', inReplyTo: null, inReplyToPostId: null, threadRootId: null })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const reply = await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'my reply', inReplyTo: 'rp' }) })).json()
  await app.request('/users/gone2', { method: 'DELETE', headers: { authorization: 'Bearer secret' } })
  const tl = await (await app.request('/timeline?limit=50')).json()
  expect(tl.timeline.some((p: { id: string }) => p.id === reply.post.id)).toBe(true) // reply survives
  expect(tl.timeline.some((p: { id: string }) => p.id === 'rp')).toBe(false)         // remote post gone
})
test('GET /admin/feeds: admin lists feeds; non-admin & anon session 403; no session 401', async () => {
  const { app, repo } = await makeApp()
  await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: body('shown') })
  const adminCookie = await registeredSession(app, 'boss@x.test', repo)
  const ok = await app.request('/admin/feeds', { headers: { cookie: adminCookie } })
  expect(ok.status).toBe(200)
  expect((await ok.json()).feeds.some((f: { handle: string }) => f.handle === 'shown')).toBe(true)
  const peon = await registeredSession(app, 'peon@x.test', repo)
  expect((await app.request('/admin/feeds', { headers: { cookie: peon } })).status).toBe(403)
  expect((await app.request('/admin/feeds', { headers: { cookie: await anonSession(app) } })).status).toBe(403) // anon session = not admin
  expect((await app.request('/admin/feeds')).status).toBe(401) // no session
})
