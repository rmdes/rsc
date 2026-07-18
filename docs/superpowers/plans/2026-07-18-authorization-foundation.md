# Authorization Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give core an email-derived `isAdmin` signal (from `TEXTCASTER_ADMIN_EMAIL`), a reusable `requireAdmin` gate, `isAdmin` on `GET /me`, and one admin-gated `GET /admin/status` — fail-closed, core-only.

**Architecture:** No stored role. `config.ts` parses `TEXTCASTER_ADMIN_EMAIL` into a normalized `Set`; the `sessionAuth` middleware computes `isAdmin = emailVerified && adminEmails.has(email)` from the resolved better-auth user and puts it on the Hono context; a `requireAdmin` middleware gates admin routes.

**Tech Stack:** Node 22 (native type stripping, no build), Hono, better-auth 1.6.23, vitest, SQLite/Kysely.

**Spec:** `docs/superpowers/specs/2026-07-18-authorization-foundation-design.md` (rev 1).

## Global Constraints

- **Email-derived, no stored role, no migration.** The admin bit is computed at session resolution, never persisted.
- **Verified-only is load-bearing (not defensive):** `isAdmin` requires `emailVerified === true`. The email allowlist is only safe because hard verification proves inbox control — never drop the `emailVerified` check.
- **Anonymous sessions are never admin.** **Fail-closed:** no configured admin emails → `isAdmin` is always false → admin routes 403 for everyone.
- Email matching is **case-insensitive** (both the config set and the lookup are lowercased) and whitespace-trimmed.
- **SP1 changes no existing gate.** `POST /users` and all current routes keep their current auth; only `/me` gains a field and `/admin/status` is added.
- Core runs `.ts` under Node native type stripping — no build step. Tests: `npm test -w core` (vitest). **Never `git add -A`** (shared checkout); stage explicit paths. Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Config — parse `TEXTCASTER_ADMIN_EMAIL`

**Files:**
- Modify: `core/src/config.ts` (add `adminEmails` to `Config`, a parse helper, and the `loadConfig` return)
- Test: `core/test/config-admin.test.ts` (create)

**Interfaces:**
- Produces: `Config.adminEmails: Set<string>` — a normalized (lowercased, trimmed, non-empty) set of admin emails; empty when `TEXTCASTER_ADMIN_EMAIL` is unset/blank.

- [ ] **Step 1: Write the failing test**

Create `core/test/config-admin.test.ts`:

```ts
import { test, expect } from 'vitest'
import { loadConfig } from '../src/config.ts'

// loadConfig only hard-requires TOKEN + AUTH_SECRET; everything else defaults
// (websub off, no public URL needed).
const base = { TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's' }

test('TEXTCASTER_ADMIN_EMAIL parses to a lowercased, trimmed set', () => {
  const c = loadConfig({ ...base, TEXTCASTER_ADMIN_EMAIL: ' Admin@X.test , owner@Y.test ,, ' })
  expect([...c.adminEmails].sort()).toEqual(['admin@x.test', 'owner@y.test'])
})

test('unset or blank TEXTCASTER_ADMIN_EMAIL → empty set', () => {
  expect(loadConfig(base).adminEmails.size).toBe(0)
  expect(loadConfig({ ...base, TEXTCASTER_ADMIN_EMAIL: '  ,  , ' }).adminEmails.size).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w core -- config-admin`
