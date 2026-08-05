import { betterAuth } from 'better-auth'
import type { BetterAuthPlugin } from 'better-auth'
import { anonymous, magicLink, multiSession, openAPI } from 'better-auth/plugins'
import { apiKey } from '@better-auth/api-key'
import { createAuthMiddleware, getSessionFromCtx, APIError } from 'better-auth/api'
import type Database from 'better-sqlite3'
import type { User } from './domain/types.ts'
import type { Mailer } from './mail.ts'
import { deriveIsAdmin } from './api/auth.ts'

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
  adminEmails: ReadonlySet<string>
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
    // Both tiers ride ONE apiKey() call as an array of configs — NOT two
    // separate apiKey() calls. apiKey() returns a single plugin object with
    // a fixed `id: "api-key"` (installed source,
    // @better-auth/api-key/dist/index.mjs:2318+); better-auth keys its
    // plugin registry by that id, so a second apiKey() call replaces the
    // first wholesale instead of adding to it — confirmed empirically
    // (configId:'user' started throwing NO_DEFAULT_API_KEY_CONFIGURATION_FOUND
    // the moment a second, separate apiKey({configId:'admin'}) call was
    // added). Passing an array is the plugin's own documented multi-config
    // shape (same file: `Array.isArray(_configurations) ? _configurations : [...]`).
    apiKey([
      // Phase 2 of the external-API design (2026-07-30): one named config for
      // personal read-only keys. Only the permissions phase 2's routes check
      // are registered here — write/follows/profile land with phase 3, not
      // pre-declared now.
      {
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
      },
      // Phase 4: the admin tier. Never self-serve — no route offers this
      // configId to a regular user. rateLimit reuses the user tier's own
      // conservative default (a scripted admin client crossing 300 req/hr is
      // already anomalous); defaultPrefix is distinct so an admin key is
      // visually distinguishable from a personal one at a glance.
      {
        configId: 'admin',
        references: 'user',
        defaultPrefix: 'rsc_admin_',
        rateLimit: { enabled: true, timeWindow: 1000 * 60 * 60, maxRequests: 300 },
        permissions: {
          defaultPermissions: {},
        },
      },
    ]),
    // Final review Finding 3: Task 5's registered-only guard only covers this
    // app's OWN POST /me/api-keys — better-auth's plugin-mounted REST
    // endpoint (/api-key/create, still live under the /api/auth/* catch-all)
    // had no equivalent guard, so an anonymous guest session could mint a
    // real (if currently permission-less) key directly via better-auth's own
    // API, an unbounded row-growth path in the new `apikey` table. Real
    // mechanism confirmed by reading the installed source, not guessed: a
    // hand-rolled BetterAuthPlugin's `hooks.before` (matcher + handler) is
    // how better-auth's own bundled plugins do exactly this (e.g.
    // node_modules/better-auth/dist/plugins/phone-number/index.mjs) — there
    // is no such option inside apiKey()'s own config surface. getSessionFromCtx
    // is the same helper the plugin's createApiKey handler itself uses; the
    // `ctx.request || ctx.headers` check mirrors that handler's own
    // `isClientRequest` test, so this hook is a no-op for this app's own
    // in-process call from POST /me/api-keys (no headers on that call) —
    // that route already enforces registered-only itself, one layer up.
    {
      id: 'reject-anon-api-key-create',
      hooks: {
        before: [
          {
            matcher: (ctx) => ctx.path === '/api-key/create',
            handler: createAuthMiddleware(async (ctx) => {
              if (!ctx.request && !ctx.headers) return // server-only call — not a real HTTP request
              const session = await getSessionFromCtx(ctx)
              if ((session?.user as { isAnonymous?: boolean | null } | undefined)?.isAnonymous === true) {
                throw new APIError('FORBIDDEN', { message: 'registration required' })
              }
            }),
          },
        ],
      },
    },
    // The ONLY authoritative gate on configId:'admin' — see this plan's
    // Global Constraints. Covers BOTH create and update (the spec's
    // "Enforcement correction, rev 2" explicitly calls out update too, since
    // create then update-with-configId otherwise risks a bypass, though in
    // practice `configId` on update is used only to LOOK UP a key, not
    // reassign one — checked anyway, cheap and correct either way). Same
    // is-this-a-real-HTTP-request guard as reject-anon-api-key-create
    // above: an in-process call (no ctx.request/ctx.headers) is this app's
    // own code, already trusted one layer up.
    //
    // Rev 2 (ponytail-review Critical finding): does NOT also scan
    // ctx.body.permissions for admin.* keys, unlike rev 1's draft. That
    // check was dead on every path this hook can observe: a real HTTP
    // request carrying ANY `permissions` field — admin.* or not — is
    // already rejected by the plugin's own SERVER_ONLY_PROPERTY check
    // (@better-auth/api-key/dist/index.mjs:730-738/1481-1489) regardless of
    // admin status, and an in-process call never reaches this hook at all
    // (no ctx.request/ctx.headers, same early return as below) — which is
    // exactly why POST /admin/api-keys (Task 2) enforces its OWN
    // permission whitelist instead of relying on this hook for that part.
    {
      id: 'reject-non-admin-admin-key',
      hooks: {
        before: [
          {
            matcher: (ctx) => ctx.path === '/api-key/create' || ctx.path === '/api-key/update',
            handler: createAuthMiddleware(async (ctx) => {
              if (!ctx.request && !ctx.headers) return
              const body = ctx.body as { configId?: string } | undefined
              if (body?.configId !== 'admin') return
              const session = await getSessionFromCtx(ctx)
              const isAdmin = session
                ? deriveIsAdmin(session.user as { email?: string | null; emailVerified?: boolean | null }, deps.adminEmails)
                : false
              if (!isAdmin) throw new APIError('FORBIDDEN', { message: 'admin only' })
            }),
          },
        ],
      },
    },
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
