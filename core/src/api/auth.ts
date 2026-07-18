import { timingSafeEqual, randomUUID } from 'node:crypto'
import type { MiddlewareHandler, Next } from 'hono'
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
    return next() // must propagate: sessionOrToken composes this manually, outside Hono's own dispatch
  }
}

export function registeredOnly(): MiddlewareHandler {
  return async (c, next) => {
    if (c.get('sessionIsAnonymous')) return c.json({ error: 'registration required' }, 403)
    return next() // see sessionAuth: propagation matters for sessionOrToken's manual composition
  }
}

export function requireAdmin(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.get('isAdmin')) return c.json({ error: 'admin only' }, 403)
    return next()
  }
}

// POST /users only: ops bearer token OR a registered session.
export function sessionOrToken(token: string, auth: Auth, users: UserDirectory, adminEmails: ReadonlySet<string> = new Set()): MiddlewareHandler {
  const viaSession = sessionAuth(auth, users, adminEmails)
  const mustBeRegistered = registeredOnly()
  return async (c, next) => {
    const header = c.req.header('authorization')
    if (header !== undefined) return bearerAuth(token)(c, next)
    // Hono types `next` as `() => Promise<void>`, but compose.js (see comment
    // on sessionAuth above) actually forwards whatever a middleware returns —
    // mustBeRegistered may resolve to a 403 Response, which viaSession must see.
    return viaSession(c, (() => mustBeRegistered(c, next)) as unknown as Next)
  }
}