Expected: FAIL — `c.adminEmails` is `undefined` (property doesn't exist yet).

- [ ] **Step 3: Implement**

In `core/src/config.ts`, add `adminEmails: Set<string>` to the `Config` interface (after `mailEnabled: boolean`):

```ts
  mailEnabled: boolean
  adminEmails: Set<string>
```

Add this parse helper near the other helpers (e.g. after `httpUrl`):

```ts
function parseAdminEmails(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0))
}
```

In `loadConfig`, before the `return`, add:

```ts
  const adminEmails = parseAdminEmails(env.TEXTCASTER_ADMIN_EMAIL)
```

And add `adminEmails` to the returned object (after `mailEnabled: smtpUrl !== null,`):

```ts
    mailEnabled: smtpUrl !== null,
    adminEmails,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w core -- config-admin`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/config.ts core/test/config-admin.test.ts
git commit -m "core: parse TEXTCASTER_ADMIN_EMAIL into config.adminEmails

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Email-derived admin gate (`isAdmin`, `requireAdmin`, `/me`, `/admin/status`)

**Files:**
- Modify: `core/src/api/auth.ts` (add `deriveIsAdmin`, `isAdmin` context var, `sessionAuth` sets it, `requireAdmin`, thread `adminEmails` through `sessionOrToken`)
- Modify: `core/src/api/app.ts` (add `adminEmails` to `createApp` deps; `/me` returns `isAdmin`; add `GET /admin/status`)
- Modify: `core/src/server.ts` (pass `config.adminEmails` to `createApp`)
- Modify: `docs/superpowers/documentation/RUNNING.md` (document `TEXTCASTER_ADMIN_EMAIL`)
- Test: `core/test/admin.test.ts` (create — unit for `deriveIsAdmin` + integration for the routes)

**Interfaces:**
- Consumes: `Config.adminEmails` (Task 1); existing `sessionAuth(auth, users)`, `registeredSession(app, email, repo)`, `anonSession(app)` helpers.
- Produces:
  - `deriveIsAdmin(user: { email?: string | null; emailVerified?: boolean | null }, adminEmails: ReadonlySet<string>): boolean`
  - `sessionAuth(auth, users, adminEmails?: ReadonlySet<string>)` — third param defaults to `new Set()`; sets `c.get('isAdmin')`.
  - `requireAdmin(): MiddlewareHandler` — 403 `{ error: 'admin only' }` when not admin.
  - context var `isAdmin: boolean`; `GET /me` response gains `isAdmin`; `GET /admin/status` → `{ ok: true, adminEmails: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `core/test/admin.test.ts`:

```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { deriveIsAdmin } from '../src/api/auth.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

// ── unit: the security-critical derivation ──
const admins = new Set(['admin@x.test'])
test('deriveIsAdmin: verified admin email → true', () => {
  expect(deriveIsAdmin({ email: 'admin@x.test', emailVerified: true }, admins)).toBe(true)
})
test('deriveIsAdmin: unverified admin email → false (linchpin)', () => {
  expect(deriveIsAdmin({ email: 'admin@x.test', emailVerified: false }, admins)).toBe(false)
})
test('deriveIsAdmin: verified non-admin → false', () => {
  expect(deriveIsAdmin({ email: 'someone@x.test', emailVerified: true }, admins)).toBe(false)
})
test('deriveIsAdmin: no email (anon) → false', () => {
  expect(deriveIsAdmin({ email: null, emailVerified: false }, admins)).toBe(false)
})
test('deriveIsAdmin: empty admin set → false', () => {
  expect(deriveIsAdmin({ email: 'admin@x.test', emailVerified: true }, new Set())).toBe(false)
})
test('deriveIsAdmin: case-insensitive match', () => {
  expect(deriveIsAdmin({ email: 'ADMIN@X.test', emailVerified: true }, admins)).toBe(true)
})

// ── integration: /me and /admin/status ──
async function makeApp(adminEmails: string[]) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, adminEmails: new Set(adminEmails) })
  return { app, repo }
}

test('admin session: /me isAdmin true, /admin/status 200', async () => {
  const { app, repo } = await makeApp(['boss@x.test'])
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const me = await app.request('/me', { headers: { cookie } })
  expect((await me.json()).isAdmin).toBe(true)
  const status = await app.request('/admin/status', { headers: { cookie } })
  expect(status.status).toBe(200)
  expect((await status.json())).toEqual({ ok: true, adminEmails: ['boss@x.test'] })
})

test('non-admin session: /me isAdmin false, /admin/status 403', async () => {
  const { app, repo } = await makeApp(['boss@x.test'])
  const cookie = await registeredSession(app, 'peon@x.test', repo)
  expect((await (await app.request('/me', { headers: { cookie } })).json()).isAdmin).toBe(false)
  expect((await app.request('/admin/status', { headers: { cookie } })).status).toBe(403)
})

test('anonymous session: /me isAdmin false, /admin/status 403', async () => {
  const { app } = await makeApp(['boss@x.test'])
  const cookie = await anonSession(app)
  expect((await (await app.request('/me', { headers: { cookie } })).json()).isAdmin).toBe(false)
  expect((await app.request('/admin/status', { headers: { cookie } })).status).toBe(403)
})

