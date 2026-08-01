import { betterAuth } from 'better-auth'
import type { BetterAuthPlugin } from 'better-auth'
import { anonymous, magicLink, multiSession, openAPI } from 'better-auth/plugins'
import { apiKey } from '@better-auth/api-key'
import type Database from 'better-sqlite3'
import type { User } from './domain/types.ts'
import type { Mailer } from './mail.ts'

export interface AuthDeps {
  sqlite: Database.Database // THE shared handle from repo.raw — never a second connection
  users: {
    getUserByAuthUserId(authUserId: string): Promise<User | undefined>
    setAuthUserId(userId: string, authUserId: string): Promise<void>
  }
  secret: string
  webOrigin: string
  anonTtlDays: number
  mailer: Mailer | null
  authOpenApi: boolean
}

export function createAuth(deps: AuthDeps) {
  const plugins: BetterAuthPlugin[] = [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        if (!deps.mailer) throw new Error('email is not configured on this instance')
        await deps.mailer.send(email, 'Your RSC login link', `Log in: ${url}`)
      },
    }),
    anonymous({
      // Fires on ANY sign-in/sign-up while an anonymous session exists
      // (probed) — registration upgrade AND plain login both land here.
      async onLinkAccount({ anonymousUser, newUser }) {
        const guest = await deps.users.getUserByAuthUserId(anonymousUser.user.id)
        if (!guest) return // guest never acted — nothing to carry over
        const existing = await deps.users.getUserByAuthUserId(newUser.user.id)
        if (existing) return // login into an established account: abandon the guest, the sweep reclaims it
        // Fresh registration: re-point the guest's core row. A throw here
        // aborts better-auth's anon-user deletion (probed ordering) — the
        // guest identity survives a failed re-point.
        await deps.users.setAuthUserId(guest.id, newUser.user.id)
      },
    }),
    multiSession({ maximumSessions: 4 }),
    // Phase 2 of the external-API design (2026-07-30): one named config for
    // personal read-only keys. Only the permissions phase 2's routes check
    // are registered here — write/follows/profile land with phase 3, not
    // pre-declared now.
    apiKey({
      configId: 'user',
      references: 'user',
      defaultPrefix: 'rsc_',
      // A conservative shared default a personal read-only script won't hit
      // under normal use; per-key override stays available via the plugin's
      // own createApiKey options if a future caller needs more.
      rateLimit: { enabled: true, timeWindow: 1000 * 60 * 60, maxRequests: 300 },
      permissions: {
        defaultPermissions: {},
      },
    }),
  ]
  // Dev-only OpenAPI reference (spec 2026-07-19). Routes ride the /api/auth/*
  // mount; the web proxy independently 404s them so this never goes public.
  if (deps.authOpenApi) plugins.push(openAPI())

  return betterAuth({
    database: deps.sqlite,
    secret: deps.secret,
    // baseURL is the user-facing origin (the web app). Requests reach this
    // handler proxied by the web server; routing matches on the default
    // basePath /api/auth regardless of host. Anonymous temp-email domains
    // derive from this URL. Redirect flows are unused (JSON responses only).
    baseURL: deps.webOrigin,
    trustedOrigins: [deps.webOrigin],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true, // hard verification (spec decision)
      sendResetPassword: async ({ user, url }) => {
        if (!deps.mailer) throw new Error('email is not configured on this instance')
        await deps.mailer.send(user.email, 'Reset your RSC password', `Reset your password: ${url}`)
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        if (!deps.mailer) throw new Error('email is not configured on this instance')
        await deps.mailer.send(user.email, 'Verify your RSC email', `Verify your email: ${url}`)
      },
    },
    // 4x the sweep TTL: the browser cookie must outlive the idle window even
    // though getSession's rolling refresh isn't relayed yet — relaying it via
    // /me is the real fix (recorded follow-up)
    session: { expiresIn: deps.anonTtlDays * 4 * 86400 },
    // ponytail: per-IP throttle only; CAPTCHA/turnstile if a real flood ever happens
    rateLimit: { enabled: true, customRules: { '/sign-in/anonymous': { window: 60, max: 10 }, '/sign-in/magic-link': { window: 60, max: 5 } } },
    // disableOriginCheck defaults to true under NODE_ENV=test (better-auth's
    // isTest() shortcut) — pin it off so CSRF/origin checks are real in our
    // own (vitest) test suite too, not just in production.
    // Core is never browser-facing: /api/auth traffic arrives from the web
    // layer, which sets x-forwarded-for from SvelteKit's getClientAddress()
    // (itself resolved from the edge proxy, not client-spoofable). Trust that
    // header so the per-IP rate limits use the real client, not one shared
    // global bucket (probed: session.ipAddress then reflects the header).
    advanced: { cookiePrefix: 'rsc', disableOriginCheck: false, ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } },
    plugins,
  })
}

export type Auth = ReturnType<typeof createAuth>
