import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createAuth } from '../src/auth.ts'
import { createApp } from '../src/api/app.ts'
import { createService } from '../src/domain/service.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'

// Same erasure every other api-key test hits: createAuth's `plugins:
// BetterAuthPlugin[]` widens every plugin so betterAuth()'s .api inference
// can't see apiKey()'s createApiKey (see api-key-auth-admin.test.ts).
interface ApiKeyPluginApi {
  createApiKey(input: {
    body: { configId?: string; userId?: string; name?: string; permissions?: Record<string, string[]> }
  }): Promise<{ key: string; id: string }>
}

async function setup(adminEmails: ReadonlySet<string> = new Set(['admin@x.test'])) {
  const repo = await createSqliteRepository(':memory:')
  const db = repo.raw
  const auth = createAuth({
    sqlite: repo.raw, users: repo, secret: 'test-secret-test-secret-32chars',
    webOrigin: 'http://localhost:5173', anonTtlDays: 30, mailer: null,
    authOpenApi: false, adminEmails,
  })
  const bus = createEventBus()
  // These 3 tests only exercise POST /admin/api-keys, which never touches
  // the logical store or acquisition engine — a minimal stub (cast past
  // LogicalStore's full interface) avoids standing up createDatabaseContext
  // + createLogicalStore + createAcquisition for a route that never calls
  // them (smoke.test.ts builds the real ones where a test needs them).
  const logicalStoreStub = { schedulerStats: () => ({ dueNow: 0, lastPollAt: null }) } as never
  const service = createService(repo, bus, null, logicalStoreStub)
  const sourceService = createSourceService(repo, null)
  const app = createApp({
    service, bus, token: 'ops-token', auth, users: repo, adminEmails,
    sources: { service: sourceService, repo },
    logical: { store: logicalStoreStub } as never,
  })
  return { app, auth, repo, db }
}

// The two moderation "actually deletes" tests below need a real local post
// and a real deleteLocalAccount call, both of which route through
// service->logical (see service.ts's createLocalPostAs/deleteLocalAccount) —
// setup()'s logicalStoreStub only implements schedulerStats. Mirrors
// moderation.test.ts's own makeApp, which stands up the real store for the
// same reason.
async function setupWithLogicalStore(adminEmails: ReadonlySet<string> = new Set(['admin@x.test'])) {
  const repo = await createSqliteRepository(':memory:')
  const db = repo.raw
  const auth = createAuth({
    sqlite: repo.raw, users: repo, secret: 'test-secret-test-secret-32chars',
    webOrigin: 'http://localhost:5173', anonTtlDays: 30, mailer: null,
    authOpenApi: false, adminEmails,
  })
  const bus = createEventBus()
  const dbContext = createDatabaseContext(repo.raw)
  const store = createLogicalStore(dbContext)
  const service = createService(repo, bus, null, store)
  const sourceService = createSourceService(repo, null)
  const app = createApp({
    service, bus, token: 'ops-token', auth, users: repo, adminEmails,
    sources: { service: sourceService, repo },
    logical: { store, acquisition: createAcquisition({ db: dbContext }) },
  })
  return { app, auth, repo, db }
}

async function registerSession(auth: ReturnType<typeof createAuth>, db: Database.Database, email: string) {
  const signUp = await auth.api.signUpEmail({ body: { email, password: 'password123', name: email } })
  db.prepare(`UPDATE user SET emailVerified = 1 WHERE id = ?`).run(signUp.user.id)
  const signIn = await auth.api.signInEmail({
    body: { email, password: 'password123' }, returnHeaders: true,
  }) as unknown as { headers: Headers }
  return { userId: signUp.user.id, cookie: signIn.headers.get('set-cookie') ?? '' }
}

