import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'
import { Hono } from 'hono'

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

  const insufficientlyScoped = await apiKeyApi.verifyApiKey({ body: { configId: 'user', key: created.key!, permissions: { posts: ['write'] } } })
  expect(insufficientlyScoped.valid).toBe(false)

  const listed = await apiKeyApi.listApiKeys({ query: { configId: 'user' }, headers: new Headers({ cookie }) })
  expect(listed.apiKeys.some((k) => k.id === created.id)).toBe(true)
  expect(listed.apiKeys[0].key).toBeUndefined() // never returns the plaintext key after creation

  await apiKeyApi.deleteApiKey({ body: { configId: 'user', keyId: created.id }, headers: new Headers({ cookie }) })
  const afterDelete = await apiKeyApi.verifyApiKey({ body: { configId: 'user', key: created.key!, permissions: { timeline: ['read'] } } })
  expect(afterDelete.valid).toBe(false)
})
