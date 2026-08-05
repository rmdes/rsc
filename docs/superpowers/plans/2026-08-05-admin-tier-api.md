# Admin-tier API (phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the admin tier of the external-API design — a `configId:'admin'`
api-key config, never self-serve, gated by a plugin-level `before` hook, plus
the read/governance/moderation routes it authorizes and an admin-only web
panel to mint the keys.

**Architecture:** Same `apiKeyAuth`-composition pattern phases 2/3 already
established (`core/src/api/logical-routes.ts`), extended with: a second
`apiKey()` plugin config; a `before` hook that is the sole authoritative gate
on who can ever hold `configId:'admin'` or any `admin.*` permission; a new
`apiKeyAuthAdmin` middleware that additionally re-derives admin status from
the *current* `adminEmails` config on every request (a key survives its
owner losing admin only until the next call); and a new `/admin-api/*`
top-level path segment for the 8 new key-authed routes (verified live: Hono's
`app.use('/admin/*', authed, requireAdmin())` wildcard matches by path
*segment*, so `/admin-api/*` is untouched by it, while any route actually
registered under `/admin/*` — like the new key-issuance route — inherits
that gate for free, provided it is registered *after* the wildcard line).

**Tech Stack:** Hono (core's HTTP layer), `@better-auth/api-key` (already a
dependency since phase 2), better-sqlite3 raw SQL for one new read against
better-auth's own `user` table, SvelteKit 5 for the new admin panel.

## Global Constraints

- **Scope is the spec's literal route list, not full admin-UI parity**
  (explicit maintainer decision, 2026-08-05): the live `/admin/*` surface has
  grown to 24 routes since the spec was written; only the ~9 the spec
  actually names get a key-authed twin. Everything else (acquisition-runs
  detail, tombstones, item hide/restore, source purge/refresh/reap,
  `/admin/sources/:id` detail, subscriptions/audit/members) stays
  cookie-only. Do not add more "for completeness" — that is out of scope for
  this plan.
- **New routes never live under `/admin/*`** except the one that is meant to
  inherit the existing cookie-session gate (`POST /admin/api-keys`, Task 2).
  Every other new route lives under `/admin-api/*`, a verified-live, distinct
  path segment the `/admin/*` wildcard does not match.
- **Hono middleware order is registration-order-dependent** (verified live,
  not assumed): a route registered before `app.use('/admin/*', authed,
  requireAdmin())` (app.ts:256) never runs that gate, regardless of path.
  `mountAdminApiRoutes` (new, Task 2) MUST be called from `createApp` after
  that line — not merged into the existing `mountPersonalApiRoutes` call at
  app.ts:200, which sits before it.
- **`configId:'admin'` and any `admin.*` permission is reachable ONLY
  through the plugin-level `before` hook** (Task 1) — never a bespoke
  issuance route's own gate alone (a route-based gate is bypassable via the
  existing `/api/auth/*` proxy, which forwards bodies blindly). The hook is
  the sole authority; `POST /admin/api-keys` (Task 2) is a convenience path
  that happens to also enforce its own whitelist, for a documented,
  independent reason (below), not as the real boundary.
