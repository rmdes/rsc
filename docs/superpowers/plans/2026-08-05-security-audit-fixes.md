# Security audit fixes (M1, M2, M4, M5, L1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 findings from an adversarial security audit of the external-API
surface (public firehose, authed read/write, admin tier — all 4 phases,
already live on 5 Cloudron instances): both web proxies' security guards are
bypassable with a bare `//` in the path (M1, M2); api-key rate limiting is
per-key and keys are free/uncapped, so a user can cycle keys to bypass the
300/hr ceiling (M4); the public firehose has a concurrency cap but no
connection-*rate* limit, so an attacker can churn reconnects each triggering
a full journal-drain pump (M5); and one admin page's comment falsely claims
the layout gate protects its form actions, when SvelteKit runs actions
before layout `load` (L1) — not exploitable (core's own `/admin/*` gate is
the real, working boundary), but worth correcting the comment and adding
real per-action guards as defense-in-depth across every admin action file
that has the same gap. A 5th finding (M3, an SSRF gap for
`100.64.0.0/10`/Tailscale-range addresses) was explicitly ruled out of scope
by the maintainer — none of the 5 deployed instances are Tailscale-connected.

**Architecture:** Four independent, small, precisely-grounded fixes. No new
routes, no new dependencies, no schema changes. Every finding's exact
mechanism was confirmed against the real, current code and (for M1/M2) the
installed Hono router's actual matching behavior before this plan was
written — see each task's Global Constraint / verification note.

**Tech Stack:** Hono, SvelteKit, `@better-auth/api-key` (no version change).

## Global Constraints

- **M1/M2's root cause, verified against the real files (not paraphrased):**
  both `web/src/routes/api/v1/[...path]/+server.ts` and `web/src/routes/api/
  auth/[...path]/+server.ts` build `target` from an absolute URL string (the
  correct fix from an earlier `..%2f` incident) and match their security
  guard against `target.pathname` (also correct — the earlier fix's whole
  point was matching the RESOLVED path, not the raw segment). But neither
  guard normalizes repeated slashes first: a request path containing `//`
  (e.g. `/api/v1//api/auth/reference`) produces a `target.pathname` of
  `//api/auth/reference`, which does not match a `startsWith('/api/')` or
  `=== '/api/auth/reference'` check. Confirmed during the audit that this
  is NOT currently exploitable (Hono's router does not collapse `//` either,
  so core itself 404s a `//`-prefixed path today) — but the guards
  themselves don't hold the property CLAUDE.md claims for them ("load-bearing
  ... keep both"), and that's the assumption a future change would trust.
  Fix is a one-line normalization before each guard check, not a rewrite.
