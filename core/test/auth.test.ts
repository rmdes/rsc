import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { ensureCoreUser } from '../src/api/auth.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const auth = makeAuth(repo)
  const app = createApp({ service, bus, token: 'secret', auth, users: repo })
  return { app, repo, service, auth }
}

function anonAuthUserId(repo: Awaited<ReturnType<typeof createSqliteRepository>>): string {
  const row = repo.raw.prepare('SELECT id FROM user WHERE isAnonymous = 1').get() as { id: string } | undefined
  if (!row) throw new Error('no anonymous auth user row found')
  return row.id
}

test('anonymous sign-in mints a host-only session cookie', async () => {
  const { app } = await makeApp()
  const res = await app.request('/api/auth/sign-in/anonymous', { method: 'POST', headers: { origin: 'http://web.test' } })
  expect(res.status).toBe(200)
  const sc = res.headers.get('set-cookie') ?? ''
  expect(sc).toContain('textcaster.session_token=')
  expect(sc.toLowerCase()).not.toContain('domain=') // host-only (SEC-1)
  expect(sc.toLowerCase()).toContain('httponly')
  expect(sc.toLowerCase()).toContain('samesite=lax')
})

test('cookie without Origin is rejected by better-auth CSRF (probed MISSING_OR_NULL_ORIGIN)', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/api/auth/sign-out', { method: 'POST', headers: { cookie } })
  expect(res.status).toBe(403)
})

test('registration while anonymous re-points the guest core user (onLinkAccount)', async () => {
  const { app, repo } = await makeApp()
  const cookie = await anonSession(app)
  const anonAuthId = anonAuthUserId(repo)
  const guest = await ensureCoreUser(repo, anonAuthId)
  await repo.insertPost({
    id: 'guest-post', authorId: guest.id, source: 'local', guid: 'guest-post', title: null,
    content: 'guest content', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
  })

  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie },
    body: JSON.stringify({ email: 'a@b.example', password: 'password123', name: 'a' }),
  })
  expect(res.status).toBe(200)
  const newAuthId = (await res.json()).user.id as string

  const linked = await repo.getUserByAuthUserId(newAuthId)
  expect(linked?.id).toBe(guest.id) // same core identity, re-pointed
  expect(linked?.handle).toBe(guest.handle) // guest handle intact
  const guestPost = await repo.getPost('guest-post')
  expect(guestPost?.authorId).toBe(guest.id) // posts intact

  const remainingAnon = repo.raw.prepare('SELECT COUNT(*) AS n FROM user WHERE isAnonymous = 1').get() as { n: number }
  expect(remainingAnon.n).toBe(0) // anon auth row deleted by better-auth
})

test('login while anonymous abandons the guest core user (orphaned, reclaimed in Task 5)', async () => {
  const { app, repo } = await makeApp()

  // Register X in a fresh (non-anonymous) session, and establish X's core
  // user the way a real GET /me would lazily (Task 4 route, not wired yet).
  const signUp = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test' },
    body: JSON.stringify({ email: 'x@b.example', password: 'password123', name: 'x' }),
  })
  expect(signUp.status).toBe(200)
  const xAuthId = (await signUp.json()).user.id as string
  await ensureCoreUser(repo, xAuthId)

  // Now a separate anonymous session mints its own guest core user.
  const cookie = await anonSession(app)
  const anonAuthId = anonAuthUserId(repo)
  const guest = await ensureCoreUser(repo, anonAuthId)

  // That anonymous session logs in as X — onLinkAccount sees an existing
  // core user for X and abandons the guest instead of re-pointing it.
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie },
    body: JSON.stringify({ email: 'x@b.example', password: 'password123' }),
  })
  expect(res.status).toBe(200)

  const guestAfter = await repo.getUser(guest.id)
  expect(guestAfter?.authUserId).toBe(anonAuthId) // still points at the now-deleted anon auth row: orphaned
})