describe('POST /admin/api-keys', () => {
  test('an admin session can mint an admin-tier key', async () => {
    const { app, auth, db } = await setup()
    const { cookie } = await registerSession(auth, db, 'admin@x.test')
    const res = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'ops-key', permissions: { 'admin.read': ['read'] } }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.key).toBeTruthy()
  })

  test('a non-admin registered session is rejected before reaching the route (403)', async () => {
    const { app, auth, db } = await setup()
    const { cookie } = await registerSession(auth, db, 'nobody@x.test')
    const res = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'k', permissions: { 'admin.read': ['read'] } }),
    })
    expect(res.status).toBe(403)
  })

  test('rejects a permission outside the admin whitelist', async () => {
    const { app, auth, db } = await setup()
    const { cookie } = await registerSession(auth, db, 'admin@x.test')
    const res = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'k', permissions: { 'admin.superpowers': ['write'] } }),
    })
    expect(res.status).toBe(400)
  })

  // Found via Task 6's manual UI check, not written speculatively: a key
  // minted through THIS route (as opposed to every other test in this file,
  // which mints directly via apiKeyApi.createApiKey({body:{userId: the
  // better-auth authUserId from registerSession, ...}})) must actually work
  // when used — i.e. authenticate against an admin.read route, AND be
  // listable/revocable through better-auth's own /api-key/list + /api-key/
  // delete REST endpoints (which key off the session's authUserId). Both
  // depend on the key's referenceId being the SAME id apiKeyAuthAdmin and
  // better-auth's own session-based endpoints use — NOT the RSC-domain
  // `users` table id (a separately generated UUID, see users.insertUser).
  test('a key minted through this route actually works: authenticates an admin.read route AND is listable via /api/auth/api-key/list', async () => {
    const { app, auth, db } = await setup()
    const { cookie } = await registerSession(auth, db, 'admin@x.test')
    const mint = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'ops', permissions: { 'admin.read': ['read'] } }),
    })
    expect(mint.status).toBe(201)
    const { key } = await mint.json()

    // The minted key must authenticate against the API it was minted for.
    const readRes = await app.request('/admin-api/overview', { headers: { 'x-api-key': key } })
    expect(readRes.status).toBe(200)

    // The minted key must be visible to its own owner's session via
    // better-auth's own list endpoint (same referenceId).
    const listRes = await app.request('/api/auth/api-key/list?configId=admin', { headers: { cookie } })
    const { apiKeys } = await listRes.json()
    expect(apiKeys.some((k: { name: string | null }) => k.name === 'ops')).toBe(true)
  })
})

describe('admin.read routes', () => {
  test('GET /admin-api/sources, /users, /overview, /settings all work with one admin.read key', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    for (const path of ['/admin-api/sources', '/admin-api/users', '/admin-api/overview', '/admin-api/settings']) {
      const res = await app.request(path, { headers: { 'x-api-key': created.key } })
      expect(res.status).toBe(200)
    }
  })

  test('a key survives its owner staying admin, but 403s once removed from adminEmails', async () => {
    const repo = await createSqliteRepository(':memory:')
    const db = repo.raw
    const adminEmails = new Set(['revocable@x.test'])
    const auth = createAuth({
      sqlite: repo.raw, users: repo, secret: 'test-secret-test-secret-32chars',
      webOrigin: 'http://localhost:5173', anonTtlDays: 30, mailer: null, authOpenApi: false,
      adminEmails,
    })
    const bus = createEventBus()
    const logicalStoreStub = { schedulerStats: () => ({ dueNow: 0, lastPollAt: null }) } as never
    const service = createService(repo, bus, null, logicalStoreStub)
    const sourceService = createSourceService(repo, null)
    const app = createApp({
      service, bus, token: 'ops-token', auth, users: repo, adminEmails,
      sources: { service: sourceService, repo },
      logical: { store: logicalStoreStub } as never,
    })
    const { userId } = await registerSession(auth, db, 'revocable@x.test')
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    const before = await app.request('/admin-api/sources', { headers: { 'x-api-key': created.key } })
    expect(before.status).toBe(200)
    adminEmails.delete('revocable@x.test')
    const after = await app.request('/admin-api/sources', { headers: { 'x-api-key': created.key } })
    expect(after.status).toBe(403)
  })
})

