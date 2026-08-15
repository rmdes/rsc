import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createApp } from '../src/api/app.ts'
import { removalNotice } from '../src/logical/local.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

async function makeApp(adminEmails: string[] = ['boss@x.test']) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, store)
  const auth = makeAuth(repo)
  const app = createApp({
    service, bus, token: 'secret', auth, users: repo, adminEmails: new Set(adminEmails),
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { app, repo, service, auth, bus }
}

// A remote-authored `posts` row — the legacy shape v2 no longer writes but
// converted databases still hold, and the only thing service.deletePost's
// `source !== 'local'` guard can be exercised against.
function seedRemotePost(repo: Awaited<ReturnType<typeof makeApp>>['repo'], id: string, authorId: string): void {
  repo.raw.prepare(
    `INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at)
     VALUES (?, ?, 'remote', ?, NULL, 'x', ?, '2026-07-18T00:00:00Z', '2026-07-18T00:00:00Z')`,
  ).run(id, authorId, `g-${id}`, `https://e/${id}`)
}

const revisionCount = (repo: Awaited<ReturnType<typeof makeApp>>['repo'], postId: string): number =>
  (repo.raw.prepare('SELECT COUNT(*) AS n FROM post_revisions WHERE post_id = ?').get(postId) as { n: number }).n

const edit = (app: Awaited<ReturnType<typeof makeApp>>['app'], cookie: string, id: string, content: string) =>
  app.request(`/posts/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content }) })

test('deleteLocalAccount removes the core user + posts + better-auth rows', async () => {
  const { app, repo, service } = await makeApp()
  const cookie = await registeredSession(app, 'target@x.test', repo)
  const me = await (await app.request('/me', { headers: { cookie } })).json() // lazy-mints + returns the core user
  const handle = me.user.handle
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'bad post' }) })
  const authRow = repo.raw.prepare('SELECT id FROM user WHERE email = ?').get('target@x.test') as { id: string }

  expect(await service.deleteLocalAccount(handle)).toEqual({ ok: true })
  expect(await repo.getUserByHandle(handle)).toBeUndefined()                                    // core user gone
  expect(repo.instanceStats(false).posts).toBe(0)                                                    // their post cascaded away
  expect(repo.raw.prepare('SELECT id FROM user WHERE id = ?').get(authRow.id)).toBeUndefined()  // better-auth user gone
  expect(repo.raw.prepare('SELECT id FROM session WHERE userId = ?').get(authRow.id)).toBeUndefined()
  expect(repo.raw.prepare('SELECT id FROM account WHERE userId = ?').get(authRow.id)).toBeUndefined()
})

test('deleteLocalAccount: unknown → error unknown; a remote feed → error remote', async () => {
  const { repo, service } = await makeApp()
  expect(await service.deleteLocalAccount('nope')).toEqual({ error: 'unknown' })
  await repo.createRemoteUser({ handle: 'feed1', displayName: 'Feed', feedUrl: 'https://e/f.xml' })
  expect(await service.deleteLocalAccount('feed1')).toEqual({ error: 'remote' })
})

test('DELETE /admin/users/:handle: deletes even an admin-email account (no guard); 409 remote; 404 unknown', async () => {
  const { app, repo } = await makeApp(['boss@x.test', 'other@x.test'])
  // 'other@x.test' is ALSO an admin email — register + mint its local account
  const otherCookie = await registeredSession(app, 'other@x.test', repo)
  const other = await (await app.request('/me', { headers: { cookie: otherCookie } })).json()
  // boss (a different admin) deletes other's admin-email account → 200 (no guard), boss's own session untouched
  const admin = await registeredSession(app, 'boss@x.test', repo)
  expect((await app.request(`/admin/users/${other.user.handle}`, { method: 'DELETE', headers: { cookie: admin } })).status).toBe(200)

  await repo.createRemoteUser({ handle: 'feed2', displayName: 'F', feedUrl: 'https://e/f.xml' })
  expect((await app.request('/admin/users/feed2', { method: 'DELETE', headers: { cookie: admin } })).status).toBe(409)
  expect((await app.request('/admin/users/ghost', { method: 'DELETE', headers: { cookie: admin } })).status).toBe(404)
})

test('DELETE /admin/users/:handle gate: non-admin 403, anon 403, no session 401', async () => {
  const { app, repo } = await makeApp()
  await repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://e/x.xml' })
  expect((await app.request('/admin/users/x', { method: 'DELETE', headers: { cookie: await registeredSession(app, 'peon@x.test', repo) } })).status).toBe(403)
  expect((await app.request('/admin/users/x', { method: 'DELETE', headers: { cookie: await anonSession(app) } })).status).toBe(403)
  expect((await app.request('/admin/users/x', { method: 'DELETE' })).status).toBe(401)
})

test('deletePost (author) replaces content with the removal notice, keeping the row; 409 remote, 404 unknown', async () => {
  const { app, repo, service } = await makeApp()
  const cookie = await registeredSession(app, 'a@x.test', repo)
  await app.request('/me', { headers: { cookie } })
  const created = await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'nuke me' }) })).json()
  const postId = created.post.id

  expect(await service.deletePost(postId, { kind: 'author' })).toEqual({ ok: true })
  const stored = await repo.getPost(postId)
  expect(stored).toBeDefined() // row survives — removal is an edit, not a destruction
  expect(stored!.content).toBe(removalNotice({ kind: 'author' }))
  expect(stored!.title).toBeNull()

  // a remote post → error remote
  const remote = await repo.createRemoteUser({ handle: 'rf', displayName: 'RF', feedUrl: 'https://e/f.xml' })
  seedRemotePost(repo, 'rp', remote.id)
  expect(await service.deletePost('rp', { kind: 'author' })).toEqual({ error: 'remote' })
  expect(await service.deletePost('ghost', { kind: 'author' })).toEqual({ error: 'unknown' })
})

test('deletePost emits one new-post bus event, the same channel an edit uses', async () => {
  const { service, bus } = await makeApp()
  const entry = await service.createLocalPostAs('emituser', 'Emit User', 'hello')
  const seen = vi.fn()
  bus.onNewPost(seen)
  expect(await service.deletePost(entry.id, { kind: 'author' })).toEqual({ ok: true })
  expect(seen).toHaveBeenCalledTimes(1)
})

test('DELETE /admin/posts/:id: 200 local (with category), 409 remote, 404 unknown; gate matrix', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'a@x.test', repo)
  await app.request('/me', { headers: { cookie } })
  const created = await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'p' }) })).json()
  const admin = await registeredSession(app, 'boss@x.test', repo)
  const del = (id: string, sessionCookie: string) =>
    app.request(`/admin/posts/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie: sessionCookie }, body: JSON.stringify({ category: 'spam' }) })
  expect((await del(created.post.id, admin)).status).toBe(200)
  const remote = await repo.createRemoteUser({ handle: 'rf2', displayName: 'RF', feedUrl: 'https://e/f.xml' })
  seedRemotePost(repo, 'rp2', remote.id)
  const admin2 = await registeredSession(app, 'boss@x.test', repo)
  expect((await del('rp2', admin2)).status).toBe(409)
  expect((await del('ghost', admin2)).status).toBe(404)
  expect((await del('rp2', await registeredSession(app, 'peon@x.test', repo))).status).toBe(403)
  expect((await del('rp2', await anonSession(app))).status).toBe(403)
  expect((await app.request('/admin/posts/rp2', { method: 'DELETE' })).status).toBe(401)
})

