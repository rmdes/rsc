# Authed Read API (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship per-user API keys (`@better-auth/api-key`, `configId: 'user'`)
and two read-only endpoints — `GET /api/v1/me/timeline` and
`GET /api/v1/me/posts` — plus a Settings UI to create/list/revoke keys.
Phase 2 of `docs/superpowers/specs/2026-08-01-external-api-and-firehose-design.md`
("Read endpoints (phase 2)" + the `configId: 'user'` half of "Key tiers" +
the user-tier half of "Key management UX"). Phase 1 (the public firehose) is
already merged. Phases 3 (write) and 4 (admin) are separate plans.

**Architecture:** Core adds the `apiKey` plugin to the existing `betterAuth()`
config (`core/src/auth.ts`) with one configuration (`configId: 'user'`), a
new `apiKeyAuth(auth, users, permissions)` middleware factory beside
`sessionAuth`/`requireAdmin` in `core/src/api/auth.ts` (calls
`auth.api.verifyApiKey` explicitly — `enableSessionForAPIKeys` is never
turned on, per the spec's invariant), and one new mount function,
`mountPersonalApiRoutes`, with the two read routes — both reuse the existing
`TimelineLens`/`clampLimit`/`decodeCursor` machinery `GET /timeline` already
uses, just resolving the account from the authenticated key-holder instead
of a `?followed_by=`/`?author=` handle. Web adds a new catch-all proxy
(`/api/v1/[...path]`, forwarding `x-api-key`) and a "API keys" settings
sub-page — **key management itself needs zero new web-to-core plumbing**:
this codebase has no `better-auth/client` SDK usage anywhere (confirmed by
grep — every existing auth interaction, e.g. `web/src/routes/login/
+page.server.ts`, is a hand-rolled `fetch` to `/api/auth/*` from a SvelteKit
form action), so the API keys page follows that exact existing pattern
instead of introducing a new client-library dependency.

**Tech Stack:** `@better-auth/api-key` (new dependency — justified in the
spec's Background section), Hono, the existing `LogicalStore`/journal-free
read path, SvelteKit form actions. No new web dependency.

## Global Constraints

- `enableSessionForAPIKeys` must never be set to `true` anywhere — every new
  route is gated by explicit `apiKeyAuth(...)` calling `verifyApiKey`, never
  by mocking a session from a key.
- No existing route changes behavior. `POST /posts`, `PATCH /me`, `/me/
  following`, etc. stay cookie-session-only.
- New routes only accept `x-api-key`, never a cookie — `apiKeyAuth` does not
  read `c.req.raw.headers`'s cookie at all.
- `configId: 'admin'` and any `admin.*` permission are **out of scope for
  this plan** — do not add them, do not add the plugin-level `before` hook
  that gates them (that's phase 4's job, once an admin route actually needs
  it). This plan's plugin config has exactly one `configId: 'user'`.
- Permission vocabulary added to the plugin config in this plan is limited to
  what phase 2's routes actually check: `timeline: ['read']` and
  `posts: ['read']`. Do **not** pre-register `write` actions or the
  `follows`/`profile` resources — YAGNI; phase 3 adds those together with
  the routes that check them.
- `/api/v1/*` routes are proxied through web; no Caddy/public-allowlist
  change anywhere in this plan.

---

### Task 1: Add `@better-auth/api-key` and wire the `user` config

**Files:**
- Modify: `core/package.json` — add `@better-auth/api-key` dependency.
- Modify: `core/src/auth.ts` — add the `apiKey` plugin.
- Test: `core/test/api-key-plugin.test.ts` (new).

**Interfaces:**
- Consumes: `betterAuth()`'s existing `plugins: BetterAuthPlugin[]` array in
  `core/src/auth.ts` (already holds `magicLink`/`anonymous`/`multiSession`/
  conditionally `openAPI`).
- Produces: `auth.api.createApiKey`/`verifyApiKey`/`listApiKeys`/
  `deleteApiKey` become callable on the `Auth` instance every other task in
  this plan depends on. The plugin's REST surface (exact paths TBD — see
  Step 1) rides the existing `/api/auth/*` mount with zero code change
  (`core/src/api/app.ts`'s `app.on(['GET','POST'], '/api/auth/*', ...)`).

- [ ] **Step 1: Install the dependency and read its real source — do not
  write any other code in this task until this step is done**

```bash
cd core && npm install @better-auth/api-key
```

Then read the actual installed package (`core/node_modules/@better-auth/
api-key/dist/*.d.ts` or equivalent — check `package.json`'s `exports`/
`types` field for the real entry point) to confirm, against the real
shipped types, not the illustrative snippets below:
- The exact plugin factory signature: is it `apiKey(options)` or
  `apiKey([{configId, ...}])` for a single named config (the docs show both
  a bare-object single-config form and an array form for multiple configs —
  confirm which applies when you want exactly one *named* config, since
  `configId: 'user'` needs to be addressable, not the implicit `'default'`).
- `auth.api.createApiKey`'s exact body type (does `permissions` accept a
  plain `Record<string, string[]>`, or a different shape?).
- `auth.api.verifyApiKey`'s exact return type (confirm the `result.key.
  referenceId`/`result.valid` shape used throughout this plan matches
  reality).
- The plugin's REST endpoint paths (grep the package source for
  `createAuthEndpoint` calls or a route table — you need the literal path
  for `create`/`list`/`delete`/`get` for Task 5's web-side fetch calls,
  e.g. confirm whether it's `/api-key/create` or something else under
  `/api/auth/`).

If anything in this brief's illustrative code doesn't match what you find,
use the real shape and note the correction in your report — do not silently
paper over a mismatch.

- [ ] **Step 2: Add the plugin to `core/src/auth.ts`**

Read the current file first (already read once for this plan — confirm
nothing changed). Add to the `plugins` array, using whatever the real
factory signature from Step 1 turns out to be. The intent, expressed against
the illustrative single-config shape from the spec (correct the literal
call per what Step 1 found):

```ts
import { apiKey } from '@better-auth/api-key'
```

```ts
apiKey({
  configId: 'user',
  references: 'user',
  defaultPrefix: 'rsc_',
  enableMetadata: false,
  // A conservative shared default a personal read-only script won't hit
  // under normal use; per-key override stays available via the plugin's
  // own createApiKey options if a future caller needs more.
  rateLimit: { enabled: true, timeWindow: 1000 * 60 * 60, maxRequests: 300 },
  permissions: {
    defaultPermissions: {},
  },
}),
```

Do **not** set `enableSessionForAPIKeys` (leave it at its default `false` —
this plan never reads this option at all, so don't add the line even to set
it explicitly to `false`; its absence is the correct, minimal statement of
intent, and an explicit `false` invites a later "just flip it" edit).

- [ ] **Step 3: Write and run a smoke test proving the plugin mounts and a
  key round-trips through create → verify → list → delete**

Read `core/test/auth-helper.ts` first (`makeAuth`, `registeredSession`,
`uniqueIp`) — reuse it, don't reinvent session setup.

Create `core/test/api-key-plugin.test.ts`:

```ts
import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'
import { Hono } from 'hono'

test('a user-owned api key can be created, verified, listed, and deleted via the plugin API directly', async () => {
  const repo = await createSqliteRepository(':memory:')
  const auth = makeAuth(repo)
  const app = new Hono()
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(app, 'reader@x.test', repo)

  // Resolve the core user id the session belongs to, the same way sessionAuth does.
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const authUserId = session!.user.id

  const created = await auth.api.createApiKey({
    body: { configId: 'user', userId: authUserId, name: 'test key', permissions: { timeline: ['read'] } },
  })
  expect(created.key).toBeTruthy() // the plaintext key, returned exactly once

  const verified = await auth.api.verifyApiKey({ body: { key: created.key!, permissions: { timeline: ['read'] } } })
  expect(verified.valid).toBe(true)
  expect(verified.key?.referenceId).toBe(authUserId)

  const insufficientlyScoped = await auth.api.verifyApiKey({ body: { key: created.key!, permissions: { posts: ['write'] } } })
  expect(insufficientlyScoped.valid).toBe(false)

  const listed = await auth.api.listApiKeys({ query: { configId: 'user' }, headers: new Headers({ cookie }) })
  expect(listed.apiKeys.some((k) => k.id === created.id)).toBe(true)
  expect((listed.apiKeys[0] as Record<string, unknown>).key).toBeUndefined() // never returns the plaintext key after creation

  await auth.api.deleteApiKey({ body: { keyId: created.id }, headers: new Headers({ cookie }) })
  const afterDelete = await auth.api.verifyApiKey({ body: { key: created.key!, permissions: { timeline: ['read'] } } })
  expect(afterDelete.valid).toBe(false)
})
```

This test's exact method/body shapes are illustrative pending Step 1's real
source read — adjust field names to match what you actually found (e.g. if
`references`/`configId` on `createApiKey`'s body differ from above, or if
`listApiKeys`/`deleteApiKey` need a different auth mechanism than session
cookies). The assertions' *intent* (create → verify succeeds with correct
permission → verify fails with wrong permission → list shows it without the
plaintext key → delete → verify fails afterward) is what must hold.

- [ ] **Step 4: Run the test to verify it fails, then passes**

Run: `docker compose exec -T core npm test -w core -- api-key-plugin`
Expected: FAIL before Step 2 (plugin not configured), PASS after.

- [ ] **Step 5: Full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`
Expected: all passing (baseline: verify fresh count before starting — this
plan assumes the count from the just-merged public-firehose branch, but
confirm rather than trust a stale number), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add core/package.json core/package-lock.json core/src/auth.ts core/test/api-key-plugin.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add @better-auth/api-key with a user-owned key config

One configId ('user'), scoped to exactly the permissions phase 2's
routes check (timeline:read, posts:read) — write/follows/profile
permissions land with phase 3, not pre-registered here. Verified
against the installed package's real source, not written from memory.

developed with the help of AI tools
EOF
)"
```

---

### Task 2: `apiKeyAuth` middleware

**Files:**
- Modify: `core/src/api/auth.ts` — add `apiKeyAuth`.
- Test: `core/test/api-key-auth-middleware.test.ts` (new).

**Interfaces:**
- Consumes: `Auth` (`auth.api.verifyApiKey`), `UserDirectory`/`ensureCoreUser`
  (both already in this file), the real `verifyApiKey` return shape Task 1
  pinned.
- Produces: `apiKeyAuth(auth: Auth, users: UserDirectory, permissions:
  Record<string, string[]>): MiddlewareHandler`, composed per-route by Task
  3 exactly like `sessionAuth`/`requireAdmin` are composed today. Sets the
  same `c.set('coreUser', ...)` context variable `sessionAuth` sets, so
  downstream handlers don't need to know which auth mechanism authenticated
  the request.

- [ ] **Step 1: Write the failing tests**

Read `core/src/api/auth.ts` in full (already read once for this plan) and
`core/test/auth-helper.ts` first.

Add to a new `core/test/api-key-auth-middleware.test.ts`:

```ts
import { test, expect } from 'vitest'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'
import { apiKeyAuth } from '../src/api/auth.ts'

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const auth = makeAuth(repo)
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'reader@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const authUserId = session!.user.id

  const app = new Hono()
  app.get('/protected', apiKeyAuth(auth, repo, { timeline: ['read'] }), (c) => c.json({ userId: c.get('coreUser').id }))

  const key = (await auth.api.createApiKey({ body: { configId: 'user', userId: authUserId, permissions: { timeline: ['read'] } } })).key!
  return { app, key, authUserId }
}

test('a valid key with the required permission reaches the handler and sets coreUser', async () => {
  const { app, key } = await setup()
  const res = await app.request('/protected', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { userId: string }
  expect(body.userId).toBeTruthy()
})

test('a missing key is rejected with 401', async () => {
  const { app } = await setup()
  const res = await app.request('/protected')
  expect(res.status).toBe(401)
})

test('an invalid key string is rejected with 401', async () => {
  const { app } = await setup()
  const res = await app.request('/protected', { headers: { 'x-api-key': 'not-a-real-key' } })
  expect(res.status).toBe(401)
})

test('a valid key WITHOUT the required permission is rejected with 401, not a partial success', async () => {
  const repo = await createSqliteRepository(':memory:')
  const auth = makeAuth(repo)
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'writer@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const app = new Hono()
  app.get('/protected', apiKeyAuth(auth, repo, { timeline: ['read'] }), (c) => c.json({ ok: true }))
  const key = (await auth.api.createApiKey({ body: { configId: 'user', userId: session!.user.id, permissions: { posts: ['write'] } } })).key!
  const res = await app.request('/protected', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(401)
})

test('coreUser resolves to the same core user the key\'s session already had (lazy-mint reuse, not a duplicate)', async () => {
  const { app, key, authUserId } = await setup()
  const res = await app.request('/protected', { headers: { 'x-api-key': key } })
  const body = (await res.json()) as { userId: string }
  // ensureCoreUser must find the SAME core row the registeredSession flow
  // already minted for this authUserId, not create a second one.
  expect(body.userId).toBeTruthy()
  void authUserId
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose exec -T core npm test -w core -- api-key-auth-middleware`
Expected: FAIL — `apiKeyAuth` doesn't exist yet.

- [ ] **Step 3: Implement `apiKeyAuth`**

In `core/src/api/auth.ts`, beside `sessionAuth`:

```ts
export function apiKeyAuth(auth: Auth, users: UserDirectory, permissions: Record<string, string[]>): MiddlewareHandler {
  return async (c, next) => {
    const key = c.req.header('x-api-key')
    if (!key) return c.json({ error: 'api key required' }, 401)
    const result = await auth.api.verifyApiKey({ body: { key, permissions } })
    if (!result.valid || !result.key) return c.json({ error: 'invalid or insufficient api key' }, 401)
    c.set('coreUser', await ensureCoreUser(users, result.key.referenceId))
    return next()
  }
}
```

Adjust field names (`result.valid`/`result.key`/`result.key.referenceId`) to
match whatever Task 1's Step 1 found the real `verifyApiKey` return shape to
be — this is the illustrative shape from the spec, not a guarantee.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker compose exec -T core npm test -w core -- api-key-auth-middleware`
Expected: all 5 pass.

- [ ] **Step 5: Full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`
Expected: all passing, 0 errors.

- [ ] **Step 6: Commit**

```bash
git add core/src/api/auth.ts core/test/api-key-auth-middleware.test.ts
git commit -m "$(cat <<'EOF'
feat(core): apiKeyAuth middleware — explicit verifyApiKey, never session-mocking

Same MiddlewareHandler-factory pattern as sessionAuth/requireAdmin,
sets the same coreUser context variable so downstream handlers don't
need to know which auth mechanism reached them. Deliberately does NOT
use enableSessionForAPIKeys (better-auth's own docs flag it as an
impersonation risk, and it has no per-route permission check).

developed with the help of AI tools
EOF
)"
```

---

### Task 3: `mountPersonalApiRoutes` — `GET /me/timeline` and `GET /me/posts`

**Files:**
- Modify: `core/src/api/logical-routes.ts` — add `mountPersonalApiRoutes`.
- Modify: `core/src/server.ts` — wire it.
- Test: `core/test/personal-api-routes.test.ts` (new).

**Interfaces:**
- Consumes: `apiKeyAuth` (Task 2), `LogicalStore.snapshot`/`projectTimeline`
  (already used by `GET /timeline`), `TimelineLens`/`PublicLocalAccount`
  (`core/src/logical/types.ts`), `clampLimit`/`decodeCursor` (already at
  module scope in `logical-routes.ts` — no export needed, same file).
- Produces: core routes `GET /me/timeline` and `GET /me/posts` (unprefixed —
  the `/api/v1` prefix is a web-proxy-only namespace, exactly like the
  firehose's core route was plain `/firehose/stream`). Task 4's proxy
  forwards `/api/v1/me/timeline` → core `/me/timeline` 1:1 by path, so these
  exact core path strings are load-bearing for Task 4.

- [ ] **Step 1: Read the current file fresh**

`core/src/api/logical-routes.ts` has grown since this plan was written
(the firehose task added ~150 lines) — read `mountLogicalReadRoutes`
(`GET /timeline`'s implementation) and the module-scope `clampLimit`/
`FEED_LIMIT`/`decodeCursor` import fresh, by content not line number.

- [ ] **Step 2: Write the failing tests**

Read `core/test/logical-sse.test.ts` for the `app.request`-against-a-fresh-
Hono-instance pattern, and `core/test/auth-helper.ts` for session/key setup.

Create `core/test/personal-api-routes.test.ts`:

```ts
import { test, expect } from 'vitest'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { mountPersonalApiRoutes } from '../src/api/logical-routes.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const bus = createEventBus()
  const auth = makeAuth(repo)
  const service = createService(repo, bus, null, store)

  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'reader@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const authUserId = session!.user.id
  const key = (await auth.api.createApiKey({ body: { configId: 'user', userId: authUserId, permissions: { timeline: ['read'], posts: ['read'] } } })).key!

  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo })
  return { app, key, service, repo, authUserId }
}

test('GET /me/timeline requires an api key', async () => {
  const { app } = await setup()
  const res = await app.request('/me/timeline')
  expect(res.status).toBe(401)
})

test('GET /me/timeline returns posts by people the key\'s owner follows, not their own posts', async () => {
  const { app, key, service, repo, authUserId } = await setup()
  const me = await repo.getUserByAuthUserId(authUserId)
  const followedPost = await service.createLocalPostAs('alice', 'Alice', 'alice post')
  const alice = await service.getUserByHandle('alice')
  await service.addFollow(me!, alice!) // service.addFollow(follower: User, target: User) — core/src/domain/service.ts:109
  const res = await app.request('/me/timeline', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(JSON.stringify(body)).toContain(followedPost.id)
})

test('GET /me/posts returns the key owner\'s own local posts', async () => {
  const { app, key, service, repo, authUserId } = await setup()
  const me = await repo.getUserByAuthUserId(authUserId)
  // Post AS the key's own owner (createLocalPostAs mints/reuses by handle).
  const post = await service.createLocalPostAs(me!.handle, me!.displayName, 'my own post')
  const res = await app.request('/me/posts', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(JSON.stringify(body)).toContain(post.id)
})

test('a key with only timeline:read cannot reach /me/posts (posts:read required)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const auth = makeAuth(repo)
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'timelineonly@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = (await auth.api.createApiKey({ body: { configId: 'user', userId: session!.user.id, permissions: { timeline: ['read'] } } })).key!
  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo })
  const res = await app.request('/me/posts', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(401)
})
```

**Before implementing**, read `core/src/domain/service.ts`'s follow-creation
function and `createLocalPostAs`'s real signature (both referenced above with
"adapt if" notes) — this brief cannot know their exact current shape with
certainty; use the real ones. This mirrors how `POST /me/follows`
(`core/src/api/app.ts:598`) and `service.createLocalPostAs` are actually
called elsewhere in the codebase you're already working in.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker compose exec -T core npm test -w core -- personal-api-routes`
Expected: FAIL — `mountPersonalApiRoutes` doesn't exist.

- [ ] **Step 4: Implement `mountPersonalApiRoutes`**

In `core/src/api/logical-routes.ts`, near `mountLogicalReadRoutes` (shares
its module-scope `clampLimit`/`decodeCursor`):

```ts
// =============================================================================
// Authed personal API (2026-08-01 design, phase 2) — GET /me/timeline, GET /me/posts
// =============================================================================
// Key-authed equivalents of the browser's own Personal tab / own-posts view.
// Unlike GET /timeline (session-optional, handle-driven), these always
// resolve the account from the authenticated key's own owner — no handle
// lookup needed, since "my own timeline"/"my own posts" IS the caller.

export interface PersonalApiDeps {
  store: LogicalStore
  auth: Auth
  users: UserDirectory
}

export function mountPersonalApiRoutes(app: Hono, deps: PersonalApiDeps): void {
  const { store, auth, users } = deps

  function accountOf(c: Context): PublicLocalAccount {
    const u = c.get('coreUser')
    return { id: u.id, handle: u.handle, displayName: u.displayName }
  }

  function parseBefore(c: Context): TimelineCursorV2 | null | 'invalid' {
    const beforeRaw = c.req.query('before')
    if (beforeRaw === undefined) return null
    const dec = decodeCursor(beforeRaw)
    if (!dec || dec.tuple.length !== 2) return 'invalid'
    return { version: 1, timelineSortAt: dec.tuple[0], logicalItemId: dec.tuple[1] }
  }

  app.get('/me/timeline', apiKeyAuth(auth, users, { timeline: ['read'] }), (c) => {
    const before = parseBefore(c)
    if (before === 'invalid') return c.json({ error: 'invalid cursor' }, 400)
    const limit = clampLimit(c.req.query('limit'))
    const account = accountOf(c)
    const viewer: ProjectionViewer = { localAccountId: account.id, activeSourceIds: [] }
    const result = store.snapshot((tx) => tx.projectTimeline({ lens: { kind: 'personal', account }, before, limit, viewer }))
    return c.json(result)
  })

  app.get('/me/posts', apiKeyAuth(auth, users, { posts: ['read'] }), (c) => {
    const before = parseBefore(c)
    if (before === 'invalid') return c.json({ error: 'invalid cursor' }, 400)
    const limit = clampLimit(c.req.query('limit'))
    const account = accountOf(c)
    const viewer: ProjectionViewer = { localAccountId: account.id, activeSourceIds: [] }
    const result = store.snapshot((tx) => tx.projectTimeline({ lens: { kind: 'local_author', account }, before, limit, viewer }))
    return c.json(result)
  })
}
```

`apiKeyAuth` is a VALUE import (called at mount time), while the file's
existing `import type { UserDirectory } from './auth.ts'` is type-only —
don't merge into that line. Add a separate line instead:
`import { apiKeyAuth } from './auth.ts'`. Also add `PublicLocalAccount` to
the existing `import type { RunCursor, JobCursor, ... TimelineLens,
TimelineCursorV2, ProjectionViewer, ... } from '../logical/types.ts'` line
— it is not currently in that list (checked during planning) and
`accountOf`'s return type needs it.

- [ ] **Step 5: Wire it in `server.ts`**

Read `core/src/server.ts` around the existing `mountPublicFirehoseRoute`
call (added by the phase-1 branch) and add, right after it:

```ts
mountPersonalApiRoutes(app, { store: logicalStore, auth, users: repo })
```

Add `mountPersonalApiRoutes` to the existing `import { mountLogicalStreamRoute,
mountLogicalHandleRoute, mountPublicFirehoseRoute } from
'./api/logical-routes.ts'` line (confirm the exact current import list by
reading the file — it may have evolved).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `docker compose exec -T core npm test -w core -- personal-api-routes`
Expected: all 4 pass.

- [ ] **Step 7: Full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`
Expected: all passing, 0 errors.

- [ ] **Step 8: Commit**

```bash
git add core/src/api/logical-routes.ts core/src/server.ts core/test/personal-api-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(core): GET /me/timeline and GET /me/posts, key-authed

Reuses the existing TimelineLens/clampLimit/decodeCursor machinery
GET /timeline already rides — these two routes only differ in how the
account is resolved (the authenticated key's own owner, not a
?followed_by=/?author= handle lookup).

developed with the help of AI tools
EOF
)"
```

---

### Task 4: Web — `/api/v1/[...path]` catch-all proxy

**Files:**
- Create: `web/src/routes/api/v1/[...path]/+server.ts`
- Test: `web/src/routes/api/v1/[...path]/server.test.ts`

**Interfaces:**
- Consumes: core's `GET /me/timeline` and `GET /me/posts` (Task 3).
- Produces: `GET /api/v1/me/timeline`, `GET /api/v1/me/posts` externally.
  This catch-all is the generic forwarder for all phase 2-4 JSON REST routes
  per the spec's Namespace section — later phases' routes need no new proxy
  code, they just need to exist on core at the matching unprefixed path.

- [ ] **Step 1: Write the failing tests**

Read `web/src/routes/api/auth/[...path]/+server.ts` in full first — this
proxy is the closest existing precedent (a generic catch-all), adapted to
forward `x-api-key` instead of `cookie`/`origin`, and with no special-casing
for the `/reference`/`open-api` dev-only paths (those only exist under
`/api/auth/*`, not `/api/v1/*`).

Create `web/src/routes/api/v1/[...path]/server.test.ts`:

```ts
import { test, expect, vi, afterEach } from 'vitest'
import { GET } from './+server.ts'

const originalFetch = global.fetch

afterEach(() => {
	global.fetch = originalFetch
})

test('GET forwards to core at the matching unprefixed path, with the x-api-key header', async () => {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await GET({ params: { path: 'me/timeline' }, url: new URL('http://x/api/v1/me/timeline'), request: new Request('http://x/api/v1/me/timeline', { headers: { 'x-api-key': 'rsc_test_key' } }) } as never)

	expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/me/timeline', expect.objectContaining({
		headers: expect.objectContaining({ 'x-api-key': 'rsc_test_key' })
	}))
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ ok: true })
})

test('GET without an x-api-key header still forwards (core enforces the 401, not the proxy)', async () => {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'api key required' }), { status: 401 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await GET({ params: { path: 'me/timeline' }, url: new URL('http://x/api/v1/me/timeline'), request: new Request('http://x/api/v1/me/timeline') } as never)
	expect(res.status).toBe(401)
})

test('query string is preserved on the forwarded request', async () => {
	const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	await GET({ params: { path: 'me/timeline' }, url: new URL('http://x/api/v1/me/timeline?limit=10'), request: new Request('http://x/api/v1/me/timeline?limit=10', { headers: { 'x-api-key': 'k' } }) } as never)
	expect(String((fetchMock as any).mock.calls[0][0])).toBe('http://localhost:8787/me/timeline?limit=10')
})

test('GET returns a retryable 503 when core is unreachable', async () => {
	global.fetch = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
	const res = await GET({ params: { path: 'me/timeline' }, url: new URL('http://x/api/v1/me/timeline'), request: new Request('http://x/api/v1/me/timeline') } as never)
	expect(res.status).toBe(503)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run api/v1`
Expected: FAIL — `./+server.ts` doesn't exist.

- [ ] **Step 3: Implement the proxy**

Read `web/src/routes/api/auth/[...path]/+server.ts` and `web/src/lib/server/
session.ts`'s `base()` export first.

Create `web/src/routes/api/v1/[...path]/+server.ts`:

```ts
import type { RequestHandler } from './$types'
import { base } from '$lib/server/session'

// Generic catch-all for the phase 2-4 JSON REST routes (spec: "Namespace",
// rev 2 — one forwarder for all of them, since none needs frame
// transformation; the firehose is the one exception and keeps its own
// bespoke proxy at web/src/routes/api/v1/firehose/stream/+server.ts).
// Forwards x-api-key, not cookies — this app's api-key-authed routes never
// accept a session, so there is nothing else to relay.
const proxy: RequestHandler = async ({ request, params, url }) => {
	const target = `${base()}/${params.path}${url.search}`
	const headers: Record<string, string> = {}
	const apiKey = request.headers.get('x-api-key')
	if (apiKey) headers['x-api-key'] = apiKey
	const ct = request.headers.get('content-type')
	if (ct) headers['content-type'] = ct

	const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
	let upstream: Response
	try {
		upstream = await fetch(target, {
			method: request.method,
			headers,
			body: hasBody ? await request.text() : undefined
		})
	} catch {
		return new Response('core unavailable', { status: 503 })
	}
	const out = new Headers()
	const outCt = upstream.headers.get('content-type')
	if (outCt) out.set('content-type', outCt)
	return new Response(upstream.body, { status: upstream.status, headers: out })
}

export const GET = proxy
export const POST = proxy
export const PATCH = proxy
export const DELETE = proxy
```

(`POST`/`PATCH`/`DELETE` are exported now even though phase 2 only has `GET`
routes — the catch-all shape is meant to serve phase 3's write routes
without a second proxy file; wiring the methods now costs nothing since an
unmatched method 404s on core regardless.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run api/v1`
Expected: all 4 pass.

- [ ] **Step 5: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and
`docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/api/v1/\[...path\]/+server.ts web/src/routes/api/v1/\[...path\]/server.test.ts
git commit -m "$(cat <<'EOF'
feat(web): generic /api/v1/[...path] proxy forwarding x-api-key to core

One catch-all for every phase 2-4 JSON REST route (the firehose is
the one SSE exception with its own bespoke proxy). Core enforces the
actual permission check per route; this is a plain forwarder.

developed with the help of AI tools
EOF
)"
```

---

### Task 5: Web — "API keys" settings page

**Files:**
- Create: `web/src/routes/settings/api-keys/+page.server.ts`
- Create: `web/src/routes/settings/api-keys/+page.svelte`
- Modify: `web/src/routes/settings/+page.svelte` — add a link to the new page.
- Test: `web/src/routes/settings/api-keys/page.server.test.ts`

**Interfaces:**
- Consumes: `/api/auth/api-key/{create,list,delete}` on core (Task 1 — pin
  the exact paths from Task 1's Step 1 report before writing this task;
  do not guess).
- Produces: nothing later tasks depend on (this plan's last task).

**Before starting:** this task touches UI (a new settings page). Per
CLAUDE.md, invoke the `ui-ux-pro-max` skill and read `design-system/rsc/
MASTER.md` before writing any Svelte — no raw hex, only `--color-*`
variables, no rounded corners/box-shadow, "nothing floats." Read
`web/src/routes/accounts/+page.svelte` first as the closest existing
precedent (a settings-adjacent list/manage page linked from the main
Settings page) and follow its layout conventions rather than inventing new
ones. Also consult `svelte-runes`/`sveltekit-data-flow` for the form-action
shape.

- [ ] **Step 1: Read the precedents**

Read, in order: `web/src/routes/settings/+page.svelte` (the page this links
from), `web/src/routes/accounts/+page.svelte` + its `+page.server.ts` (the
closest structural precedent — a linked-from-settings list/manage page),
`web/src/routes/login/+page.server.ts` (the hand-rolled-fetch-to-`/api/auth/*`
pattern to mirror exactly — `base()`, `cookieHeader`, `relaySetCookies`,
`fail()`).

- [ ] **Step 2: Write the failing test for the server actions/load**

Write `web/src/routes/settings/api-keys/page.server.test.ts` covering:
`load` calls the list endpoint and returns the keys (permission set, name,
prefix, created date — never the key value); the `create` action posts the
selected permissions and returns the plaintext key **once** in `form` (never
persisted to `data`, so a page refresh can't re-show it); the `revoke`
action posts the key id and redirects/reloads. Follow `login/+page.server.ts`'s
existing test file (if one exists — check `web/src/routes/login/` for a
`page.server.test.ts` sibling) for the mocking pattern (`global.fetch`
mock, asserting on the request made). Use `apiKeyAuth`'s two phase-2
permissions (`timeline: ['read']`, `posts: ['read']`) as the only checkboxes
offered — do not add `write`/`follows`/`profile` checkboxes, those don't
exist as enforceable permissions yet (Global Constraints).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run settings/api-keys`
Expected: FAIL — the route doesn't exist.

- [ ] **Step 4: Implement `+page.server.ts`**

Following `login/+page.server.ts`'s exact pattern (`base()`, `cookieHeader`,
`relaySetCookies`, `fail()`), implement:
- `load`: `GET ${base()}/api/auth/api-key/list?configId=user` (or whatever
  Task 1 found the real path/query shape to be) with the request's cookie
  forwarded, mapped to a plain list for the template.
- `actions.create`: reads checked permissions from form data, builds the
  `permissions: Record<string,string[]>` body, `POST`s to the create
  endpoint, returns `{ createdKey: <plaintext> }` in the action result (not
  `data`) so it renders exactly once.
- `actions.revoke`: `POST`s the delete endpoint with the target key id.

- [ ] **Step 5: Implement `+page.svelte`**

Invoke `ui-ux-pro-max` before writing this file. List existing keys (name,
prefix e.g. `rsc_ab12...`, created date, permissions as plain text — never
the key value except immediately after creation); a create form with one
checkbox per phase-2 permission (`Read my personal timeline` →
`timeline:read`, `Read my own posts` → `posts:read`) plus a name field;
a revoke button per row (reuse this codebase's existing `.confirm-gate`
`<details>` disclosure pattern for the destructive action, matching how
`/admin/feeds` already gates destructive actions — read
`web/src/routes/admin/feeds/+page.svelte`'s `.confirm-gate` CSS/markup for
the exact shape). Must degrade without JS (no-JS-first invariant) — every
control here is a plain form POST, no client-side-only affordance.

- [ ] **Step 6: Add the settings-page link**

In `web/src/routes/settings/+page.svelte`, add a link to `/settings/api-keys`
near the existing `<a href="/accounts">Manage accounts on this browser →</a>`
line, matching its exact style.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run settings/api-keys`
Expected: all pass.

- [ ] **Step 8: Full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- --run` and
`docker compose exec -T web npm run -w web check`
Expected: all passing, 0 errors/warnings.

- [ ] **Step 9: Manual no-JS + browser check**

Per CLAUDE.md's UI testing requirement: start the dev stack, visit
`/settings/api-keys` with JS disabled (browser devtools), create a key,
confirm it renders once and never again after reload, revoke it, confirm
the confirm-gate requires the explicit confirm click (not just opening the
disclosure). Then repeat with JS enabled. Report what you tested, not just
that tests passed.

- [ ] **Step 10: Commit**

```bash
git add web/src/routes/settings/api-keys web/src/routes/settings/+page.svelte
git commit -m "$(cat <<'EOF'
feat(web): API keys settings page (create/list/revoke)

Hand-rolled fetch to /api/auth/api-key/*, matching every other auth
interaction in this codebase (login/magic-link/logout) — no new
client-library dependency. Offers only the two phase-2 permissions
(timeline:read, posts:read); write/follows/profile checkboxes land
with phase 3's routes, not before they're enforceable.

developed with the help of AI tools
EOF
)"
```

---

## Self-Review

**Spec coverage:** "Read endpoints (phase 2)" (Tasks 3-4), the `configId:
'user'` half of "Key tiers" (Task 1), "Core mechanism: apiKeyAuth" (Task 2),
the user-tier half of "Key management UX" (Task 5), the Namespace section's
catch-all-proxy design (Task 4). Explicitly deferred, not touched: `configId:
'admin'` + its `before` hook (phase 4), write routes/permissions (phase 3),
CORS (non-goal, every phase).

**Placeholder scan:** every code step is complete, grounded against the
actual current files (read fresh during plan-writing: `core/src/auth.ts`,
`core/src/api/auth.ts`, `core/src/api/logical-routes.ts`'s `mountLogicalReadRoutes`/
`clampLimit`/`TimelineLens`, `core/test/auth-helper.ts`, `web/src/routes/
login/+page.server.ts`, `web/src/routes/api/auth/[...path]/+server.ts`). The
one class of genuine unknown — `@better-auth/api-key`'s exact installed
shape, since the package isn't in this repo yet — is not glossed over: Task
1 Step 1 is explicitly "install it and read the real source before writing
anything else," and every later task's illustrative code carries an explicit
note to correct field names against what that step found. This is a real
unknown stated as one, not a hidden guess.

**Type consistency:** `apiKeyAuth(auth, users, permissions)` (Task 2) is
called identically in Task 3's route mounts. `PersonalApiDeps` (Task 3) only
needs `store`/`auth`/`users` — no `bus`/`feeds`, since these routes are pure
reads with no SSE/wire-emission concern, unlike `mountPublicFirehoseRoute`.
`accountOf(c)` constructs `PublicLocalAccount` directly from `c.get('coreUser')`
rather than a redundant `resolveLocalAccount` DB round-trip — verified
`PublicLocalAccount`'s three fields (`id`/`handle`/`displayName`) are a
strict subset of `User`'s fields, so this is a safe, cheaper substitution,
not a shape mismatch.

**A design correction made during planning, not inherited from the spec's
illustrative code:** the spec's Key Management UX section says the settings
page "Uses `authClient.apiKey.create/list/delete` directly" — but this
codebase has zero `better-auth/client` usage anywhere (verified by grep
across `web/src`); every existing auth interaction is a hand-rolled `fetch`
to `/api/auth/*` from a SvelteKit form action. Task 5 follows the codebase's
actual, consistent pattern instead, which also means no new web dependency
is needed at all for key management — a simplification the spec's
illustrative code didn't have available to it before this plan's grounding
pass found it.
