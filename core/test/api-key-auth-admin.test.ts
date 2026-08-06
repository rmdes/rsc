import { describe, test, expect } from 'vitest'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createAuth } from '../src/auth.ts'
import { apiKeyAuthAdmin } from '../src/api/auth.ts'

// Same erasure other api-key tests hit: createAuth's `plugins:
// BetterAuthPlugin[]` widens every plugin so betterAuth()'s .api inference
// can't see apiKey()'s createApiKey. Shape trimmed to only what this test
// calls (same cast auth-admin-key-gate.test.ts uses).
interface ApiKeyPluginApi {
  createApiKey(input: {
    body: { configId?: string; userId?: string; name?: string; permissions?: Record<string, string[]> }
  }): Promise<{ key: string; id: string }>
}

async function setup(adminEmails: ReadonlySet<string>) {
  const repo = await createSqliteRepository(':memory:')
  const auth = createAuth({
    sqlite: repo.raw, users: repo, secret: 'test-secret-test-secret-32chars',
    webOrigin: 'http://localhost:5173', anonTtlDays: 30, mailer: null,
    authOpenApi: false, adminEmails,
  })
  const app = new Hono()
  app.get('/probe', apiKeyAuthAdmin(auth, repo, adminEmails, { 'admin.read': ['read'] }), (c) => c.json({ ok: true }))
  return { app, auth, repo }
}

describe('apiKeyAuthAdmin', () => {
  test('401s with no key', async () => {
    const { app } = await setup(new Set())
    const res = await app.request('/probe')
    expect(res.status).toBe(401)
  })

  test('403s a valid admin-tier key whose owner is no longer in adminEmails', async () => {
    const { app, auth, repo } = await setup(new Set()) // owner never admin at mint time either — simplest reproduction
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const signUp = await auth.api.signUpEmail({ body: { email: 'x@x.test', password: 'password123', name: 'x' } })
    repo.raw.prepare(`UPDATE user SET emailVerified = 1 WHERE id = ?`).run(signUp.user.id)
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId: signUp.user.id, name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    const res = await app.request('/probe', { headers: { 'x-api-key': created.key } })
    expect(res.status).toBe(403)
  })

  test('200s a valid admin-tier key whose owner IS currently in adminEmails', async () => {
    const { app, auth, repo } = await setup(new Set(['boss@x.test']))
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const signUp = await auth.api.signUpEmail({ body: { email: 'boss@x.test', password: 'password123', name: 'x' } })
    repo.raw.prepare(`UPDATE user SET emailVerified = 1 WHERE id = ?`).run(signUp.user.id)
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId: signUp.user.id, name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    const res = await app.request('/probe', { headers: { 'x-api-key': created.key } })
    expect(res.status).toBe(200)
  })

  test('401s a valid admin-tier key with the wrong permission', async () => {
    const { app, auth, repo } = await setup(new Set(['boss@x.test']))
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const signUp = await auth.api.signUpEmail({ body: { email: 'boss@x.test', password: 'password123', name: 'x' } })
    repo.raw.prepare(`UPDATE user SET emailVerified = 1 WHERE id = ?`).run(signUp.user.id)
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'admin', userId: signUp.user.id, name: 'k', permissions: { 'admin.moderation': ['write'] } },
    })
    const res = await app.request('/probe', { headers: { 'x-api-key': created.key } })
    expect(res.status).toBe(401)
  })
})
