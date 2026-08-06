import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createSqliteRepository, type SqliteRepository } from '../src/storage/sqlite.ts'
import { createAuth } from '../src/auth.ts'

// createAuth's `plugins: BetterAuthPlugin[]` (auth.ts) widens every plugin to
// the base interface, so betterAuth()'s generic .api inference can't see
// apiKey()'s endpoints — same erasure test/api-key-plugin.test.ts already
// works around with a cast. Shape transcribed from the installed package's
// real .d.mts, trimmed to only what this test calls.
interface ApiKeyPluginApi {
  createApiKey(input: {
    headers?: Headers
    body: { configId?: string; userId?: string; name?: string; permissions?: Record<string, string[]> }
  }): Promise<{ id: string; permissions?: Record<string, string[]> | null }>
}

describe('admin-tier api-key gate (before hook)', () => {
  let repo: SqliteRepository

  beforeEach(async () => {
    repo = await createSqliteRepository(':memory:')
  })
  afterEach(() => repo.raw.close())

  function makeAuth(adminEmails: ReadonlySet<string>) {
    return createAuth({
      sqlite: repo.raw, users: repo, secret: 'test-secret-test-secret-32chars',
      webOrigin: 'http://localhost:5173', anonTtlDays: 30, mailer: null,
      authOpenApi: false, adminEmails,
    })
  }

  async function signUpAndSignIn(auth: ReturnType<typeof createAuth>, email: string) {
    const signUp = await auth.api.signUpEmail({ body: { email, password: 'password123', name: email } })
    repo.raw.prepare(`UPDATE user SET emailVerified = 1 WHERE id = ?`).run(signUp.user.id)
    const signIn = await auth.api.signInEmail({
      body: { email, password: 'password123' }, returnHeaders: true,
    }) as unknown as { headers: Headers }
    return { userId: signUp.user.id, cookie: signIn.headers.get('set-cookie') ?? '' }
  }

  // No `permissions` field in any of these three bodies — a real-HTTP request
  // carrying one is unconditionally rejected by the plugin itself
  // (SERVER_ONLY_PROPERTY, @better-auth/api-key/dist/index.mjs:730-738 /
  // :1481-1489) regardless of admin status, so it would prove nothing here.

  test('a non-admin session cannot create a configId:admin key over real HTTP', async () => {
    const auth = makeAuth(new Set())
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { cookie } = await signUpAndSignIn(auth, 'nonadmin@x.test')
    await expect(
      apiKeyApi.createApiKey({ headers: new Headers({ cookie }), body: { configId: 'admin', name: 'k' } }),
    ).rejects.toThrow(/admin only/)
  })

  test('an admin session (verified email in adminEmails) CAN create a configId:admin key', async () => {
    const auth = makeAuth(new Set(['boss@x.test']))
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const { cookie } = await signUpAndSignIn(auth, 'boss@x.test')
    const created = await apiKeyApi.createApiKey({
      headers: new Headers({ cookie }), body: { configId: 'admin', name: 'k' },
    })
    expect(created.id).toBeTruthy()
    // defaultPermissions: {} — the empty-permissions key itself is inert;
    // Task 2 is the real issuance path. `{}` is truthy in JS, so this checks
    // shape, not `toBeFalsy()` (which no object literal can ever satisfy).
    expect(created.permissions).toEqual({})
  })

  test('an in-process call still works for configId:user — the hook is a no-op for server-side calls (unchanged phase 2/3 behavior)', async () => {
    const auth = makeAuth(new Set())
    const apiKeyApi = auth.api as unknown as ApiKeyPluginApi
    const signUp = await auth.api.signUpEmail({ body: { email: 'inproc@x.test', password: 'password123', name: 'x' } })
    const created = await apiKeyApi.createApiKey({
      body: { configId: 'user', userId: signUp.user.id, name: 'k', permissions: { timeline: ['read'] } },
    })
    expect(created.id).toBeTruthy()
  })
})