describe('admin.sources write routes', () => {
  test('POST /admin-api/sources/:id/:action rejects an action outside the six named verbs', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/sources/some-id/approve', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /admin-api/sources/:id/:action 404s an unknown source for a named verb', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/sources/unknown-id/pause', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1' }),
    })
    expect(res.status).toBe(404)
  })

  // Regression: the route's `category` validator must resolve to app.ts's
  // narrower six-value isAuditCategory (same list the cookie-authed sibling
  // POST /admin/sources/:id/:action uses), NOT this file's own wider
  // eight-value isAuditCategory (used by the V3 moderation routes). A same-
  // named-different-symbol shadow previously let 'false_positive'/'remediated'
  // through here while the cookie-authed sibling 400s them.
  test('rejects a V3-moderation-only category (false_positive) that the cookie-authed sibling also rejects', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/sources/some-id/quarantine', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1', category: 'false_positive' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'category invalid' })
  })

  test('a category from the narrower six-value list still passes validation (fix did not over-tighten)', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/sources/unknown-id/quarantine', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1', category: 'spam' }),
    })
    // Category validation passes, so this falls through to the (unknown)
    // source lookup — 404, not the 400 'category invalid' from above.
    expect(res.status).toBe(404)
  })

  test('a posts:write-only key (wrong resource) is rejected', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    const res = await app.request('/admin-api/sources/some-id/pause', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('admin.moderation write routes', () => {
  test('DELETE /admin-api/users/:handle 404s an unknown handle', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.moderation': ['write'] } },
    })
    const res = await app.request('/admin-api/users/nobody', {
      method: 'DELETE', headers: { 'x-api-key': created.key },
    })
    expect(res.status).toBe(404)
  })

  test('DELETE /admin-api/posts/:id 404s an unknown post', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.moderation': ['write'] } },
    })
    const res = await app.request('/admin-api/posts/nope', {
      method: 'DELETE', headers: { 'x-api-key': created.key },
    })
    expect(res.status).toBe(404)
  })

  test('an admin.sources-only key cannot hit moderation routes', async () => {
    const { app, auth, db } = await setup()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/posts/nope', {
      method: 'DELETE', headers: { 'x-api-key': created.key },
    })
    expect(res.status).toBe(401)
  })

  // Mirrors moderation.test.ts's cookie-authed 'deletes even an admin-email
  // account' — proves the key-authed route actually deletes, not just
  // returns 200, by re-checking the row via repo.getUserByHandle afterward.
  test('DELETE /admin-api/users/:handle actually deletes a real local user (200 + row gone)', async () => {
    const { app, auth, db, repo } = await setupWithLogicalStore()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId: adminUserId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId: adminUserId, name: 'k', permissions: { 'admin.moderation': ['write'] } },
    })
    // A separate, non-admin actor whose account gets deleted.
    const { cookie: targetCookie } = await registerSession(auth, db, 'victim@x.test')
    const me = await (await app.request('/me', { headers: { cookie: targetCookie } })).json() // lazy-mints the core user
    const handle = me.user.handle

    const res = await app.request(`/admin-api/users/${handle}`, {
      method: 'DELETE', headers: { 'x-api-key': created.key },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await repo.getUserByHandle(handle)).toBeUndefined()
  })

  // Mirrors moderation.test.ts's cookie-authed 'deletePost removes a local
  // post' persisted-state check (repo.getPost → undefined).
  test('DELETE /admin-api/posts/:id actually deletes a real local post (200 + row gone)', async () => {
    const { app, auth, db, repo } = await setupWithLogicalStore()
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { userId: adminUserId } = await registerSession(auth, db, 'admin@x.test')
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId: adminUserId, name: 'k', permissions: { 'admin.moderation': ['write'] } },
    })
    const { cookie: authorCookie } = await registerSession(auth, db, 'author@x.test')
    await app.request('/me', { headers: { cookie: authorCookie } }) // lazy-mints the core user
    const createdPost = await (await app.request('/posts', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: authorCookie },
      body: JSON.stringify({ content: 'delete me' }),
    })).json()
    const postId = createdPost.post.id

    const res = await app.request(`/admin-api/posts/${postId}`, {
      method: 'DELETE', headers: { 'x-api-key': created.key },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await repo.getPost(postId)).toBeUndefined()
  })
})