- **In-process calls are invisible to the `before` hook** (confirmed by
  reading the installed `@better-auth/api-key` source and by this
  codebase's own existing comment on `POST /me/api-keys`, `core/src/api/
  logical-routes.ts:778-787`, which explicitly predicts this exact task):
  the hook's `getSessionFromCtx` guard only fires for a real HTTP request
  (`ctx.request || ctx.headers` truthy). `POST /admin/api-keys` calls
  `auth.api.createApiKey` in-process, so it MUST enforce its own admin
  whitelist explicitly — it cannot rely on the hook.
- **Admin re-verification is per-request, not per-key-mint** (spec,
  "Admin tier (phase 4)"): every `/admin-api/*` route re-derives `isAdmin`
  from the *current* `adminEmails` config for the key's owning user on every
  call, via a new `apiKeyAuthAdmin` middleware (Task 3) — not just once at
  key-creation time. A key minted while its owner was an admin must stop
  working the moment they're removed from `RSC_ADMIN_EMAIL`, without needing
  the key itself revoked.
- **Governance-action routes are restricted to the spec's six named verbs**
  (`pause`, `resume`, `quarantine`, `allow`, `block`, `unblock`) — the
  existing generic `:action` route also accepts `approve`, `reject`,
  `revoke`, `attribution-mode` (10 actions total, confirmed against
  `SOURCE_TRANSITIONS` in `core/src/domain/source-repository.ts`), none of
  which the spec names for this tier. The key-authed twin (Task 4) 400s
  anything outside the six.
- **No duplicated business logic** — every new route calls the exact same
  service/repository functions its cookie-authed sibling already calls.
  Only a second, key-authenticated entry point, transcribed faithfully
  (validation, status codes, response shapes) unless a Global Constraint
  above says otherwise.
- **Hono house style** (project `hono` skill): hand-rolled validation
  (`isString`, `readJsonBody`), `c.json({error}, status)` not
  `HTTPException`, no `zValidator`, no RPC client, factory-returning-
  `MiddlewareHandler` pattern for new middleware.
- **`core/src` runs on Node native type-stripping** — no TypeScript
  parameter properties, no build step.
- **Task 6 (web UI) MUST invoke the `ui-ux-pro-max` skill before any Svelte
  edits**, per this repo's CLAUDE.md, and follow `design-system/rsc/
  MASTER.md`. Read `web/src/routes/settings/api-keys/` fresh first — Task 6
  is explicitly a close mirror of that existing, working page, not a
  redesign.
- **Never write library calls from memory** — the `@better-auth/api-key`
  behaviors this plan relies on (multiple `configId`s via multiple plugin
  registrations, `configId`/`permissions` fields on `/api-key/create` and
  `/api-key/update`, `SERVER_ONLY_PROPERTY` on `permissions` for any real
  HTTP call, `?configId=` filtering on `/api-key/list`) were all confirmed
  by reading the installed source at
  `core/node_modules/@better-auth/api-key/dist/index.mjs` and its type
  declarations during planning — implementers should do the same before
  changing any of this, not trust this document as a substitute.

---

### Task 1: Admin-tier apiKey config + plugin-level `before` hook

**Files:**
- Modify: `core/src/auth.ts`
- Modify: `core/src/server.ts:50` (the `createAuth({...})` call)
- Test: `core/test/auth-admin-key-gate.test.ts` (new)

**Interfaces:**
- Consumes: `deriveIsAdmin(user: {email?: string|null; emailVerified?: boolean|null}, adminEmails: ReadonlySet<string>): boolean` (already exported from `core/src/api/auth.ts:55`) — import it into `core/src/auth.ts` (a type-only import already runs the other direction, `core/src/api/auth.ts:3` imports `type Auth` from `../auth.ts`; importing a real value the other way does not create a cycle since that existing import is type-only and erased at compile time).
- Produces: `AuthDeps` gains `adminEmails: ReadonlySet<string>`, consumed by Task 2's `mountAdminApiRoutes` indirectly (via `config.adminEmails`, already threaded into `createApp` today at `core/src/api/app.ts:122`) and directly by this task's own `before` hook.

- [ ] **Step 1: Write the failing test**

```ts
// core/test/auth-admin-key-gate.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createAuth } from '../src/auth.ts'

describe('admin-tier api-key gate (before hook)', () => {
  let db: Database.Database
  let repo: ReturnType<typeof createSqliteRepository>

  beforeEach(() => {
    db = new Database(':memory:')
    repo = createSqliteRepository(db)
  })
  afterEach(() => db.close())

  function makeAuth(adminEmails: ReadonlySet<string>) {
    return createAuth({
      sqlite: repo.raw, users: repo, secret: 'test-secret-test-secret-32chars',
      webOrigin: 'http://localhost:5173', anonTtlDays: 30, mailer: null,
      authOpenApi: false, adminEmails,
    })
  }

  async function registerAndVerify(auth: ReturnType<typeof createAuth>, email: string) {
    const signUp = await auth.api.signUpEmail({ body: { email, password: 'password123', name: email } })
    const userId = signUp.user.id
    db.prepare(`UPDATE user SET emailVerified = 1 WHERE id = ?`).run(userId)
    const session = await auth.api.getSession({ headers: new Headers() }) // placeholder; real header set below per-test
    return userId
  }

  test('a non-admin session cannot create a configId:admin key over real HTTP', async () => {
    const auth = makeAuth(new Set())
    const signUp = await auth.api.signUpEmail({ body: { email: 'nonadmin@x.test', password: 'password123', name: 'x' } })
    db.prepare(`UPDATE user SET emailVerified = 1 WHERE id = ?`).run(signUp.user.id)
    const signIn = await auth.api.signInEmail({
      body: { email: 'nonadmin@x.test', password: 'password123' }, returnHeaders: true,
    }) as unknown as { headers: Headers }
    const cookie = signIn.headers.get('set-cookie') ?? ''
    await expect(
      auth.api.createApiKey({
        headers: new Headers({ cookie }),
        body: { configId: 'admin', name: 'k', permissions: { 'admin.read': ['read'] } },
      }),
    ).rejects.toThrow()
  })

  test('a non-admin session cannot create a configId:user key with an admin.* permission', async () => {
    const auth = makeAuth(new Set())
    const signUp = await auth.api.signUpEmail({ body: { email: 'sneaky@x.test', password: 'password123', name: 'x' } })
    db.prepare(`UPDATE user SET emailVerified = 1 WHERE id = ?`).run(signUp.user.id)
    const signIn = await auth.api.signInEmail({
      body: { email: 'sneaky@x.test', password: 'password123' }, returnHeaders: true,
    }) as unknown as { headers: Headers }
    const cookie = signIn.headers.get('set-cookie') ?? ''
    await expect(
      auth.api.createApiKey({
        headers: new Headers({ cookie }),
        body: { configId: 'user', name: 'k', permissions: { 'admin.moderation': ['write'] } },
      }),
    ).rejects.toThrow()
  })

  test('an admin session (verified email in adminEmails) CAN create a configId:admin key', async () => {
    const auth = makeAuth(new Set(['boss@x.test']))
    const signUp = await auth.api.signUpEmail({ body: { email: 'boss@x.test', password: 'password123', name: 'x' } })
    db.prepare(`UPDATE user SET emailVerified = 1 WHERE id = ?`).run(signUp.user.id)
    const signIn = await auth.api.signInEmail({
      body: { email: 'boss@x.test', password: 'password123' }, returnHeaders: true,
    }) as unknown as { headers: Headers }
    const cookie = signIn.headers.get('set-cookie') ?? ''
    const created = await auth.api.createApiKey({
      headers: new Headers({ cookie }),
      body: { configId: 'admin', name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    expect(created.id).toBeTruthy()
  })

  test('an in-process call (no headers) still works for configId:user — the hook is a no-op for server-side calls', async () => {
    const auth = makeAuth(new Set())
    const signUp = await auth.api.signUpEmail({ body: { email: 'inproc@x.test', password: 'password123', name: 'x' } })
    const created = await auth.api.createApiKey({
      body: { configId: 'user', userId: signUp.user.id, name: 'k', permissions: { timeline: ['read'] } },
    })
    expect(created.id).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from the repo root, or the appropriate worktree):
`docker compose exec -T core npm test -w core -- auth-admin-key-gate`
Expected: FAIL — `createAuth` doesn't accept `adminEmails` yet (TypeScript
error under `tsc --noEmit`; at runtime, every `configId:'admin'` / `admin.*`
request currently succeeds unchecked, so the "cannot create" tests fail by
NOT throwing).

- [ ] **Step 3: Add `adminEmails` to `AuthDeps` and thread it from `server.ts`**

In `core/src/auth.ts`, extend the interface:

```ts
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
```

In `core/src/server.ts`, extend the existing call (line 50) — add one field,
change nothing else:

```ts
const auth = createAuth({ sqlite: repo.raw, users: repo, secret: config.authSecret, webOrigin: config.webOrigin, anonTtlDays: config.anonTtlDays, mailer, authOpenApi: config.authOpenApi, adminEmails: config.adminEmails })
```

- [ ] **Step 4: Add the second `apiKey()` plugin config + the `before` hook**

In `core/src/auth.ts`, import `deriveIsAdmin`:

```ts
import { deriveIsAdmin } from './api/auth.ts'
```

Add a second `apiKey(...)` entry to the `plugins` array, right after the
existing `configId: 'user'` one, and a new hook entry right after the
existing `reject-anon-api-key-create` hook (both inside the same `plugins`
array literal):

```ts
    // Phase 4: the admin tier. Never self-serve — no route offers this
    // configId to a regular user. rateLimit reuses the user tier's own
    // conservative default (a scripted admin client crossing 300 req/hr is
    // already anomalous); defaultPrefix is distinct so an admin key is
    // visually distinguishable from a personal one at a glance.
    apiKey({
      configId: 'admin',
      references: 'user',
      defaultPrefix: 'rsc_admin_',
      rateLimit: { enabled: true, timeWindow: 1000 * 60 * 60, maxRequests: 300 },
      permissions: {
        defaultPermissions: {},
      },
    }),
    // The ONLY authoritative gate on configId:'admin'/admin.* — see this
    // plan's Global Constraints. Covers BOTH create and update (the spec's
    // "Enforcement correction, rev 2" explicitly calls out update too, since
    // create then update-with-permissions would otherwise be a bypass).
    // Same is-this-a-real-HTTP-request guard as reject-anon-api-key-create
    // above, for the same reason: an in-process call (no ctx.request/
    // ctx.headers) is this app's own code, already trusted one layer up.
    {
      id: 'reject-non-admin-admin-key',
      hooks: {
        before: [
          {
            matcher: (ctx) => ctx.path === '/api-key/create' || ctx.path === '/api-key/update',
            handler: createAuthMiddleware(async (ctx) => {
              if (!ctx.request && !ctx.headers) return
              const body = ctx.body as { configId?: string; permissions?: Record<string, string[]> } | undefined
              const requestsAdmin =
                body?.configId === 'admin' ||
                Object.keys(body?.permissions ?? {}).some((resource) => resource.startsWith('admin.'))
              if (!requestsAdmin) return
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker compose exec -T core npm test -w core -- auth-admin-key-gate`
Expected: PASS (4/4).

- [ ] **Step 6: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`
Expected: all existing tests still pass, 0 new type errors.

- [ ] **Step 7: Commit**

```bash
git add core/src/auth.ts core/src/server.ts core/test/auth-admin-key-gate.test.ts
git commit -m "$(cat <<'EOF'
feat(core): admin-tier api-key config + before-hook gate (admin.read/write)

Adds a second apiKey() plugin config (configId:'admin') alongside the
existing user tier, plus the plugin-level before hook that is the sole
authoritative boundary on who can ever hold configId:'admin' or any
admin.* permission — a route-based gate alone is bypassable through the
existing bodies-forwarded-blindly /api/auth/* proxy.

developed with the help of AI tools
EOF
)"
```

---

### Task 2: Admin key issuance route (`POST /admin/api-keys`)

**Files:**
- Modify: `core/src/api/logical-routes.ts` (new `AdminApiDeps` interface +
  `mountAdminApiRoutes` function)
- Modify: `core/src/api/app.ts` (call `mountAdminApiRoutes` — placement
  matters, see Global Constraints)
- Test: `core/test/admin-api-routes.test.ts` (new — this file grows through
  Tasks 2-5)

**Interfaces:**
- Consumes: `auth.api.createApiKey` (the same in-process call `POST
  /me/api-keys` already makes — `ApiKeyCreation` interface at
  `logical-routes.ts:564` is reusable as-is, no change needed).
- Produces: `AdminApiDeps { auth: Auth }` (Task 3 extends this with more
  fields as later routes need them — `users`, `adminEmails`, `service`,
  `sourceRepo`, `sourceService`, `logicalStore`, `feeds`, `websubMode`,
  `pushInEnabled`, `mailEnabled`, `pollSeconds`). `mountAdminApiRoutes(app:
  Hono, deps: AdminApiDeps): void`.

**Why this route is cookie-authed, not key-authed:** minting a key is
inherently a session-authed action (an admin logs in, visits the panel,
requests a new key) — there is no key to authenticate WITH yet. This exactly
mirrors why `POST /me/api-keys` (phase 2) is cookie-authed despite living
among key-authed personal routes.

**Why this route needs its own permission whitelist despite the Task 1
hook:** the hook is invisible to this route's own in-process
`auth.api.createApiKey` call (no `ctx.request`/`ctx.headers`) — see Global
Constraints. This route is safe only because `requireAdmin()` already gates
the whole `/admin/*` prefix it's mounted under (this task places its mount
call after that gate — see Step 4) AND it enforces its own whitelist below,
belt-and-suspenders, matching the exact pattern `POST /me/api-keys` already
uses for the user tier.

- [ ] **Step 1: Write the failing test**

```ts
// core/test/admin-api-routes.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createAuth } from '../src/auth.ts'
import { createApp } from '../src/api/app.ts'
import { createService } from '../src/domain/service.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createSourceService } from '../src/domain/source-service.ts'

async function setup(adminEmails: ReadonlySet<string> = new Set(['admin@x.test'])) {
  const db = new Database(':memory:')
  const repo = createSqliteRepository(db)
  const auth = createAuth({
    sqlite: repo.raw, users: repo, secret: 'test-secret-test-secret-32chars',
    webOrigin: 'http://localhost:5173', anonTtlDays: 30, mailer: null,
    authOpenApi: false, adminEmails,
  })
  const bus = createEventBus()
  const service = createService(repo, bus)
  const sourceService = createSourceService(repo, null)
  const app = createApp({
    service, bus, token: 'ops-token', auth, users: repo, adminEmails,
    sources: { service: sourceService, repo },
    logical: { store: { schedulerStats: () => ({ dueNow: 0, lastPollAt: null }) } } as never,
  })
  return { app, auth, repo, db }
}

async function registerSession(auth: ReturnType<typeof createAuth>, db: Database.Database, email: string) {
  const signUp = await auth.api.signUpEmail({ body: { email, password: 'password123', name: email } })
  db.prepare(`UPDATE user SET emailVerified = 1 WHERE id = ?`).run(signUp.user.id)
  const signIn = await auth.api.signInEmail({
    body: { email, password: 'password123' }, returnHeaders: true,
  }) as unknown as { headers: Headers }
  return { userId: signUp.user.id, cookie: signIn.headers.get('set-cookie') ?? '' }
}

describe('POST /admin/api-keys', () => {
  test('an admin session can mint an admin-tier key', async () => {
    const { app, auth, db } = await setup()
    const { cookie } = await registerSession(auth, db, 'admin@x.test')
    const res = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'ops-key', permissions: { 'admin.read': ['read'] } }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.key).toBeTruthy()
  })

  test('a non-admin registered session is rejected before reaching the route (403)', async () => {
    const { app, auth, db } = await setup()
    const { cookie } = await registerSession(auth, db, 'nobody@x.test')
    const res = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'k', permissions: { 'admin.read': ['read'] } }),
    })
    expect(res.status).toBe(403)
  })

  test('rejects a permission outside the admin whitelist', async () => {
    const { app, auth, db } = await setup()
    const { cookie } = await registerSession(auth, db, 'admin@x.test')
    const res = await app.request('/admin/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'k', permissions: { 'admin.superpowers': ['write'] } }),
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T core npm test -w core -- admin-api-routes`
Expected: FAIL — `mountAdminApiRoutes` doesn't exist yet, `POST
/admin/api-keys` 404s.

- [ ] **Step 3: Add `AdminApiDeps`, `mountAdminApiRoutes`, and the route**

In `core/src/api/logical-routes.ts`, add near `PersonalApiDeps` (the two
interfaces stay adjacent — both are `apiKeyAuth`-adjacent route mounts):

```ts
export interface AdminApiDeps {
  auth: Auth
}

// Mirrors ALLOWED_KEY_PERMISSIONS's shape and purpose exactly, scoped to the
// admin.* vocabulary — a raw request can't mint an admin key for a
// permission no admin-tier route checks yet (Tasks 3-5 add the routes this
// whitelist names; it is deliberately written to their FINAL shape now so
// this task doesn't need revisiting per later task).
const ALLOWED_ADMIN_KEY_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  'admin.read': ['read'],
  'admin.sources': ['write'],
  'admin.moderation': ['write'],
}
function isValidAdminKeyPermissions(v: unknown): v is Record<string, string[]> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length === 0) return false
  return entries.every(([resource, actions]) => {
    if (!Object.hasOwn(ALLOWED_ADMIN_KEY_PERMISSIONS, resource)) return false
    const allowed = ALLOWED_ADMIN_KEY_PERMISSIONS[resource]
    return Array.isArray(actions) && actions.length > 0 && actions.every((a) => typeof a === 'string' && allowed.includes(a))
  })
}

// Mounted from app.ts AFTER app.use('/admin/*', authed, requireAdmin()) —
// see this plan's Global Constraints (Hono middleware is registration-order
// dependent, verified live). Every route here already runs behind that
// gate; c.get('coreUser') is already set by `authed` by the time any
// handler below runs.
export function mountAdminApiRoutes(app: Hono, deps: AdminApiDeps): void {
  const { auth } = deps
  const apiKeyCreateApi = auth.api as unknown as ApiKeyCreation

  app.post('/admin/api-keys', jsonWrite, async (c) => {
    const body = await readJsonBody(c)
    if (!body || !isString(body.name, 1, 32)) return c.json({ error: 'name invalid' }, 400)
    if (!isValidAdminKeyPermissions(body.permissions)) return c.json({ error: 'permissions invalid' }, 400)
    try {
      const created = await apiKeyCreateApi.createApiKey({
        body: { configId: 'admin', userId: c.get('coreUser').id, name: body.name, permissions: body.permissions },
      })
      return c.json({ id: created.id, key: created.key, name: created.name, prefix: created.prefix }, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'could not create key' }, 400)
    }
  })
}
```

`ApiKeyCreation` and `jsonWrite`/`readJsonBody`/`isString` are already
defined/imported earlier in this file (reused, not duplicated).

- [ ] **Step 4: Mount it from `app.ts`, after the `/admin/*` gate**

In `core/src/api/app.ts`, add to the import at the top:

```ts
import { mountLogicalRoutes, mountLogicalReadRoutes, mountPersonalApiRoutes, mountAdminApiRoutes } from './logical-routes.ts'
```

Immediately after `app.use('/admin/*', authed, requireAdmin())` (currently
line 256 — find it fresh, do not assume the line number), add:

```ts
  // Registered AFTER the /admin/* gate above, not merged into the
  // mountPersonalApiRoutes call earlier in this function — Hono's
  // middleware is registration-order dependent (verified live during
  // planning), so a route registered before this gate would never be
  // gated by it, admin-tier or not.
  mountAdminApiRoutes(app, { auth: deps.auth })
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker compose exec -T core npm test -w core -- admin-api-routes`
Expected: PASS (3/3).

- [ ] **Step 6: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`

- [ ] **Step 7: Commit**

```bash
git add core/src/api/logical-routes.ts core/src/api/app.ts core/test/admin-api-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(core): admin-tier key issuance route (POST /admin/api-keys)

Cookie-authed, mounted after the existing /admin/* session gate so it
inherits requireAdmin() for free; enforces its own explicit permission
whitelist too, since the Task 1 before-hook is invisible to this route's
own in-process createApiKey call (no ctx.request/ctx.headers) — same
belt-and-suspenders pattern POST /me/api-keys already uses for the user
tier.

developed with the help of AI tools
EOF
)"
```

---

### Task 3: Admin re-verification middleware + admin.read routes

**Files:**
- Modify: `core/src/api/auth.ts` (extend `UserDirectory`, add
  `apiKeyAuthAdmin`)
- Modify: `core/src/storage/sqlite.ts` (implement the new `UserDirectory`
  method)
- Modify: `core/src/api/logical-routes.ts` (extend `AdminApiDeps`, add 4
  read routes to `mountAdminApiRoutes`)
- Modify: `core/src/api/app.ts` (extend the `mountAdminApiRoutes` call site)
- Test: `core/test/admin-api-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `deriveIsAdmin` (already imported for Task 1's hook, in a
  different file — `core/src/api/auth.ts` already defines it locally, no new
  import needed there).
- Produces: `UserDirectory` gains `getAuthUserAdminFields(authUserId:
  string): Promise<{email: string | null; emailVerified: boolean | null} |
  undefined>`. `apiKeyAuthAdmin(auth: Auth, users: UserDirectory,
  adminEmails: ReadonlySet<string>, permissions: Record<string, string[]>):
  MiddlewareHandler` — Tasks 4-5 reuse this unchanged, only varying
  `permissions`.

**Why a new `UserDirectory` method, not reusing `getUserByAuthUserId`:**
that method returns the domain `User` (id/handle/displayName/…), which has
no `email`/`emailVerified` fields at all — those live only in better-auth's
own `user` table. This mirrors the existing `instanceStats` method's own
pattern of a raw `this.raw.prepare(...)` query against that same table
(`core/src/storage/sqlite.ts:428-429`) rather than inventing a new
better-auth API call from memory.

- [ ] **Step 1: Write the failing test**

Append to `core/test/admin-api-routes.test.ts`:

```ts
import { mintKey } from './auth-helper.ts' // reuse the existing helper if present; otherwise inline the auth.api.createApiKey call directly, matching Tasks 1-3's phase-3 test style

describe('admin.read routes (admin re-verification)', () => {
  test('GET /admin-api/sources works for an admin-tier key', async () => {
    const { app, auth, repo, db } = await setup()
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await auth.api.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    const res = await app.request('/admin-api/sources', { headers: { 'x-api-key': created.key } })
    expect(res.status).toBe(200)
  })

  test('GET /admin-api/overview and /admin-api/users and /admin-api/settings all work with the same key', async () => {
    const { app, auth, db } = await setup()
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await auth.api.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    for (const path of ['/admin-api/overview', '/admin-api/users', '/admin-api/settings']) {
      const res = await app.request(path, { headers: { 'x-api-key': created.key } })
      expect(res.status).toBe(200)
    }
  })

  test('a key survives its owner staying admin, but 403s the moment they are removed from adminEmails', async () => {
    const db = new Database(':memory:')
    const repo = createSqliteRepository(db)
    let adminEmails = new Set(['revocable@x.test'])
    const auth = createAuth({
      sqlite: repo.raw, users: repo, secret: 'test-secret-test-secret-32chars',
      webOrigin: 'http://localhost:5173', anonTtlDays: 30, mailer: null, authOpenApi: false,
      adminEmails, // NOTE: captured by reference — createApp below must read from the same live Set the test mutates
    })
    const bus = createEventBus()
    const service = createService(repo, bus)
    const sourceService = createSourceService(repo, null)
    const app = createApp({
      service, bus, token: 'ops-token', auth, users: repo, adminEmails,
      sources: { service: sourceService, repo },
      logical: { store: { schedulerStats: () => ({ dueNow: 0, lastPollAt: null }) } } as never,
    })
    const { userId } = await registerSession(auth, db, 'revocable@x.test')
    const created = await auth.api.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    const before = await app.request('/admin-api/sources', { headers: { 'x-api-key': created.key } })
    expect(before.status).toBe(200)
    adminEmails.delete('revocable@x.test') // Set is mutated in place — confirm adminEmails is threaded as a live reference, not copied, before relying on this
    const after = await app.request('/admin-api/sources', { headers: { 'x-api-key': created.key } })
    expect(after.status).toBe(403)
  })
})
```

Note for the implementer: if `adminEmails` turns out to be copied (not held
by reference) anywhere along the `createApp` → `mountAdminApiRoutes` →
`apiKeyAuthAdmin` chain, the third test's mutation won't be observed — trace
the actual reference chain fresh rather than assuming; adjust the test to
construct a NEW `Set` and rebuild `app`/`auth` between the "before" and
"after" calls if a live-mutation test proves impractical.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T core npm test -w core -- admin-api-routes`
Expected: FAIL — none of the 4 new routes exist yet (404).

- [ ] **Step 3: Add the `UserDirectory` method + `SqliteRepository` implementation**

In `core/src/api/auth.ts`, extend the interface:

```ts
export interface UserDirectory {
  getUserByAuthUserId(authUserId: string): Promise<User | undefined>
  createLocalUser(u: { handle: string; displayName: string; authUserId?: string }): Promise<User>
  getAuthUserAdminFields(authUserId: string): Promise<{ email: string | null; emailVerified: boolean | null } | undefined>
}
```

In `core/src/storage/sqlite.ts`, add the implementation on
`SqliteRepository`, near `instanceStats` (same raw-query pattern against the
better-auth `user` table):

```ts
  async getAuthUserAdminFields(authUserId: string): Promise<{ email: string | null; emailVerified: boolean | null } | undefined> {
    const row = this.raw.prepare(`SELECT email, emailVerified FROM user WHERE id = ?`).get(authUserId) as
      | { email: string | null; emailVerified: number | null }
      | undefined
    if (!row) return undefined
    return { email: row.email, emailVerified: row.emailVerified === null ? null : row.emailVerified === 1 }
  }
```

(SQLite stores booleans as 0/1 — confirm the exact column type/affinity
against the real `user` table schema before assuming this cast is correct;
`instanceStats`'s own `isAnonymous = 1` comparison above is evidence for the
same convention, but verify rather than trust this plan.)

- [ ] **Step 4: Add `apiKeyAuthAdmin` middleware**

In `core/src/api/auth.ts`, near `apiKeyAuth`:

```ts
// Same permission-check contract as apiKeyAuth, plus a PER-REQUEST re-check
// that the key's owner is CURRENTLY an admin (spec: "a key minted while its
// owner was an admin stops working the moment they're removed from
// adminEmails, without needing to revoke the key itself"). Deliberately a
// separate middleware, not a flag on apiKeyAuth: the extra lookup has a
// real cost (one more query per request) that only admin-tier routes should
// pay, and conflating the two would make apiKeyAuth's signature ambiguous
// about whether adminEmails is required.
export function apiKeyAuthAdmin(
  auth: Auth, users: UserDirectory, adminEmails: ReadonlySet<string>, permissions: Record<string, string[]>,
): MiddlewareHandler {
  const apiKeyApi = auth.api as unknown as ApiKeyVerification
  return async (c, next) => {
    const key = c.req.header('x-api-key')
    if (!key) return c.json({ error: 'api key required' }, 401)
    const result = await apiKeyApi.verifyApiKey({ body: { configId: 'admin', key, permissions } })
    if (!result.valid || !result.key) return c.json({ error: 'invalid or insufficient api key' }, 401)
    const fields = await users.getAuthUserAdminFields(result.key.referenceId)
    if (!fields || !deriveIsAdmin(fields, adminEmails)) return c.json({ error: 'admin only' }, 403)
    c.set('coreUser', await ensureCoreUser(users, result.key.referenceId))
    return next()
  }
}
```

- [ ] **Step 5: Extend `AdminApiDeps` and add the 4 read routes**

In `core/src/api/logical-routes.ts`, extend the interface and imports (add
whatever's not already imported in this file — `Service`, `SourceRepository`,
`LogicalStore`/scheduler stats type, `FeedContext` — read the file fresh to
see what's already imported before adding duplicates):

```ts
export interface AdminApiDeps {
  auth: Auth
  users: UserDirectory
  adminEmails: ReadonlySet<string>
  service: Service
  sourceRepo: SourceRepository
  logicalStore: { schedulerStats(input: { now: string; pollSeconds: number }): unknown }
  feeds: FeedContext
  websubMode: string
  pushInEnabled: boolean
  mailEnabled: boolean
  pollSeconds: number
}
```

Add the 4 routes inside `mountAdminApiRoutes`, transcribed from their
cookie-authed twins in `app.ts` (`/admin/sources`, `/admin/users`,
`/admin/overview`, `/admin/settings` — read those bodies fresh, they may
have shifted line numbers since this plan was written) — same query-param
validation, same response shapes, only the auth middleware differs:

```ts
  const { users, adminEmails, service, sourceRepo, logicalStore, feeds, websubMode, pushInEnabled, mailEnabled, pollSeconds } = deps
  const readAdmin = apiKeyAuthAdmin(auth, users, adminEmails, { 'admin.read': ['read'] })

  app.get('/admin-api/sources', readAdmin, async (c) => {
    const args = pageArgs(c)
    if (args instanceof Response) return args
    const filter = c.req.query('filter')
    if (filter !== undefined && filter !== 'governance' && filter !== 'orphan') return c.json({ error: 'filter invalid' }, 400)
    const q = c.req.query('q')
    if (q !== undefined && q.length > 256) return c.json({ error: 'q invalid' }, 400)
    return c.json(await sourceRepo.listSourceSummaries(args.cursor, args.limit, filter as 'governance' | 'orphan' | undefined, q))
  })

  app.get('/admin-api/users', readAdmin, (c) => {
    const args = pageArgs(c)
    if (args instanceof Response) return args
    return c.json(service.listUsers(args.cursor, args.limit))
  })

  app.get('/admin-api/overview', readAdmin, (c) => c.json({
    counts: service.instanceStats(true),
    federation: { websub: websubMode, rssCloud: feeds.rssCloud, pushIn: pushInEnabled, publicUrl: feeds.publicUrl },
    mailEnabled,
    adminEmails: [...adminEmails],
    scheduler: logicalStore.schedulerStats({ now: new Date().toISOString(), pollSeconds }),
  }))

  app.get('/admin-api/settings', readAdmin, async (c) =>
    c.json({
      maxSubsPerUser: Number(await service.getSetting('max_subs_per_user') ?? '500'),
      maxRemoteItemsPerSource: Number(await service.getSetting('max_remote_items_per_source') ?? '0'),
      maxRemoteItemAgeDays: Number(await service.getSetting('max_remote_item_age_days') ?? '0'),
      ...(await readTabOverrides((k) => service.getSetting(k))),
    }))
```

`pageArgs` and `readTabOverrides` are defined in `app.ts`, not
`logical-routes.ts` — check whether they're already exported/importable, or
whether they need exporting from `app.ts` (same treatment `isBadSourceUrl`
already got in phase 3, Task 2b: exported and imported rather than
duplicated). Read both files fresh to confirm the current export surface
before deciding.

- [ ] **Step 6: Update the `mountAdminApiRoutes` call site in `app.ts`**

```ts
  mountAdminApiRoutes(app, {
    auth: deps.auth, users: deps.users, adminEmails,
    service, sourceRepo: sources.repo, logicalStore: deps.logical.store,
    feeds, websubMode, pushInEnabled, mailEnabled, pollSeconds,
  })
```

(`sources`, `feeds`, `websubMode`, `pushInEnabled`, `mailEnabled`,
`pollSeconds`, `adminEmails` are all already local variables in `createApp`
by this point in the file — reuse them, don't reconstruct.)

- [ ] **Step 7: Run test to verify it passes**

Run: `docker compose exec -T core npm test -w core -- admin-api-routes`
Expected: PASS (all tests in the file).

- [ ] **Step 8: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`

- [ ] **Step 9: Commit**

```bash
git add core/src/api/auth.ts core/src/storage/sqlite.ts core/src/api/logical-routes.ts core/src/api/app.ts core/test/admin-api-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(core): admin.read routes + per-request admin re-verification

Adds apiKeyAuthAdmin (verifies the key's permission AND re-derives the
owning user's current admin status every request, not just at key-mint
time) and the four admin.read routes: GET /admin-api/sources, /users,
/overview, /settings — key-authed twins of the existing cookie-authed
admin routes, same validation and response shapes.

developed with the help of AI tools
EOF
)"
```

---

### Task 4: admin.sources write routes (governance actions)

**Files:**
- Modify: `core/src/api/logical-routes.ts` (extend `AdminApiDeps`, add 2
  routes)
- Modify: `core/src/api/app.ts` (extend the `mountAdminApiRoutes` call site)
- Test: `core/test/admin-api-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `apiKeyAuthAdmin` (Task 3, unchanged). `sourceService:
  SourceService`'s `transition` and `establishFederation` methods (same
  ones `app.ts`'s cookie-authed `/admin/sources/:id/:action` and `/admin/
  sources` already call — confirm exact method names/signatures by reading
  `app.ts` fresh, since this plan paraphrases them).
- Produces: `AdminApiDeps` gains `sourceService: SourceService` (Task 5 does
  not need this field, but Task 6, if it ever needs a source lookup, could).

- [ ] **Step 1: Write the failing test**

Append to `core/test/admin-api-routes.test.ts`:

```ts
describe('admin.sources write routes', () => {
  test('POST /admin-api/sources/:id/:action rejects an action outside the six named verbs', async () => {
    const { app, auth, db } = await setup()
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await auth.api.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/sources/some-id/approve', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /admin-api/sources/:id/:action 404s an unknown source for a named verb', async () => {
    const { app, auth, db } = await setup()
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await auth.api.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/sources/unknown-id/pause', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1' }),
    })
    expect(res.status).toBe(404)
  })

  test('a posts:write-only key (wrong resource) is rejected', async () => {
    const { app, auth, db } = await setup()
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await auth.api.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.read': ['read'] } },
    })
    const res = await app.request('/admin-api/sources/some-id/pause', {
      method: 'POST', headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'c1' }),
    })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T core npm test -w core -- admin-api-routes`
Expected: FAIL — routes don't exist yet (404 for all, including the
"should 400/404" cases which currently just 404 generically rather than for
the right reason — read the actual failure output rather than assuming
which assertion fails).

- [ ] **Step 3: Add the 2 routes**

Read `app.ts`'s current `POST /admin/sources/:id/:action` and `POST
/admin/sources` bodies fresh (they're long — validation, the transition
matrix lookup, the `establishFederation` helper) and transcribe them into
`mountAdminApiRoutes`, with ONE addition: the six-verb allowlist this plan's
Global Constraints require.

```ts
  const writeAdminSources = apiKeyAuthAdmin(auth, users, adminEmails, { 'admin.sources': ['write'] })
  const ADMIN_API_ALLOWED_ACTIONS = new Set(['pause', 'resume', 'quarantine', 'allow', 'block', 'unblock'])

  app.post('/admin-api/sources/:id/:action', writeAdminSources, jsonWrite, async (c) => {
    const segment = c.req.param('action') ?? ''
    if (!ADMIN_API_ALLOWED_ACTIONS.has(segment)) return c.json({ error: 'action invalid' }, 400)
    // From here, transcribe app.ts's POST /admin/sources/:id/:action body
    // VERBATIM (validation, the transition call, every result branch) —
    // read it fresh, do not paraphrase from this plan. Only the actor
    // differs: c.get('coreUser').id from apiKeyAuthAdmin, same as the
    // cookie-authed route's c.get('coreUser').id from sessionAuth.
  })

  app.post('/admin-api/sources', writeAdminSources, jsonWrite, (c) =>
    establishFederation(c, c.get('coreUser').id, 'administrator'))
```

`establishFederation` is currently a local function inside `app.ts`'s
`createApp` (not exported) — it needs exporting (or the whole handler
inlined a second time, matching how `POST /admin/sources` calls it today).
Given `isBadSourceUrl` was already exported for exactly this reason in phase
3, exporting `establishFederation` the same way is the smaller, more
consistent diff. Check its exact signature fresh before wiring the call.

- [ ] **Step 4: Extend `AdminApiDeps` and the call site**

```ts
export interface AdminApiDeps {
  // ...existing fields
  sourceService: SourceService
}
```

```ts
  mountAdminApiRoutes(app, {
    // ...existing fields
    sourceService: v2,
  })
```

(`v2` is already `sources.service` by this point in `createApp` — reuse it.)

- [ ] **Step 5: Run test to verify it passes**

Run: `docker compose exec -T core npm test -w core -- admin-api-routes`

- [ ] **Step 6: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`

- [ ] **Step 7: Commit**

```bash
git add core/src/api/logical-routes.ts core/src/api/app.ts core/test/admin-api-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(core): admin.sources write routes (governance actions)

POST /admin-api/sources/:id/:action (restricted to the spec's six named
verbs — pause/resume/quarantine/allow/block/unblock, not the full
ten-action transition matrix) and POST /admin-api/sources (establish
federation) — key-authed twins of the existing cookie-authed routes.

developed with the help of AI tools
EOF
)"
```

---

### Task 5: admin.moderation write routes (hard removal)

**Files:**
- Modify: `core/src/api/logical-routes.ts` (add 2 routes)
- Test: `core/test/admin-api-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `service.deleteLocalAccount(handle)`, `service.deletePost(id)` —
  already available via the existing `service: Service` field on
  `AdminApiDeps` (Task 3). No new deps needed.

- [ ] **Step 1: Write the failing test**

Append to `core/test/admin-api-routes.test.ts`:

```ts
describe('admin.moderation write routes', () => {
  test('DELETE /admin-api/users/:handle 404s an unknown handle', async () => {
    const { app, auth, db } = await setup()
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await auth.api.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.moderation': ['write'] } },
    })
    const res = await app.request('/admin-api/users/nobody', {
      method: 'DELETE', headers: { 'x-api-key': created.key },
    })
    expect(res.status).toBe(404)
  })

  test('DELETE /admin-api/posts/:id 404s an unknown post', async () => {
    const { app, auth, db } = await setup()
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await auth.api.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.moderation': ['write'] } },
    })
    const res = await app.request('/admin-api/posts/nope', {
      method: 'DELETE', headers: { 'x-api-key': created.key },
    })
    expect(res.status).toBe(404)
  })

  test('an admin.sources-only key cannot hit moderation routes', async () => {
    const { app, auth, db } = await setup()
    const { userId } = await registerSession(auth, db, 'admin@x.test')
    const created = await auth.api.createApiKey({
      body: { configId: 'admin', userId, name: 'k', permissions: { 'admin.sources': ['write'] } },
    })
    const res = await app.request('/admin-api/posts/nope', {
      method: 'DELETE', headers: { 'x-api-key': created.key },
    })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T core npm test -w core -- admin-api-routes`
Expected: FAIL — 404 for the whole route (route doesn't exist), not the
404-for-unknown-resource these tests actually want to assert; the third
test gets a blanket 404 too rather than 401. Confirm the failure reason
matches this before moving on.

- [ ] **Step 3: Add the 2 routes**

```ts
  const writeAdminModeration = apiKeyAuthAdmin(auth, users, adminEmails, { 'admin.moderation': ['write'] })

  app.delete('/admin-api/users/:handle', writeAdminModeration, async (c) => {
    const result = await service.deleteLocalAccount(c.req.param('handle') ?? '')
    if ('error' in result) return c.json({ error: result.error === 'unknown' ? 'unknown user' : 'not a local account' }, result.error === 'unknown' ? 404 : 409)
    return c.json({ ok: true }, 200)
  })

  app.delete('/admin-api/posts/:id', writeAdminModeration, async (c) => {
    const result = await service.deletePost(c.req.param('id') ?? '')
    if ('error' in result) return c.json({ error: result.error === 'unknown' ? 'unknown post' : 'not a local post' }, result.error === 'unknown' ? 404 : 409)
    return c.json({ ok: true }, 200)
  })
```

(Transcribed verbatim from `app.ts`'s `DELETE /admin/users/:handle` and
`DELETE /admin/posts/:id` — reread those bodies fresh in case they've
shifted since this plan was written.)

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -T core npm test -w core -- admin-api-routes`

- [ ] **Step 5: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`

- [ ] **Step 6: Commit**

```bash
git add core/src/api/logical-routes.ts core/test/admin-api-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(core): admin.moderation write routes (hard removal)

DELETE /admin-api/users/:handle and DELETE /admin-api/posts/:id —
key-authed twins of the existing cookie-authed hard-removal routes. This
completes the core route surface for phase 4.

developed with the help of AI tools
EOF
)"
```

---

### Task 6: Admin key-management UI panel

**Files:**
- Create: `web/src/routes/admin/api-keys/+page.server.ts`
- Create: `web/src/routes/admin/api-keys/+page.svelte`
- Create: `web/src/routes/admin/api-keys/permissions.ts`
- Modify: `web/src/lib/api.ts` (add `listAdminApiKeys`, `createAdminApiKey`
  — `revokeApiKey` is reusable as-is, see below)
- Test: `web/src/routes/admin/api-keys/api-keys.server.test.ts` (new)

**Before writing any Svelte/CSS**, invoke the `ui-ux-pro-max` skill and read
`design-system/rsc/MASTER.md` per this repo's CLAUDE.md — this is a UI task.
Then read `web/src/routes/settings/api-keys/` (all 4 files) fresh — this
task is a close structural mirror of it, not a new design.

**Interfaces:**
- Consumes: `POST /admin/api-keys` (Task 2), `GET /api/auth/api-key/
  list?configId=admin` (better-auth's own REST endpoint, `configId`-filtered
  — same mechanism `listApiKeys` already uses with `configId=user`,
  confirmed against the installed plugin source during planning).
- Produces: nothing new consumed elsewhere — this is the tree's leaf.

**Why `revokeApiKey` needs no admin variant:** it deletes by `keyId`
(`web/src/lib/api.ts:294-301`, posts only `{ keyId }` to `/api/auth/api-key/
delete`) — no `configId` in the request at all, and a key id is unique
regardless of which config minted it. Reuse it verbatim.

**Why this page needs no explicit `isAdmin` check of its own:** it lives
under `/admin/`, so `web/src/routes/admin/+layout.server.ts`'s existing
`if (!me?.isAdmin) throw error(404, 'Not found')` gate already applies —
confirmed by reading that file during planning. A non-admin never reaches
this route at all.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/routes/admin/api-keys/api-keys.server.test.ts
import { describe, test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

function formData(fields: Record<string, string>) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

describe('admin api-keys create action', () => {
  test('posts accumulated admin.* permissions to POST /admin/api-keys', async () => {
    let capturedBody: { name?: string; permissions?: Record<string, string[]> } | undefined
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined
      return new Response(JSON.stringify({ id: 'k1', key: 'rsc_admin_xxx', name: 'ops' }), { status: 201 })
    })
    const event = {
      request: { formData: async () => formData({ name: 'ops', 'admin.read:read': 'on', 'admin.sources:write': 'on' }) },
      fetch: f, cookies: { get: () => 'session-cookie' }, url: new URL('http://localhost/admin/api-keys'),
    } as unknown as Parameters<typeof actions.create>[0]
    const result = await actions.create(event)
    expect(capturedBody?.permissions).toMatchObject({ 'admin.read': ['read'], 'admin.sources': ['write'] })
    expect((result as { createdKey?: string }).createdKey).toBe('rsc_admin_xxx')
  })
})
```

Note for the implementer: this test's shape is illustrative, not literal —
read `web/src/routes/settings/api-keys/api-keys.server.test.ts` fresh first
and match its ACTUAL mocking style (`authedFetch`/`cookieHeader` helpers,
exact event shape) rather than this sketch, which may not match the real
`+page.server.ts` contract once Step 3 is written.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- admin/api-keys`
Expected: FAIL — the route files don't exist yet.

- [ ] **Step 3: Add `permissions.ts`**

```ts
// web/src/routes/admin/api-keys/permissions.ts
// Mirrors settings/api-keys/permissions.ts's shape exactly, scoped to the
// admin.* vocabulary this panel offers — the REAL enforcement boundary is
// core's ALLOWED_ADMIN_KEY_PERMISSIONS (logical-routes.ts) and the Task 1
// before-hook, not this list.
export const PERMISSION_OPTIONS = [
	{ formKey: 'admin.read:read', resource: 'admin.read', action: 'read', label: 'Read sources, users, overview, and settings' },
	{ formKey: 'admin.sources:write', resource: 'admin.sources', action: 'write', label: 'Governance actions (pause, resume, quarantine, allow, block, unblock, establish federation)' },
	{ formKey: 'admin.sources:write', resource: 'admin.sources', action: 'write', label: 'placeholder — fix formKey collision before use, see note below' }
] as const
```

(That last placeholder line is a deliberate flag, not real code — the moment
`resource` contains a literal `.` (`admin.read`), reusing the existing
`PERMISSION_OPTIONS` sibling's `formKey` convention of `` `${resource}:
${action}` `` still works fine since `.` is a legal form-field-name
character, but double check the accumulation logic in Step 4 handles a
dotted resource name correctly — `Record<string,string[]>` keys are just
strings, so this should be a non-issue, but confirm rather than assume.
Remove this placeholder entry before committing; it exists only to flag the
check.)

- [ ] **Step 4: Add `+page.server.ts`**

Read `web/src/routes/settings/api-keys/+page.server.ts` fresh (all 89
lines) and mirror its structure closely:
- `load`: no `guard()` needed (the `/admin/` layout already gates on
  `isAdmin`) — just fetch `GET /api/auth/api-key/list?configId=admin`
  (add a `listAdminApiKeys(f)` function to `web/src/lib/api.ts`, modeled on
  the existing `listApiKeys` but with `?configId=admin` in the URL).
- `create` action: same accumulation logic phase 3's Task 4 already fixed
  in the sibling file (`permissions[opt.resource] = [...(permissions[opt.resource]
  ?? []), opt.action]`) — write it accumulating from the start here, don't
  reintroduce the overwrite bug phase 3 just fixed elsewhere. Posts to a new
  `createAdminApiKey(f, {name, permissions})` in `web/src/lib/api.ts`
  (modeled on `createApiKey`, POSTing to `/admin/api-keys` instead of
  `/me/api-keys`).
- `revoke` action: reuse the EXISTING `revokeApiKey` from `$lib/api` —
  verbatim, no new function needed (see Interfaces above).

- [ ] **Step 5: Add `+page.svelte`**

Read `web/src/routes/settings/api-keys/+page.svelte` fresh and mirror its
structure/markup closely — same list/create-form/revoke-button/
show-key-once pattern, using this directory's own `permissions.ts` for the
checkbox options. Follow `design-system/rsc/MASTER.md` for any styling (no
raw hex — every color from a `--color-*` variable, per Global Constraints).
If the existing settings page's styles are entirely reusable via existing
CSS classes with no new rules needed, say so explicitly rather than
copy-pasting styles that already exist globally.

- [ ] **Step 6: Add the two new `web/src/lib/api.ts` functions**

```ts
export async function listAdminApiKeys(f: typeof fetch): Promise<ApiKeySummary[]> {
	const res = await f(`${base()}/api/auth/api-key/list?configId=admin`)
	if (!res.ok) throw new Error(await errorMessage(res, `listAdminApiKeys ${res.status}`))
	const body = (await res.json()) as { apiKeys: ApiKeySummary[] }
	return body.apiKeys
}

export async function createAdminApiKey(f: typeof fetch, input: { name: string; permissions: Record<string, string[]> }): Promise<CreatedApiKey> {
	const res = await f(`${base()}/admin/api-keys`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	})
	if (!res.ok) throw Object.assign(new Error(await errorMessage(res, `createAdminApiKey ${res.status}`)), { status: res.status })
	return (await res.json()) as CreatedApiKey
}
```

(Placed near the existing `listApiKeys`/`createApiKey` — `ApiKeySummary`/
`CreatedApiKey` types are already defined and reusable as-is.)

- [ ] **Step 7: Run test to verify it passes**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- admin/api-keys`

- [ ] **Step 8: Manual browser check (do not skip — UI task)**

Start (or confirm running) this worktree's isolated dev stack, register/log
in as a user whose email is in `RSC_ADMIN_EMAIL` for that stack, visit
`/admin/api-keys`, confirm: the page renders, checkboxes match
`PERMISSION_OPTIONS` (minus the placeholder removed in Step 3), creating a
key with multiple permissions shows the plaintext key once, the created key
appears in the list afterward (without its plaintext), and revoke removes
it. As a non-admin registered user, confirm `/admin/api-keys` 404s (via the
existing layout gate).

- [ ] **Step 9: Run the full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web` and
`docker compose exec -T web npm run check -w web`

- [ ] **Step 10: Commit**

```bash
git add web/src/routes/admin/api-keys/ web/src/lib/api.ts
git commit -m "$(cat <<'EOF'
feat(web): admin key-management panel (mint configId:'admin' keys)

Mirrors settings/api-keys/ closely: list/create/revoke, gated for free by
the existing /admin/ layout's isAdmin check. Posts to the new POST
/admin/api-keys (Task 2) instead of /me/api-keys; reuses revokeApiKey
unchanged since key deletion is configId-agnostic.

developed with the help of AI tools
EOF
)"
```

---

## Self-Review

**Spec coverage:** all three "Admin tier (phase 4)" bullets from the spec
are covered within the agreed literal-list scope: `GET /api/v1/admin/...`
(Task 3, 4 routes) → `admin.read`; governance actions (Task 4, restricted to
the 6 named verbs) → `admin.sources: write`; hard removal (Task 5) →
`admin.moderation: write`. Admin re-verification per request (Task 3) and
admin key issuance via the standard whitelist-plus-hook mechanism (Tasks 1-2)
are both covered. "Key management UX" admin-tier panel is Task 6. The
named-consumer rationale (multi-instance scripting) needs no separate task —
it's satisfied by the routes existing and being scriptable, not by any
additional code.

**Placeholder scan:** one deliberate placeholder line exists in Task 6 Step
3, explicitly flagged as "remove before committing" with a stated reason
(catching a `formKey` collision risk) — not a plan gap, an instruction to
the implementer. No other TBD/TODO-style gaps found.

**Type consistency:** `AdminApiDeps` is introduced minimally in Task 2
(`{auth}`) and grows additively in Tasks 3-4 (`users`, `adminEmails`,
`service`, `sourceRepo`, `logicalStore`, `feeds`, `websubMode`,
`pushInEnabled`, `mailEnabled`, `pollSeconds`, `sourceService`), matching
`PersonalApiDeps`'s established growth pattern from phase 3. `readAdmin`/
`writeAdminSources`/`writeAdminModeration` middleware instances are each
constructed once per `mountAdminApiRoutes` call and reused across that
bucket's routes, matching phase 3's `apiKeyAuth(...)`-per-call style closely
enough while avoiding reconstructing the same middleware per route.

**Known open questions left for implementers, not resolved here** (per this
plan's own Global Constraints reminder to read code fresh rather than trust
paraphrase):
- Whether `pageArgs`/`readTabOverrides`/`establishFederation` need exporting
  from `app.ts` (very likely yes, given `isBadSourceUrl` already needed the
  same treatment in phase 3) — Tasks 3 and 4 flag this explicitly rather
  than assuming the exact mechanism.
- The exact SQLite boolean representation for `emailVerified` in the
  better-auth `user` table (Task 3, Step 3) — flagged for verification
  against the real schema rather than asserted.
- Task 3's third test (adminEmails-mutation-by-reference) may not work if
  `adminEmails` is copied anywhere in the dependency chain — an explicit
  fallback (rebuild `app`/`auth` between assertions) is given rather than
  leaving the implementer to discover this cold.

**Scope discipline:** re-affirms the Global Constraints' scope boundary —
this plan does NOT add key-authed twins for `/admin/sources/:id` (detail),
`/admin/sources/:id/subscriptions|audit|members|members/counts`,
`/admin/sources/:id/reap`, `/admin/sources/:sourceId/purge|refresh`,
`/admin/tombstones/*`, `/admin/items/*`, `/admin/acquisition-runs/*`. If a
real scripted-admin use case later needs one of these, it is a new,
separately-scoped follow-up, not a gap in this plan.
