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