- **M4's real mechanism, verified against the installed `@better-auth/
  api-key` source during the audit**: the plugin's rate limit (300 req/hr)
  is stored and evaluated per KEY ROW (`rateLimitMax`/`rateLimitTimeWindow`
  columns, `evaluateRateLimit`), not per user. There is no cap anywhere on
  how many keys a single `referenceId` can hold — grepped the plugin source
  for `maximumApiKeys`/similar; none exists — and `POST /me/api-keys` /
  `POST /admin/api-keys` (this app's own in-process issuance routes,
  `core/src/api/logical-routes.ts`) don't check either. A user can therefore
  mint unlimited keys, each with its own fresh 300/hr budget — the per-key
  limit is decorative against a scripted caller. The `apikey` table's
  `referenceId`/`configId` columns are both already indexed
  (`core/src/storage/sqlite.ts:1475-1477`), so a `COUNT(*)` cap-check is a
  cheap, indexed query.
- **M5's real mechanism**: `mountPublicFirehoseRoute`
  (`core/src/api/logical-routes.ts:1198-1318`) already has two in-memory
  counters — `ipCounts` (concurrent connections per IP, capped at
  `maxConnectionsPerIp`) and `totalConnections` (global concurrency cap).
  Both are CONCURRENCY gauges (incremented on connect, decremented on
  disconnect) — neither tracks connection RATE (attempts per time window).
  An attacker can open and immediately close connections in a tight loop,
  each one triggering the full journal-replay `pump()` before releasing,
  without ever exceeding the concurrency cap. Fix is additive: a third,
  separate fixed-window counter per IP on connection ATTEMPTS, following the
  exact same "ponytail: single-process in-memory counter, reset on deploy"
  convention the existing two counters already use in this same function —
  do not replace or change the existing concurrency caps, only add the new
  rate check alongside them.
- **L1's real scope, corrected from the audit's initial framing**: the audit
  flagged `web/src/routes/admin/api-keys/+page.server.ts`'s comment as
  factually wrong (SvelteKit runs form actions BEFORE layout `load`, so the
  admin layout's `if (!me?.isAdmin) throw error(404)` does NOT protect this
  page's actions). Re-checked during planning: `web/src/routes/settings/
  api-keys/+page.server.ts` — the file this plan's Task 1 briefs cite as the
  pattern to mirror — has the SAME gap in its own actions (its `guard()` is
  called only in `load`, never in `create`/`revoke`), and its own comments
  already frame this honestly: "Core's own 403 ... is the real boundary;
  this is only so a guest never sees the form." **This is this codebase's
  existing, deliberate, already-accepted pattern** (core enforces, the
  SvelteKit-layer check is cosmetic-only, UX not security) — NOT a novel gap
  invented by the admin work. The fix here is therefore two things, not one:
  (a) correct the admin page's comment to state the same honest thing
  `settings/api-keys` already states (core is the real boundary), and
  (b) as defense-in-depth beyond what the existing convention requires,
  add an explicit per-action admin check to every admin `+page.server.ts`
  that has actions (6 files total — `feeds`, `users`, `items/[id]`,
  `settings`, `api-keys`, `sources/[sourceId]`), closing "a future core
  refactor silently opens this" risk even though nothing is exploitable
  today. This is the maintainer's explicit call (fix everything the audit
  flagged as "worth fixing"), applied consistently across all 6 files
  rather than just the one the audit's code sample showed.
- **No `event.locals` session pre-resolution exists in this app**
  (`web/src/hooks.server.ts` does not exist) — an admin check inside an
  action has to redo the same `getMe(authedFetch(...))` round-trip the root
  layout's own `load` already does, using `$lib/api`'s `getMe` and
  `$lib/server/session`'s `authedFetch`/`cookieHeader` (already imported by
  several of these files) — not a new session-reading mechanism.
- **`core/src` runs on Node native type-stripping**: no TypeScript
  parameter properties, no build step.
- **Hono house style**: hand-rolled validation, `c.json({error}, status)`,
  not `HTTPException`.
- **Never write library calls from memory**: re-confirm any better-auth/
  Hono behavior claim against the installed source at implementation time,
  per CLAUDE.md — this plan's claims were verified during the audit and
  this planning pass, but versions can drift.

---

### Task 1: Fix M1 + M2 — normalize `//` before matching in both proxy guards

**Files:**
- Modify: `web/src/routes/api/v1/[...path]/+server.ts`
- Modify: `web/src/routes/api/auth/[...path]/+server.ts`
- Test: `web/src/routes/api/v1/[...path]/server.test.ts` (extend, if it
  exists — check the real filename fresh, this proxy may have its test file
  under a different exact name)
- Test: `web/src/routes/api/auth/[...path]/server.test.ts` (extend)

**Interfaces:** None — pure bugfix inside two existing request handlers, no
signature changes.

- [ ] **Step 1: Write the failing tests**

Read both existing test files fresh first (there is already a traversal
test suite for both proxies from the earlier `..%2f` fix — match its exact
style, helpers, and mocking approach). Add, to the v1 proxy's test file:

```ts
test('a leading-slash path does not bypass the /api/ guard', async () => {
	const fetchMock = vi.fn(async () => new Response('should not be reached', { status: 200 }))
	// Mirror this file's existing traversal test's setup exactly — same
	// `base()`/fetch-mock/params-construction pattern already used above.
	const res = await GET({
		request: new Request('http://localhost/api/v1//api/auth/reference'),
		params: { path: '/api/auth/reference' }, // SvelteKit hands the decoded, slash-containing segment through
		url: new URL('http://localhost/api/v1//api/auth/reference')
	} as never)
	expect(res.status).toBe(404)
	expect(fetchMock).not.toHaveBeenCalled()
})
```

And to the auth proxy's test file:

```ts
test('a leading-slash path does not bypass the reference/open-api guard', async () => {
	const res = await GET({
		request: new Request('http://localhost/api/auth//reference'),
		params: { path: '/reference' },
		url: new URL('http://localhost/api/auth//reference'),
		cookies: { getAll: () => [] },
		getClientAddress: () => '127.0.0.1'
	} as never)
	expect(res.status).toBe(404)
})
```

(Both are illustrative of intent — this file's own existing traversal tests
already have the correct exact mocking/event-construction pattern for this
codebase's real `RequestHandler` signature; read them fresh and match that
pattern exactly rather than the sketch above, which may not compile as-is.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- \[...path\]`
Expected: FAIL — both new tests currently get a 200 (or whatever the mock
fetch returns), not 404.

- [ ] **Step 3: Fix both guards**

In `web/src/routes/api/v1/[...path]/+server.ts`, normalize `target.pathname`
once and reuse it for both the guard check and (no other use exists) — the
minimal fix is normalizing only for the check:

```ts
	const target = new URL(`${base()}/${params.path}${url.search}`)
	const normalizedPath = target.pathname.replace(/\/{2,}/g, '/')
	if (normalizedPath.startsWith('/api/')) return new Response(null, { status: 404 })
```

In `web/src/routes/api/auth/[...path]/+server.ts`, same normalization
applied to its three-way guard:

```ts
	const target = new URL(`${base()}/api/auth/${params.path}${url.search}`)
	const normalizedPath = target.pathname.replace(/\/{2,}/g, '/')
	if (
		!normalizedPath.startsWith('/api/auth/') ||
		normalizedPath === '/api/auth/reference' ||
		normalizedPath.startsWith('/api/auth/open-api')
	) {
		return new Response(null, { status: 404 })
	}
```

Do NOT change what's actually fetched (`target.href` stays as-is in both
files) — only the GUARD CHECK uses the normalized value. Collapsing
`target.pathname` itself before building `target.href` would change what
core actually receives, which is out of scope for this fix and could have
other effects; the guard is the only thing that needs the normalized view.

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- \[...path\]`

- [ ] **Step 5: Run the full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web` and
`docker compose exec -T web npm run check -w web`

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/api/v1/\[...path\]/+server.ts web/src/routes/api/v1/\[...path\]/*.test.ts web/src/routes/api/auth/\[...path\]/+server.ts web/src/routes/api/auth/\[...path\]/*.test.ts
git commit -m "$(cat <<'EOF'
fix(web): normalize repeated slashes before matching both proxy guards

Both catch-all proxies' security guards (the /api/ prefix block on the v1
proxy, the reference/open-api block on the auth proxy) matched against
target.pathname without collapsing repeated slashes first, so a path
like /api/v1//api/auth/reference produced //api/auth/reference, which
doesn't match a startsWith('/api/') or === '/api/auth/reference' check.
Not currently exploitable (Hono's router doesn't collapse // either, so
core 404s a //-prefixed path on its own) but the guards themselves don't
hold the property CLAUDE.md claims for them. One-line normalization
before each check; what's actually fetched is unchanged.

developed with the help of AI tools
EOF
)"
```

---

### Task 2: Fix M4 — cap self-serve api keys per user

**Files:**
- Modify: `core/src/api/auth.ts` (extend `UserDirectory`)
- Modify: `core/src/storage/sqlite.ts` (implement the new count method)
- Modify: `core/src/api/logical-routes.ts` (enforce the cap in
  `POST /me/api-keys` and `POST /admin/api-keys`)
- Test: `core/test/api-key-cap.test.ts` (new)

**Interfaces:**
- Produces: `UserDirectory` gains `countApiKeys(authUserId: string, configId:
  string): Promise<number>`.

- [ ] **Step 1: Write the failing test**

```ts
// core/test/api-key-cap.test.ts
import { test, expect } from 'vitest'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { mountPersonalApiRoutes, mountAdminApiRoutes } from '../src/api/logical-routes.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'

async function setup(adminEmails: ReadonlySet<string> = new Set(['admin@x.test'])) {
	const repo = await createSqliteRepository(':memory:')
	const db = createDatabaseContext(repo.raw)
	const store = createLogicalStore(db)
	const bus = createEventBus()
	const auth = makeAuth(repo, adminEmails)
	const service = createService(repo, bus, null, store)
	const sourceService = createSourceService(repo, null)

	const authApp = new Hono()
	authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
	const cookie = await registeredSession(authApp, 'capped@x.test', repo)

	const app = new Hono()
	mountPersonalApiRoutes(app, { store, auth, users: repo, service, sourceService })
	mountAdminApiRoutes(app, {
		auth, users: repo, adminEmails, service, sourceRepo: repo, sourceService,
		logicalStore: store, feeds: { publicUrl: null, hubUrl: null, rssCloud: false },
		websubMode: 'off', pushInEnabled: false, mailEnabled: true, pollSeconds: 60
	})
	return { app, cookie, auth }
}

test('POST /me/api-keys refuses past a per-user cap', async () => {
	const { app, cookie } = await setup()
	// Mint up to the cap.
	for (let i = 0; i < 10; i++) {
		const res = await app.request('/me/api-keys', {
			method: 'POST', headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ name: `k${i}`, permissions: { 'timeline': ['read'] } })
		})
		expect(res.status).toBe(201)
	}
	const overCap = await app.request('/me/api-keys', {
		method: 'POST', headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify({ name: 'k11', permissions: { 'timeline': ['read'] } })
	})
	expect(overCap.status).toBe(429)
})
```

(This test's exact `setup()` shape is illustrative — read `core/test/
admin-api-routes.test.ts`'s own `setup()` fresh, which already wires
identical dependencies for both `mountPersonalApiRoutes` and
`mountAdminApiRoutes`, and reuse its real helper signatures rather than the
sketch above.)

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T core npm test -w core -- api-key-cap`
Expected: FAIL — the 11th key currently succeeds (201), not 429.

- [ ] **Step 3: Add `countApiKeys` to `UserDirectory` + `SqliteRepository`**

In `core/src/api/auth.ts`:

```ts
export interface UserDirectory {
  getUserByAuthUserId(authUserId: string): Promise<User | undefined>
  createLocalUser(u: { handle: string; displayName: string; authUserId?: string }): Promise<User>
  getAuthUserAdminFields(authUserId: string): Promise<{ email: string | null; emailVerified: boolean | null } | undefined>
  countApiKeys(authUserId: string, configId: string): Promise<number>
}
```

In `core/src/storage/sqlite.ts`, near `getAuthUserAdminFields`:

```ts
  async countApiKeys(authUserId: string, configId: string): Promise<number> {
    const row = this.raw.prepare(`SELECT COUNT(*) AS n FROM apikey WHERE referenceId = ? AND configId = ?`).get(authUserId, configId) as { n: number }
    return row.n
  }
```

- [ ] **Step 4: Enforce the cap in both issuance routes**

In `core/src/api/logical-routes.ts`, add a shared constant near
`ALLOWED_KEY_PERMISSIONS`:

```ts
// A generous ceiling, not a tight one — this exists to bound unbounded
// growth from a scripted rate-limit-bypass loop, not to constrain a real
// integration author who legitimately wants a handful of scoped keys.
const MAX_API_KEYS_PER_USER = 20
```

In `POST /me/api-keys`'s handler, after the existing `isString(body.name,
1, 32)`/`isValidKeyPermissions` checks and before the `createApiKey` call:

```ts
    if ((await users.countApiKeys(session.user.id, 'user')) >= MAX_API_KEYS_PER_USER) {
      return c.json({ error: 'api key limit reached' }, 429)
    }
```

In `POST /admin/api-keys`'s handler (`mountAdminApiRoutes`), same pattern
using `c.get('coreUser')`'s underlying auth id — read the route fresh to
confirm the exact variable holding the authUserId at that point (it's
whatever `apiKeyCreateApi.createApiKey`'s `userId` field already uses, one
line above where you're adding this check):

```ts
    if ((await users.countApiKeys(<the same authUserId already in scope>, 'admin')) >= MAX_API_KEYS_PER_USER) {
      return c.json({ error: 'api key limit reached' }, 429)
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker compose exec -T core npm test -w core -- api-key-cap`

- [ ] **Step 6: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`

- [ ] **Step 7: Commit**

```bash
git add core/src/api/auth.ts core/src/storage/sqlite.ts core/src/api/logical-routes.ts core/test/api-key-cap.test.ts
git commit -m "$(cat <<'EOF'
fix(core): cap self-serve api keys per user (both tiers)

The plugin's 300/hr rate limit is stored and evaluated per KEY ROW, not
per user, and nothing capped how many keys one referenceId could hold --
POST /me/api-keys and POST /admin/api-keys minted without limit, so a
scripted caller could cycle keys to get an effectively unbounded request
budget (N keys x 300/hr) and grow the apikey table without bound. Caps
both issuance routes at 20 keys per user per tier, an indexed COUNT(*)
query against the already-indexed referenceId/configId columns.

developed with the help of AI tools
EOF
)"
```

---

### Task 3: Fix M5 — per-IP connection-rate limit on the public firehose

**Files:**
- Modify: `core/src/api/logical-routes.ts`
- Test: `core/test/logical-firehose.test.ts` (extend — check the real
  existing firehose test file name fresh, may differ)

**Interfaces:** None — additive change inside `mountPublicFirehoseRoute`'s
existing closure state, no new exported types.

- [ ] **Step 1: Write the failing test**

Read the existing firehose test file fresh for its real helper names
(`mountPublicFirehoseRoute`'s deps, how a fake `source`/`bus` are
constructed for tests) before writing this — the shape below is
illustrative of intent, not literal:

```ts
test('rapid reconnects from one IP are rate-limited even though each connection releases quickly', async () => {
  // Construct the app the same way this file's existing tests do, with
  // maxConnectionsPerIp/maxConnectionsTotal left at generous defaults so
  // ONLY the new rate limiter is what triggers — a tight concurrency cap
  // would make this test ambiguous about which mechanism fired.
  const app = /* ...existing test setup... */
  const ip = '203.0.113.5'
  let sawRateLimited = false
  for (let i = 0; i < 20; i++) {
    const res = await app.request('/firehose/stream', { headers: { 'x-forwarded-for': ip } })
    // Each connection is opened and immediately aborted (matching the
    // audit's attack shape: connect, drain, disconnect, repeat) — check
    // this file's existing tests for the real pattern to abort a streamSSE
    // response in a test context.
    if (res.status === 429) { sawRateLimited = true; break }
  }
  expect(sawRateLimited).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T core npm test -w core -- logical-firehose`
(or whatever the real file is named) — expect FAIL, 20 rapid connections
from one IP currently all succeed since only concurrency is capped.

- [ ] **Step 3: Add the connection-rate limiter**

In `core/src/api/logical-routes.ts`, inside `mountPublicFirehoseRoute`,
alongside the existing `ipCounts`/`totalConnections` state (do not remove
or change those — this is additive):

```ts
  // Separate from ipCounts/totalConnections above (which bound CONCURRENT
  // connections): those alone don't stop an attacker who opens and closes
  // connections rapidly, each one still triggering a full journal-replay
  // pump before releasing. This bounds connection ATTEMPTS per IP over a
  // fixed window. ponytail: same single-process in-memory counter
  // convention as the two above — same accepted ceiling, same reset-on-
  // restart tradeoff.
  const connectionWindowMs = deps.connectionRateWindowMs ?? 60_000
  const maxConnectionsPerWindow = deps.maxConnectionsPerWindow ?? 20
  const connectionAttempts = new Map<string, { count: number; windowStart: number }>()
```

Add the two new fields to `PublicFirehoseDeps` (near `maxConnectionsPerIp`/
`maxConnectionsTotal`):

```ts
  connectionRateWindowMs?: number
  maxConnectionsPerWindow?: number
```

Inside the route handler, add the rate check BEFORE the existing
concurrency checks (reject cheaply before touching the concurrency
counters):

```ts
  app.get('/firehose/stream', (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    const now = Date.now()
    const attempt = connectionAttempts.get(ip)
    if (attempt && now - attempt.windowStart < connectionWindowMs) {
      if (attempt.count >= maxConnectionsPerWindow) return c.json({ error: 'too many connection attempts, slow down' }, 429)
      attempt.count++
    } else {
      connectionAttempts.set(ip, { count: 1, windowStart: now })
    }
    if (totalConnections >= maxGlobal) return c.json({ error: 'firehose at capacity' }, 429)
    // ...rest of the existing handler unchanged...
```

Read the exact current handler body fresh before inserting — this plan
shows where the new check goes, not a full replacement of the function.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -T core npm test -w core -- logical-firehose`

- [ ] **Step 5: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`

- [ ] **Step 6: Commit**

```bash
git add core/src/api/logical-routes.ts core/test/logical-firehose.test.ts
git commit -m "$(cat <<'EOF'
fix(core): rate-limit connection attempts on the public firehose

The existing ipCounts/totalConnections state bounds CONCURRENT
connections only -- an attacker opening and immediately closing
connections in a loop never exceeds that cap, but each connection still
triggers a full journal-replay pump before releasing. Adds a separate,
additive fixed-window counter on connection ATTEMPTS per IP, same
single-process in-memory-counter convention the two existing counters
already use in this function.

developed with the help of AI tools
EOF
)"
```

---

### Task 4: Fix L1 — correct the false comment, add per-action admin guards

**Files:**
- Modify: `web/src/routes/admin/api-keys/+page.server.ts`
- Modify: `web/src/routes/admin/feeds/+page.server.ts`
- Modify: `web/src/routes/admin/users/+page.server.ts`
- Modify: `web/src/routes/admin/items/[id]/+page.server.ts`
- Modify: `web/src/routes/admin/settings/+page.server.ts`
- Modify: `web/src/routes/admin/sources/[sourceId]/+page.server.ts`
- Test: extend each file's own existing `*.server.test.ts` (some of these 6
  routes may not have one yet — check fresh; if a file genuinely has none,
  a new one is in scope for this task, but confirm before assuming)

**Interfaces:** None — each file gets its own local guard function, no
shared module (matches this codebase's existing convention: `accounts/
+page.server.ts` and `settings/api-keys/+page.server.ts` both already
define their OWN local `guard()` rather than importing a shared one — stay
consistent with that, don't introduce a new shared lib module for this).

**Before touching any of these files**, per this repo's CLAUDE.md: any task
touching Svelte/UI code must invoke the `ui-ux-pro-max` skill first. This
task changes no visible UI/markup (server-side `+page.server.ts` logic
only, no `.svelte` files touched) — confirm that's still true once you've
read all 6 files, and if so, note in your report that the skill's UI-review
scope doesn't apply here rather than silently skipping the CLAUDE.md
instruction without checking.

- [ ] **Step 1: Fix the false comment in `admin/api-keys/+page.server.ts`**

Read the current comment fresh (near the top of the file, explaining why
there's no `guard()`/`hasSession()` call). Replace the FALSE claim ("the
layout's `if (!me?.isAdmin) throw error(404)` already keeps a non-admin ...
from ever reaching this page's load or actions") with the TRUE one, matching
`settings/api-keys/+page.server.ts`'s own honest framing of the identical
tradeoff:

```ts
// SvelteKit runs form actions BEFORE any layout load() (including this
// route's own admin/+layout.server.ts isAdmin check) — so, contrary to an
// earlier version of this comment, the layout gate does NOT protect these
// actions. Core's own `app.use('/admin/*', authed, requireAdmin())` gate
// (core/src/api/app.ts) is the REAL, load-bearing boundary — it runs on
// every request regardless of which SvelteKit lifecycle stage reached it.
// requireAdmin() below is defense-in-depth on top of that, matching the
// same honest split settings/api-keys/+page.server.ts already documents
// for its own guard() (SvelteKit-layer check = UX only, core = security).
```

- [ ] **Step 2: Add an explicit admin guard to all 6 files' actions**

In EACH of the 6 files, add (or reuse if a similar local helper already
exists in that specific file — check first, don't duplicate):

```ts
import { getMe } from '$lib/api'
import { authedFetch, cookieHeader } from '$lib/server/session'
// ...alongside whatever this file already imports; some of these 6 already
// import authedFetch/cookieHeader for their own load — reuse, don't
// re-import under a different local name.

async function requireAdmin(event: { fetch: typeof fetch; cookies: import('@sveltejs/kit').Cookies; url: URL }): Promise<void> {
	const me = await getMe(authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies)))
	if (!me?.isAdmin) throw error(404, 'Not found')
}
```

(`error` from `@sveltejs/kit` — confirm each file already imports it or add
it to the existing import line, don't add a duplicate import statement.)

Then, as the FIRST line of every exported action in all 6 files, add
`await requireAdmin(event)` — using whichever parameter name each file's
action destructures its event as (some may destructure `{ request, fetch,
cookies, url }` directly rather than naming the whole event `event`; adapt
the call to pass an object with the right shape from whatever's already
destructured, e.g. `await requireAdmin({ fetch, cookies, url })`, don't
force a signature change on the action's own destructuring).

Read each file's actual current action list fresh — do not assume all 6
have the same number/names of actions; add the guard call to EVERY action
in EVERY file, since a partial application would leave some actions
unprotected while looking done.

- [ ] **Step 3: Add or extend tests confirming a non-admin action attempt 404s**

For at least `admin/api-keys` (already has a `*.server.test.ts` per Task 1
of the earlier backlog-cleanup plan) and `admin/feeds` (check if a test file
exists), add a test that calls the `create` (or whichever) action with a
mocked `getMe` returning `{isAdmin: false}` (or no `me` at all) and asserts
the action throws/returns the 404, without needing to reach the real fetch
call the action would otherwise make. Match whichever mocking pattern this
codebase's existing `*.server.test.ts` files already use for `getMe`/
`authedFetch` (several of phases 2-4's server-test files already mock these
exact functions — reuse that pattern, don't invent a new one). If time
constrains full coverage across all 6, prioritize `admin/api-keys` (the
file the audit specifically flagged) and note in your report which of the
remaining 5 got test coverage vs. just the guard-call fix.

- [ ] **Step 4: Run the full web suite + typecheck**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web` and
`docker compose exec -T web npm run check -w web`