test('DELETE /admin/posts/:id: missing category → 400, post unchanged', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'a@x.test', repo)
  await app.request('/me', { headers: { cookie } })
  const created = await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'keep me' }) })).json()
  const admin = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request(`/admin/posts/${created.post.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie: admin }, body: JSON.stringify({}) })
  expect(res.status).toBe(400)
  expect((await repo.getPost(created.post.id))?.content).toBe('keep me')
})

// Regression: hard removal must clear post_revisions first — post_revisions.post_id is a
// RESTRICT FK to posts(id) and foreign_keys=ON, so deleting an *edited* post/account
// without clearing its revisions is refused by SQLite (was a 500 / rolled-back delete).
test('deletePost (author) removes an edited post\'s revisions but keeps the row', async () => {
  const { app, repo, service } = await makeApp()
  const cookie = await registeredSession(app, 'ed@x.test', repo)
  await app.request('/me', { headers: { cookie } })
  const created = await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'v1' }) })).json()
  const postId = created.post.id
  expect((await edit(app, cookie, postId, 'v2')).status).toBe(200)
  expect(revisionCount(repo, postId)).toBeGreaterThan(0) // sanity: a revision exists

  expect(await service.deletePost(postId, { kind: 'author' })).toEqual({ ok: true })
  expect(await repo.getPost(postId)).toBeDefined() // row survives
  expect(revisionCount(repo, postId)).toBe(0) // revisions gone too (author removal takes its history with it)
})

test('deleteLocalAccount removes an account whose post was edited (clears post_revisions)', async () => {
  const { app, repo, service } = await makeApp()
  const cookie = await registeredSession(app, 'ed2@x.test', repo)
  const me = await (await app.request('/me', { headers: { cookie } })).json()
  const handle = me.user.handle
  const created = await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'v1' }) })).json()
  expect((await edit(app, cookie, created.post.id, 'v2')).status).toBe(200)
  expect(revisionCount(repo, created.post.id)).toBeGreaterThan(0) // sanity: a revision exists

  expect(await service.deleteLocalAccount(handle)).toEqual({ ok: true })
  expect(await repo.getUserByHandle(handle)).toBeUndefined()
  expect(repo.instanceStats(false).posts).toBe(0)
  expect(revisionCount(repo, created.post.id)).toBe(0) // revisions cascaded away
})

// Final review Finding 1: the apiKey plugin's `apikey` table had no FK on
// referenceId, so deleteAuthRows (called by this same deleteLocalAccount path,
// and shared by admin hard-removal + the idle-guest sweep) never touched it —
// a key outlived account deletion, still verifyApiKey'd, and apiKeyAuth's
// ensureCoreUser lazily minted a fresh empty account for the orphaned
// authUserId on the key's next use, resurrecting the "hard-removed" identity.
// Same erasure cast api-key-plugin.test.ts uses for the same reason.
interface ApiKeyCreation {
  createApiKey(input: {
    body: { configId?: string; userId?: string; permissions?: Record<string, string[]> }
  }): Promise<{ key: string; id: string }>
}

test("deleteLocalAccount removes the account's api key too, so the key can't resurrect the deleted identity", async () => {
  const { app, repo, service, auth } = await makeApp()
  const cookie = await registeredSession(app, 'keyholder@x.test', repo)
  const me = await (await app.request('/me', { headers: { cookie } })).json()
  const handle = me.user.handle
  const authRow = repo.raw.prepare('SELECT id FROM user WHERE email = ?').get('keyholder@x.test') as { id: string }

  const apiKeyApi = auth.api as unknown as ApiKeyCreation
  const created = await apiKeyApi.createApiKey({ body: { configId: 'user', userId: authRow.id, permissions: { timeline: ['read'] } } })
  expect(created.key).toBeTruthy()

  expect(await service.deleteLocalAccount(handle)).toEqual({ ok: true })
  expect(repo.raw.prepare('SELECT id FROM apikey WHERE referenceId = ?').get(authRow.id)).toBeUndefined()

  // The key must be rejected outright — not silently resurrect a fresh
  // account for the now-orphaned authUserId via ensureCoreUser's lazy mint.
  const res = await app.request('/me/timeline', { headers: { 'x-api-key': created.key! } })
  expect(res.status).toBe(401)
  expect(await repo.getUserByHandle(handle)).toBeUndefined() // still gone — nothing resurrected
})
