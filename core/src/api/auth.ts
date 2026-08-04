import { timingSafeEqual, randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { Auth } from '../auth.ts'
import type { User } from '../domain/types.ts'
import { HandleTakenError } from '../domain/types.ts'

declare module 'hono' {
  interface ContextVariableMap {
    coreUser: User
    sessionIsAnonymous: boolean
    isAdmin: boolean
  }
}

export function bearerAuth(token: string): MiddlewareHandler {
  const expected = Buffer.from(`Bearer ${token}`)
  return async (c, next) => {
    const header = Buffer.from(c.req.header('authorization') ?? '')
    if (header.length !== expected.length || !timingSafeEqual(header, expected)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  }
}

export interface UserDirectory {
  getUserByAuthUserId(authUserId: string): Promise<User | undefined>
  createLocalUser(u: { handle: string; displayName: string; authUserId?: string }): Promise<User>
}

// Lazy mint (spec P-1 + direct-registration coverage): the core identity is
// created at first session resolution, whoever the auth user is. One
// mechanism covers anonymous first-write, direct registration, and recovery
// after a failed onLinkAccount re-point.
export async function ensureCoreUser(users: UserDirectory, authUserId: string): Promise<User> {
  const existing = await users.getUserByAuthUserId(authUserId)
  if (existing) return existing
  for (let i = 0; i < 50; i++) {
    const handle = `guest-${randomUUID().replace(/-/g, '').slice(0, 6)}`
    try {
      return await users.createLocalUser({ handle, displayName: handle, authUserId })
    } catch (err) {
      if (!(err instanceof HandleTakenError)) throw err
      // UNIQUE(auth_user_id) also maps to HandleTakenError: a concurrent
      // request may have minted for this same session — take theirs.
      const raced = await users.getUserByAuthUserId(authUserId)
      if (raced) return raced
    }
  }
  throw new Error('could not allocate a guest handle')
}

// Email-derived admin. Verified-only is load-bearing: the allowlist is only safe
// because hard email verification proves control of the inbox (spec rev 1).
export function deriveIsAdmin(
  user: { email?: string | null; emailVerified?: boolean | null },
  adminEmails: ReadonlySet<string>,
): boolean {
  return user.emailVerified === true && typeof user.email === 'string' && adminEmails.has(user.email.toLowerCase())
}

export function sessionAuth(auth: Auth, users: UserDirectory, adminEmails: ReadonlySet<string> = new Set()): MiddlewareHandler {
  return async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'authentication required' }, 401)
    c.set('coreUser', await ensureCoreUser(users, session.user.id))
    c.set('sessionIsAnonymous', (session.user as { isAnonymous?: boolean | null }).isAnonymous === true)
    c.set('isAdmin', deriveIsAdmin(session.user as { email?: string | null; emailVerified?: boolean | null }, adminEmails))
    return next() // propagate whatever the downstream middleware/handler returns, per Hono's compose contract
  }
}

// createAuth's `plugins: BetterAuthPlugin[]` (auth.ts) widens every plugin to
// the base interface, so betterAuth()'s generic .api inference can't see
// apiKey()'s endpoints — same erasure test/api-key-plugin.test.ts hits and
// works around with an identical cast. Field shape transcribed from the
// installed package's real .d.mts
// (node_modules/@better-auth/api-key/dist/index-CgPDayNk.d.mts), not
// invented, trimmed to only what apiKeyAuth reads.
interface ApiKeyVerification {
  verifyApiKey(input: {
    body: { configId?: string; key: string; permissions?: Record<string, string[]> }
  }): Promise<{ valid: boolean; key: { referenceId: string } | null }>
}

// Explicit verifyApiKey call, never better-auth's enableSessionForAPIKeys
// shortcut (better-auth's own docs flag it as an impersonation risk, and it
// has no per-route permission check). configId is required on every call to
// this plugin — our one config is named 'user', not the implicit 'default'
// the plugin falls back to when configId is omitted (Task 1 finding).
export function apiKeyAuth(auth: Auth, users: UserDirectory, permissions: Record<string, string[]>): MiddlewareHandler {
  const apiKeyApi = auth.api as unknown as ApiKeyVerification
  return async (c, next) => {
    const key = c.req.header('x-api-key')
    if (!key) return c.json({ error: 'api key required' }, 401)
    const result = await apiKeyApi.verifyApiKey({ body: { configId: 'user', key, permissions } })
    if (!result.valid || !result.key) return c.json({ error: 'invalid or insufficient api key' }, 401)
    c.set('coreUser', await ensureCoreUser(users, result.key.referenceId))
    return next() // see sessionAuth: same propagation contract applies here
  }
}

// Final review Finding 5: fails CLOSED. `apiKeyAuth` never sets
// sessionIsAnonymous (only sessionAuth does), so composing registeredOnly()
// after apiKeyAuth left it undefined — the old `if (c.get(...))` check
// treated that as falsy and silently PASSED. Requiring `!== false` (not just
// truthy `=== true`) means an unset value is rejected, not waved through,
// with no type error to catch the old version. sessionAuth always sets this
// explicitly (true or false), so this changes nothing for any existing
// sessionAuth + registeredOnly() route.
//
// Turns out apiKeyAuth + registeredOnly() is NOT a composition phase 3 ends
// up using: only registered users can hold an api key at all (POST
// /me/api-keys and better-auth's own key-create both reject anonymous
// sessions — see reject-anon-api-key-create below), so every apiKeyAuth
// route is already registered-only by construction. Do not add
// registeredOnly() after apiKeyAuth expecting it to do anything — it would
// unconditionally 403 every request, since sessionIsAnonymous stays unset.
export function registeredOnly(): MiddlewareHandler {
  return async (c, next) => {
    if (c.get('sessionIsAnonymous') !== false) return c.json({ error: 'registration required' }, 403)
    return next() // see sessionAuth: same propagation contract applies here
  }
}

export function requireAdmin(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.get('isAdmin')) return c.json({ error: 'admin only' }, 403)
    return next()
  }
}