- [ ] **Step 5: Manual sanity check (not a full UI check — no markup changed)**

Confirm the admin panel still loads and at least one action (e.g. revoking
a test api key, or pausing a test source) still works end-to-end as an
admin, via this worktree's running dev stack — a quick regression check
that adding the guard call didn't break the legitimate admin path, not a
full design-system review (no UI was touched).

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/admin/api-keys/+page.server.ts web/src/routes/admin/feeds/+page.server.ts web/src/routes/admin/users/+page.server.ts web/src/routes/admin/items/\[id\]/+page.server.ts web/src/routes/admin/settings/+page.server.ts web/src/routes/admin/sources/\[sourceId\]/+page.server.ts
git commit -m "$(cat <<'EOF'
fix(web): correct false admin-gate comment, add per-action admin guards

admin/api-keys/+page.server.ts's comment claimed the admin layout's
isAdmin check protects this page's form actions -- it doesn't (SvelteKit
runs actions before layout load). Not exploitable: core's own
app.use('/admin/*', authed, requireAdmin()) gate is the real, working
boundary and settings/api-keys/+page.server.ts already documents this
exact tradeoff honestly for its own guard(). Corrects the comment and, as
defense-in-depth against a future core refactor silently opening this,
adds an explicit per-action admin check to every admin action file (6
total), not just the one the audit's code sample happened to cite.

