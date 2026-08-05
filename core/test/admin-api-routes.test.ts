import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createAuth } from '../src/auth.ts'
import { createApp } from '../src/api/app.ts'
import { createService } from '../src/domain/service.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createSourceService } from '../src/domain/source-service.ts'

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
})
