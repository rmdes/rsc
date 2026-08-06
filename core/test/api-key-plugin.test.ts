import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { makeAuth, registeredSession, anonSession } from './auth-helper.ts'
import { Hono } from 'hono'
import { MAX_API_KEYS_PER_USER } from '../src/api/logical-routes.ts'

// createAuth's `plugins: BetterAuthPlugin[]` (auth.ts) widens every plugin to
// the base interface, so betterAuth()'s generic .api inference can't see
// apiKey()'s endpoints — the same erasure test/auth-openapi.test.ts already
// works around with a cast. Field shapes below are transcribed from the
// installed package's real .d.mts
// (node_modules/@better-auth/api-key/dist/index-CgPDayNk.d.mts), not
// invented — trimmed to only the fields this test reads.
interface ApiKeyPluginApi {
  createApiKey(input: {
    body: { configId?: string; userId?: string; name?: string; permissions?: Record<string, string[]> }
  }): Promise<{ key: string; id: string }>
  verifyApiKey(input: {
    body: { configId?: string; key: string; permissions?: Record<string, string[]> }
  }): Promise<{ valid: boolean; key: { referenceId: string } | null }>
  listApiKeys(input: { query: { configId?: string }; headers: Headers }): Promise<{
    apiKeys: Array<{ id: string; key?: string }>
  }>
  deleteApiKey(input: { body: { configId?: string; keyId: string }; headers: Headers }): Promise<{ success: boolean }>
}

test('a user-owned api key can be created, verified, listed, and deleted via the plugin API directly', async () => {
  const repo = await createSqliteRepository(':memory:')
  const auth = makeAuth(repo)
  const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
  const app = new Hono()
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(app, 'reader@x.test', repo)

  // Resolve the core user id the session belongs to, the same way sessionAuth does.
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const authUserId = session!.user.id

  // No `headers`/`request` on this call — a server-only invocation, which is
  // what allows passing `userId`/`permissions` directly (the plugin rejects
  // both on a real client HTTP request; confirmed by reading
  // node_modules/@better-auth/api-key/dist/index.mjs's createApiKey handler).
  const created = await apiKeyApi.createApiKey({
    body: { configId: 'user', userId: authUserId, name: 'test key', permissions: { timeline: ['read'] } },
  })
  expect(created.key).toBeTruthy() // the plaintext key, returned exactly once

  // configId is required on every call here, not optional: our one config is
  // named 'user', not the implicit 'default' the plugin falls back to when
  // configId is omitted (resolveConfiguration in
  // node_modules/@better-auth/api-key/dist/index.mjs throws
  // NO_DEFAULT_API_KEY_CONFIGURATION_FOUND otherwise) — confirmed by running
  // this test without configId first and observing that exact failure.
  const verified = await apiKeyApi.verifyApiKey({ body: { configId: 'user', key: created.key!, permissions: { timeline: ['read'] } } })
  expect(verified.valid).toBe(true)
  expect(verified.key?.referenceId).toBe(authUserId)

  const insufficientlyScoped = await apiKeyApi.verifyApiKey({ body: { configId: 'user', key: created.key!, permissions: { posts: ['read'] } } })
  expect(insufficientlyScoped.valid).toBe(false)

  const listed = await apiKeyApi.listApiKeys({ query: { configId: 'user' }, headers: new Headers({ cookie }) })
  expect(listed.apiKeys.some((k) => k.id === created.id)).toBe(true)
  expect(listed.apiKeys[0].key).toBeUndefined() // never returns the plaintext key after creation

  await apiKeyApi.deleteApiKey({ body: { configId: 'user', keyId: created.id }, headers: new Headers({ cookie }) })
  const afterDelete = await apiKeyApi.verifyApiKey({ body: { configId: 'user', key: created.key!, permissions: { timeline: ['read'] } } })
  expect(afterDelete.valid).toBe(false)
})

// Final review Finding 3: this app's own POST /me/api-keys already scoped
// self-serve key creation to registered users, but better-auth's own REST
// /api-key/create endpoint (still mounted, unmodified, under /api/auth/*)
// had no equivalent guard — an anonymous guest session could mint a real key
// directly via that endpoint. auth.ts's `reject-anon-api-key-create` plugin
// closes that other half via a real HTTP call (through the Hono mount, not
// the in-process `auth.api.createApiKey` cast above) so `ctx.headers` is
// actually populated and the hook's own isClientRequest-style check fires.
test('a REST call to /api-key/create is rejected for an anonymous session and still works for a registered one', async () => {
  const repo = await createSqliteRepository(':memory:')
  const auth = makeAuth(repo)
  const app = new Hono()
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

  const anonCookie = await anonSession(app)
  const anonRes = await app.request('/api/auth/api-key/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie: anonCookie },
    body: JSON.stringify({ configId: 'user', name: 'guest key' }),
  })
  expect(anonRes.status).toBe(403)

  const cookie = await registeredSession(app, 'legit@x.test', repo)
  const res = await app.request('/api/auth/api-key/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie },
    body: JSON.stringify({ configId: 'user', name: 'real key' }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { key?: string }
  expect(body.key).toBeTruthy()
})

// Whole-branch final-review Finding 1: logical-routes.ts's two in-process cap
// checks (POST /me/api-keys, POST /admin/api-keys) only cover this app's own
// issuance routes — better-auth's plugin-mounted REST /api-key/create
// endpoint had no cap at all, so a caller could keep minting keys through it
// forever (verified live: 25 consecutive REST creates all succeeded against a
// cap of 20). auth.ts's reject-anon-api-key-create hook now also enforces
// MAX_API_KEYS_PER_USER for real HTTP calls to this endpoint, reusing the
// same table read POST /me/api-keys does via countApiKeys.
test('a REST call to /api-key/create is rejected once the caller is already at the per-user cap', async () => {
  const repo = await createSqliteRepository(':memory:')
  const auth = makeAuth(repo)
  const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
  const app = new Hono()
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(app, 'capped-rest@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const authUserId = session!.user.id

  // Mint MAX keys in-process (no headers/request — the same server-only path
  // the first test in this file uses) so this test isn't paying for
  // MAX_API_KEYS_PER_USER real HTTP round-trips just to reach the cap.
  for (let i = 0; i < MAX_API_KEYS_PER_USER; i++) {
    await apiKeyApi.createApiKey({ body: { configId: 'user', userId: authUserId, name: `k${i}` } })
  }

  const overCap = await app.request('/api/auth/api-key/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie },
    body: JSON.stringify({ configId: 'user', name: 'over cap' }),
  })
  expect(overCap.status).toBe(403)
  expect(await repo.countApiKeys(authUserId, 'user')).toBe(MAX_API_KEYS_PER_USER)
})