test('no admins configured: even a matching email is not admin (fail-closed)', async () => {
  const { app, repo } = await makeApp([])
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  expect((await (await app.request('/me', { headers: { cookie } })).json()).isAdmin).toBe(false)
  expect((await app.request('/admin/status', { headers: { cookie } })).status).toBe(403)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w core -- admin`
Expected: FAIL — `deriveIsAdmin` is not exported; `createApp` doesn't accept `adminEmails`; `/admin/status` 404; `/me` has no `isAdmin`.

- [ ] **Step 3: Implement in `core/src/api/auth.ts`**

Add `isAdmin` to the context map:

```ts
declare module 'hono' {
  interface ContextVariableMap {
    coreUser: User
    sessionIsAnonymous: boolean
    isAdmin: boolean
  }
}
```

Add the pure derivation (near the top, after imports):

```ts
// Email-derived admin. Verified-only is load-bearing: the allowlist is only safe
// because hard email verification proves control of the inbox (spec rev 1).
export function deriveIsAdmin(
  user: { email?: string | null; emailVerified?: boolean | null },
  adminEmails: ReadonlySet<string>,
): boolean {
  return user.emailVerified === true && typeof user.email === 'string' && adminEmails.has(user.email.toLowerCase())
}
```

Change `sessionAuth` to accept `adminEmails` (defaulted) and set `isAdmin`:

```ts
export function sessionAuth(auth: Auth, users: UserDirectory, adminEmails: ReadonlySet<string> = new Set()): MiddlewareHandler {
  return async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'authentication required' }, 401)
    c.set('coreUser', await ensureCoreUser(users, session.user.id))
    c.set('sessionIsAnonymous', (session.user as { isAnonymous?: boolean | null }).isAnonymous === true)
    c.set('isAdmin', deriveIsAdmin(session.user as { email?: string | null; emailVerified?: boolean | null }, adminEmails))
    return next()
  }
}
```

Add `requireAdmin` (after `registeredOnly`):

```ts
export function requireAdmin(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.get('isAdmin')) return c.json({ error: 'admin only' }, 403)
    return next()
  }
}
```

Thread `adminEmails` through `sessionOrToken` (so its session path also sets `isAdmin`):

```ts
export function sessionOrToken(token: string, auth: Auth, users: UserDirectory, adminEmails: ReadonlySet<string> = new Set()): MiddlewareHandler {
  const viaSession = sessionAuth(auth, users, adminEmails)
  const mustBeRegistered = registeredOnly()
  return async (c, next) => {
    const header = c.req.header('authorization')
    if (header !== undefined) return bearerAuth(token)(c, next)
    return viaSession(c, (() => mustBeRegistered(c, next)) as unknown as Next)
  }
}
```

- [ ] **Step 4: Implement in `core/src/api/app.ts`**

Add `requireAdmin` to the import:

```ts
import { sessionAuth, registeredOnly, sessionOrToken, requireAdmin } from './auth.ts'
```

Add `adminEmails` to the `createApp` deps type (append to the deps object type at line 56):

```ts
export function createApp(deps: { service: Service; bus: EventBus; token: string; auth: Auth; users: UserDirectory; feeds?: FeedContext; pushApi?: PushApi; pushInApi?: PushInApi; mailEnabled?: boolean; adminEmails?: ReadonlySet<string> }): Hono {
```

Just below `const { service, bus, token } = deps`, add:

```ts
  const adminEmails = deps.adminEmails ?? new Set<string>()
```

Replace the `/me` route (line 113) with one that threads `adminEmails` and returns `isAdmin`:

```ts
  app.get('/me', sessionAuth(deps.auth, deps.users, adminEmails), (c) => c.json({ user: c.get('coreUser'), isAnonymous: c.get('sessionIsAnonymous'), isAdmin: c.get('isAdmin') }))
```

Add the admin route immediately after the `/me` route:

```ts
  app.get('/admin/status', sessionAuth(deps.auth, deps.users, adminEmails), requireAdmin(), (c) => c.json({ ok: true, adminEmails: [...adminEmails] }))
```

- [ ] **Step 5: Implement in `core/src/server.ts`**

In the `createApp({ … })` call, add `adminEmails` (e.g. right after `token: config.token,`):

```ts
  token: config.token,
  adminEmails: config.adminEmails,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w core -- admin`
Expected: PASS (all 10 tests — 6 unit + 4 integration).

- [ ] **Step 7: Run the full core suite (no regressions from the middleware change)**

Run: `npm test -w core`
Expected: all pass. (The `sessionAuth`/`sessionOrToken` third param is defaulted, so existing call sites and tests are unaffected.)

- [ ] **Step 8: Document the env var in RUNNING.md**

In `docs/superpowers/documentation/RUNNING.md`, add a row to the `core/.env` variable table (after the `TEXTCASTER_ANON_TTL_DAYS` row):

```markdown
| `TEXTCASTER_ADMIN_EMAIL` | no | — | Comma-separated admin email(s). An account whose **verified** email matches becomes an instance admin (`isAdmin` on `/me`; unlocks admin-only routes like `GET /admin/status`). Unset = no admin (admin routes 403 for everyone). |
```

- [ ] **Step 9: Commit**

```bash
git add core/src/api/auth.ts core/src/api/app.ts core/src/server.ts core/test/admin.test.ts docs/superpowers/documentation/RUNNING.md
git commit -m "core: email-derived instance admin (isAdmin, requireAdmin, /admin/status)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Notes for the executor

- Both tasks are core-only; no web changes (web already reads `/me`, so it picks up `isAdmin` for free later).
- The security-critical logic is `deriveIsAdmin` (Task 2, unit-tested in isolation) — the `emailVerified === true` clause must never be dropped.
- The `sessionAuth`/`sessionOrToken` signature change is backward-compatible (defaulted third param), so unrelated tests and call sites keep working.