developed with the help of AI tools
EOF
)"
```

---

## Self-Review

**Spec coverage:** all 4 in-scope findings (M1, M2, M4, M5, L1 — M1/M2
share one task since they're the same bug class in two files) map to a
task. M3 (SSRF/Tailscale range) is explicitly excluded per the maintainer's
direct instruction ("none of the deployed are tailscale connected") — not a
gap, a scoping decision already made.

**Placeholder scan:** Tasks 1-3 have complete, real code for the actual
fix; their test bodies are marked illustrative where this codebase's real
existing test-file conventions (exact mock shapes, exact helper names)
need reading fresh rather than guessing — consistent with every other plan
in this project's history that touches an existing, established test file.
Task 4 is explicitly scoped to prioritize the one file the audit's code
sample cited if time is tight on full test coverage across 6 files, with
that tradeoff stated up front rather than silently short-changed.

**Type consistency:** `UserDirectory` gains one method (Task 2), consumed
only where it's added — no ripple. `PublicFirehoseDeps` gains two optional
fields with defaults (Task 3) — existing callers unaffected. Task 4
introduces one new local function per file (matching the established
per-file-local-guard convention), no shared interface.

**Risk framing, matching the audit's own verdict:** none of these four
findings are exploitable in the deployed system today (M1/M2 because Hono
doesn't collapse `//` either; M4 because it requires a registered account
plus a scripted loop to matter; M5 because it requires sustained targeted
abuse; L1 because core's own gate already holds). This plan fixes them
because they're cheap, correct, and close real "this breaks in a future
refactor" risk — not because the deployed instances are currently under
active exploitation. No urgency beyond normal review discipline.
