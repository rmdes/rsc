import { test, expect } from 'vitest'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { mountPersonalApiRoutes } from '../src/api/logical-routes.ts'
import { ensureCoreUser } from '../src/api/auth.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'

// Same erasure api-key-plugin.test.ts / api-key-auth-middleware.test.ts hit:
// createAuth's `plugins: BetterAuthPlugin[]` widens every plugin so
// betterAuth()'s .api inference can't see apiKey()'s createApiKey.
interface ApiKeyCreation {
  createApiKey(input: {
    body: { configId?: string; userId?: string; permissions?: Record<string, string[]> }
  }): Promise<{ key: string; id: string }>
}

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const bus = createEventBus()
  const auth = makeAuth(repo)
  const service = createService(repo, bus, null, store)

  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'reader@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const authUserId = session!.user.id
  // Mint the core user the same way apiKeyAuth's first authed hit would
  // (ensureCoreUser is idempotent) — a real key owner already has a core
  // account from prior session activity by the time they mint a key.
  const me = await ensureCoreUser(repo, authUserId)
  const apiKeyApi = auth.api as unknown as ApiKeyCreation
  const key = (await apiKeyApi.createApiKey({ body: { configId: 'user', userId: authUserId, permissions: { timeline: ['read'], posts: ['read'] } } })).key!

  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo })
  return { app, key, service, repo, authUserId, me }
}

test('GET /me/timeline requires an api key', async () => {
  const { app } = await setup()
  const res = await app.request('/me/timeline')
  expect(res.status).toBe(401)
})

test("GET /me/timeline returns posts by people the key's owner follows (the personal/home-timeline lens)", async () => {
  const { app, key, service, me } = await setup()
  const followedPost = await service.createLocalPostAs('alice', 'Alice', 'alice post')
  const alice = await service.getUserByHandle('alice')
  await service.addFollow(me, alice!)
  const res = await app.request('/me/timeline', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(JSON.stringify(body)).toContain(followedPost.id)
})

test("GET /me/posts returns the key owner's own local posts", async () => {
  const { app, key, service, me } = await setup()
  // Post AS the key's own owner (createLocalPostAs mints/reuses by handle).
  const post = await service.createLocalPostAs(me.handle, me.displayName, 'my own post')
  const res = await app.request('/me/posts', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(JSON.stringify(body)).toContain(post.id)
})

test('a key with only timeline:read cannot reach /me/posts (posts:read required)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const auth = makeAuth(repo)
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'timelineonly@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const apiKeyApi = auth.api as unknown as ApiKeyCreation
  const key = (await apiKeyApi.createApiKey({ body: { configId: 'user', userId: session!.user.id, permissions: { timeline: ['read'] } } })).key!
  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo })
  const res = await app.request('/me/posts', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(401)
})
