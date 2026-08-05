import { test, expect } from 'vitest'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { mountPersonalApiRoutes } from '../src/api/logical-routes.ts'
import { ensureCoreUser } from '../src/api/auth.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'

// Same erasure this file's siblings hit (personal-api-routes.test.ts,
// api-key-plugin.test.ts) — createAuth's `plugins: BetterAuthPlugin[]`
// widens every plugin so betterAuth()'s .api inference can't see
// apiKey()'s createApiKey. rateLimitMax/rateLimitTimeWindow are real,
// server-only per-key overrides (createApiKeyBodySchema,
// @better-auth/api-key/dist/index.mjs:590-592) — not invented for this test.
interface ApiKeyCreation {
  createApiKey(input: {
    body: {
      configId?: string
      userId?: string
      permissions?: Record<string, string[]>
      rateLimitMax?: number
      rateLimitTimeWindow?: number
    }
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
  const cookie = await registeredSession(authApp, 'ratelimited@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const authUserId = session!.user.id
  await ensureCoreUser(repo, authUserId)

  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo, service, sourceService: createSourceService(repo, null) })
  return { app, auth, authUserId }
}

test('rate-limit exhaustion surfaces as 429 with tryAgainIn and code, not a bare 401', async () => {
  const { app, auth, authUserId } = await setup()
  const apiKeyApi = auth.api as unknown as ApiKeyCreation
  // 2 requests per 60s window — GET /me/timeline (timeline:read) is a real,
  // already-mounted probe route; no bespoke test route needed.
  const key = (await apiKeyApi.createApiKey({
    body: { configId: 'user', userId: authUserId, permissions: { timeline: ['read'] }, rateLimitMax: 2, rateLimitTimeWindow: 60_000 },
  })).key!

  const first = await app.request('/me/timeline', { headers: { 'x-api-key': key } })
  expect(first.status).toBe(200)
  const second = await app.request('/me/timeline', { headers: { 'x-api-key': key } })
  expect(second.status).toBe(200)
  const third = await app.request('/me/timeline', { headers: { 'x-api-key': key } })
  expect(third.status).toBe(429)
  const body = (await third.json()) as { error: string; code: string; tryAgainIn: number }
  expect(body.code).toBe('RATE_LIMITED')
  expect(body.tryAgainIn).toBeGreaterThan(0)
})

test('a genuinely invalid key still returns a plain 401, not 429 (regression guard)', async () => {
  const { app } = await setup()
  const res = await app.request('/me/timeline', { headers: { 'x-api-key': 'not-a-real-key' } })
  expect(res.status).toBe(401)
  const body = (await res.json()) as { code?: string }
  expect(body.code).not.toBe('RATE_LIMITED')
})
