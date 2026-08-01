import { test, expect } from 'vitest'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'
import { apiKeyAuth } from '../src/api/auth.ts'

// Same erasure api-key-plugin.test.ts hits: createAuth's `plugins:
// BetterAuthPlugin[]` widens every plugin so betterAuth()'s .api inference
// can't see apiKey()'s createApiKey. Only the field this test calls.
interface ApiKeyCreation {
  createApiKey(input: {
    body: { configId?: string; userId?: string; permissions?: Record<string, string[]> }
  }): Promise<{ key: string; id: string }>
}

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const auth = makeAuth(repo)
  const apiKeyApi = auth.api as unknown as ApiKeyCreation
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'reader@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const authUserId = session!.user.id

  const app = new Hono()
  app.get('/protected', apiKeyAuth(auth, repo, { timeline: ['read'] }), (c) => c.json({ userId: c.get('coreUser').id }))

  const key = (await apiKeyApi.createApiKey({ body: { configId: 'user', userId: authUserId, permissions: { timeline: ['read'] } } })).key!
  return { app, key, authUserId, repo }
}

test('a valid key with the required permission reaches the handler and sets coreUser', async () => {
  const { app, key } = await setup()
  const res = await app.request('/protected', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { userId: string }
  expect(body.userId).toBeTruthy()
})

test('a missing key is rejected with 401', async () => {
  const { app } = await setup()
  const res = await app.request('/protected')
  expect(res.status).toBe(401)
})

test('an invalid key string is rejected with 401', async () => {
  const { app } = await setup()
  const res = await app.request('/protected', { headers: { 'x-api-key': 'not-a-real-key' } })
  expect(res.status).toBe(401)
})

test('a valid key WITHOUT the required permission is rejected with 401, not a partial success', async () => {
  const repo = await createSqliteRepository(':memory:')
  const auth = makeAuth(repo)
  const apiKeyApi = auth.api as unknown as ApiKeyCreation
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'writer@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const app = new Hono()
  app.get('/protected', apiKeyAuth(auth, repo, { timeline: ['read'] }), (c) => c.json({ ok: true }))
  const key = (await apiKeyApi.createApiKey({ body: { configId: 'user', userId: session!.user.id, permissions: { posts: ['write'] } } })).key!
  const res = await app.request('/protected', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(401)
})

test("coreUser resolves to the same core user the key's session already had (lazy-mint reuse, not a duplicate)", async () => {
  const { app, key, authUserId, repo } = await setup()
  const res = await app.request('/protected', { headers: { 'x-api-key': key } })
  const body = (await res.json()) as { userId: string }
  // ensureCoreUser must find the SAME core row registeredSession's sign-up
  // already minted for this authUserId, not create a second one. rev 2
  // (ponytail-review): the original draft of this test only asserted
  // body.userId is truthy — identical to (and no stronger than) the first
  // test above, so it proved nothing about "not a duplicate" despite its
  // name. This is the actual comparison that makes the claim real.
  const existing = await repo.getUserByAuthUserId(authUserId)
  expect(body.userId).toBe(existing!.id)
})