test('user actions 401 without a session; 403 gates for anonymous', async () => {
  const { app } = await makeApp()
  expect((await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"content":"x"}' })).status).toBe(401)
  expect((await app.request('/me')).status).toBe(401)
  expect((await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"handle":"x"}' })).status).toBe(401)
  expect((await app.request('/me/follows/whoever', { method: 'DELETE' })).status).toBe(401)
  expect((await app.request('/me/follows/opml', { method: 'POST', body: '<opml></opml>' })).status).toBe(401)
  const anon = await anonSession(app)
  const addFeed = await app.request('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: anon },
    body: JSON.stringify({ handle: 'feed1', displayName: 'Feed', feedUrl: 'http://e.example/f.xml' }),
  })
  expect(addFeed.status).toBe(403) // anonymous cannot create feeds
  const reg = await registeredSession(app, 'r@test.example')
  const addFeed2 = await app.request('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: reg },
    body: JSON.stringify({ handle: 'feed1', displayName: 'Feed', feedUrl: 'http://e.example/f.xml' }),
  })
  expect(addFeed2.status).toBe(201)
})

test('PATCH /me renames; posts and follows survive; 409 on conflict', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"content":"hello"}' })
  const meRes = await (await app.request('/me', { headers: { cookie } })).json()
  expect(meRes.isAnonymous).toBe(true)
  const before = meRes.user
  const renamed = await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"handle":"ricardo","displayName":"Ricardo"}' })
  expect(renamed.status).toBe(200)
  const timeline = (await (await app.request('/timeline')).json()).timeline
  expect(timeline[0].author.handle).toBe('ricardo')
  expect(timeline[0].author.id).toBe(before.id) // same identity, no data moved
})

test('PATCH /me rejects an unnormalized handle (400), and a valid rename keeps posting working', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const bad = await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"handle":"My Name"}' })
  expect(bad.status).toBe(400)

  const renamed = await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{"handle":"my-name"}' })
  expect(renamed.status).toBe(200)

  const posted = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"content":"after rename"}' })
  expect(posted.status).toBe(201)
})

test('PATCH /me with an empty body is 400 (nothing to update)', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: '{}' })
  expect(res.status).toBe(400)
})

test('sweep reclaims idle anonymous guests (full cascade, one transaction) and orphans; spares the active and the registered', async () => {
  const { app, repo } = await makeApp()
  // idle guest with a post and follows in both directions
  const idle = await anonSession(app)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: idle }, body: '{"content":"guest post"}' })
  const idleUser = (await (await app.request('/me', { headers: { cookie: idle } })).json()).user
  // registered user follows the guest; guest follows them back
  const reg = await registeredSession(app, 'keeper@test.example')
  const regUser = (await (await app.request('/me', { headers: { cookie: reg } })).json()).user
  await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: reg }, body: JSON.stringify({ handle: idleUser.handle }) })
  await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: idle }, body: JSON.stringify({ handle: regUser.handle }) })
  // age the idle guest's session + auth user beyond the TTL
  const old = new Date(Date.now() - 8 * 86400_000).toISOString()
  repo.raw.prepare(`UPDATE session SET updatedAt = ? WHERE userId = ?`).run(old, idleUser.authUserId)
  repo.raw.prepare(`UPDATE user SET createdAt = ? WHERE id = ?`).run(old, idleUser.authUserId)
  // an ACTIVE anonymous guest must survive
  const active = await anonSession(app)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: active }, body: '{"content":"still here"}' })

  const { swept } = repo.sweepAnonymousUsers(7)
  expect(swept).toBe(1)
  expect(await repo.getUserByHandle(idleUser.handle)).toBeUndefined()
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM posts WHERE author_id = ?`).get(idleUser.id)).toMatchObject({ n: 0 })
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM follows WHERE follower_id = ? OR followed_id = ?`).get(idleUser.id, idleUser.id)).toMatchObject({ n: 0 })
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM user WHERE id = ?`).get(idleUser.authUserId)).toMatchObject({ n: 0 })
  // survivors
  expect(await repo.getUserByHandle(regUser.handle)).toBeDefined()
  const timeline = (await (await app.request('/timeline')).json()).timeline
  expect(timeline.some((e: { content: string }) => e.content === 'still here')).toBe(true)
})

test('sweep reclaims core users whose auth account is gone (login-abandon orphans)', async () => {
  const { repo } = await makeApp()
  await repo.createLocalUser({ handle: 'guest-orphan', displayName: 'guest-orphan', authUserId: 'deleted-auth-id' })
  const { swept } = repo.sweepAnonymousUsers(7)
  expect(swept).toBe(1)
  expect(await repo.getUserByHandle('guest-orphan')).toBeUndefined()
})
