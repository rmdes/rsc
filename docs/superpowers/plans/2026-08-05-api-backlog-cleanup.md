# API track backlog cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pick up three well-scoped Minor findings left in `docs/superpowers/
ideas.md` from the external-API track's phase-3 final review: stale spec
URLs, api-key rate-limit exhaustion surfacing as a misleading 401 instead of
429, and one missing permission-isolation test. (A fourth finding —
idempotency for `POST /me/posts`/`POST /me/api-follows` — was scoped during
planning and turned out to need a real domain-service-layer change shared
with the cookie-authed routes; deferred to its own future design pass, not
in this plan. A fifth — the follow-unfollow cascade-delete side effect — was
downgraded from "fix" to "doc note," folded into Task 1.)

**Architecture:** No new routes, no new middleware, no new dependencies.
Task 1 is docs-only. Task 2 is a small, precisely-grounded fix to two
existing middleware functions (`apiKeyAuth`, `apiKeyAuthAdmin` in
`core/src/api/auth.ts`) — surfacing an error better-auth's own
`verifyApiKey` already returns but RSC's middleware currently discards.
Task 3 is one new test.

**Tech Stack:** Hono, `@better-auth/api-key` (already installed, no version
change).

## Global Constraints

- **The rate-limit fix's mechanism was verified against the installed
  source during planning, not assumed**: `core/node_modules/@better-auth/
  api-key/dist/index.mjs`'s `consumeRateLimit` (line ~1790) throws `new
  APIError('TOO_MANY_REQUESTS', { message: decision.message, code:
  'RATE_LIMITED', details: { tryAgainIn: decision.tryAgainIn } })` when the
  window is exceeded. `verifyApiKey`'s own endpoint handler (line ~1988)
  catches any `APIError` from `validateApiKey` and returns `ctx.json({
  valid: false, error: { ...error.body, message: error.body?.message, code:
  error.body?.code }, key: null })` — the specific code AND `details.
  tryAgainIn` survive into the JSON response. RSC's `apiKeyAuth`/
  `apiKeyAuthAdmin` (`core/src/api/auth.ts:98`, `:122`) currently do
  `if (!result.valid || !result.key) return c.json({ error: 'invalid or
  insufficient api key' }, 401)` — discarding `result.error` entirely
  regardless of why verification failed. The fix is local to these two
  functions; nothing in better-auth needs changing. Re-verify this against
  the installed source before implementing, not from this paraphrase —
  versions can drift.
- **The 429 response shape is decided here, not at implementation time**
  (rev 2 — a rev-1 draft deferred this across three separate sections; a
  ponytail-review pass correctly called that out as under-grounding, since
  the deciding fact — `result.error.code` — was already pinned two
  paragraphs above): `{ error: 'rate limit exceeded', code: 'RATE_LIMITED',
  tryAgainIn: result.error.details?.tryAgainIn }`, status `429`. The `code`
  field is what lets a client tell this apart from the two OTHER existing
  429 meanings (below) without parsing message text — matches this
  project's own stated house convention (`API.md`'s existing `401` row:
  "deliberately does not distinguish causes via message text").
- **429 already has two meanings before this fix adds a third** (rev 2 —
  a ponytail-audit pass found the un-widened case): `API.md`'s Errors table
  currently lists only "Subscription cap reached"
  (`core/src/api/logical-routes.ts:727`, `{error:'subscription limit
  reached'}`, no retry-after info — a durable state, retrying does nothing
  until the caller unsubscribes something) — but the firehose's per-IP
  connection cap (`core/src/api/logical-routes.ts:1226`/`:1228`, already
  shipped, phase 1) is ALSO a 429 and was never added to that table either.
  Task 1 Step 3 documents all three: subscription cap (durable, don't
  retry), firehose connection cap (durable per-IP, don't retry), rate limit
  (transient, retry after `tryAgainIn`) — the retry semantics genuinely
  differ per case, this is not manufactured precision.
- **`docs/superpowers/documentation/API.md`'s `### Rate limit` section
  already documents the intended 429 behavior** ("Exceeding it returns an
  error with a `tryAgainIn` value in milliseconds") — written aspirationally
  by a parallel session before this fix landed. Task 2 makes the code match
  that prose (now pinned exactly above); Task 1 only touches the separate
  Errors table.
- **The rate-limit test's per-key override mechanism is pinned here, not
  deferred** (rev 2 — both review passes independently found this in the
  same already-open file the rate-limit mechanism above came from, a few
  lines away: `createApiKeyBodySchema`, `core/node_modules/@better-auth/
  api-key/dist/index.mjs:590-592`, and the `createApiKey` handler,
  line ~828-833). `rateLimitMax`/`rateLimitTimeWindow`/`rateLimitEnabled`
  are accepted directly in `auth.api.createApiKey({body:{...}})` as
  server-only per-key overrides — mint a test key with `rateLimitMax: 2,
  rateLimitTimeWindow: 60_000` to exceed its window in 3 requests without
  waiting a real hour. Task 2's `ApiKeyCreation`-style local cast interface
  (mirror `core/test/personal-api-routes.test.ts:16-20`'s existing
  `mintKey`/`ApiKeyCreation` pattern) needs widening to accept these two
  fields in its `body` type.
- **`core/src` runs on Node native type-stripping**: no TypeScript
  parameter properties, no build step.
- **Hono house style**: hand-rolled validation, `c.json({error}, status)`,
  not `HTTPException`.
- **Never write library calls from memory**: re-confirm the exact
  `APIError`/`result.error` shape against the installed
  `@better-auth/api-key` source at implementation time, per CLAUDE.md.

---

### Task 1: Spec URL correction + follow-cascade doc note

**Files:**
- Modify: `docs/superpowers/specs/2026-08-01-external-api-and-firehose-design.md`
- Modify: `docs/superpowers/documentation/API.md`

**Interfaces:** None — pure documentation, no code/behavior change.

- [ ] **Step 1: Correct the spec's phase-3 "Write endpoints" section**

Read `docs/superpowers/specs/2026-08-01-external-api-and-firehose-design.md`
fresh (the "Write endpoints (phase 3)" section, roughly lines 236-251 as of
this plan's writing — confirm the real current line numbers) and its
existing "Revision history" section at the bottom for the exact rev-note
style already used elsewhere in this document (phase 3/4 already added
several rev notes — match that format, don't invent a new one).

Update the illustrative endpoint paths from the wrong `/api/v1/posts`,
`/api/v1/follows`, `/api/v1/me` to the real shipped paths: `/api/v1/me/
posts`, `/api/v1/me/api-follows`, `/api/v1/me/api-subscriptions`, `/api/v1/
me/api-profile` (the `/api/v1` prefix is added by the web proxy; the
core-side route registrations themselves are `/me/posts`, `/me/api-follows`,
etc. — be precise about which layer adds the prefix, matching how the
existing phase-2/3 sections of this same spec already describe the
prefix). Add a short rev note explaining why the paths differ from the
original illustrative ones (real method+path collisions with the
cookie-authed siblings, verified live during phase-3 planning — this
reasoning is already recorded in `docs/superpowers/plans/
2026-08-02-authed-write-api.md`'s naming-rationale section if you want the
original justification verbatim).

- [ ] **Step 2: Add a follows cascade-delete doc note to `API.md`**

Read `docs/superpowers/documentation/API.md`'s "Follows and subscriptions"
section (`### Follows and subscriptions`) fresh. Add a short note (2-3
sentences, matching this document's existing terse style) that unfollowing
a remote account/webfeed you're the last follower of triggers its removal
from the instance (mirrors the cookie-authed UI's existing behavior) — so a
scripted client churning follow/unfollow at high frequency can cause more
churn than a human ever would through the browser. Don't change any code —
this is a "know before you script" note, not a bug fix.

- [ ] **Step 3: Document all three 429 meanings in the Errors table**

Change the `429` row (currently just `Subscription cap reached`) to cover
all three real cases — the shape is already pinned in Global Constraints,
nothing to coordinate at execution time:

```markdown
| `429` | Subscription cap reached, the public firehose's per-IP connection cap, or an api-key rate limit — see `code` in the body for the rate-limit case (`RATE_LIMITED`); the other two are durable (don't retry) while a rate limit carries `tryAgainIn` and should be retried after that many ms |
```

Match the table's real current column formatting (read it fresh — this is
illustrative of the content, not guaranteed to match the exact Markdown
table syntax already in the file).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-01-external-api-and-firehose-design.md docs/superpowers/documentation/API.md
git commit -m "$(cat <<'EOF'
docs: correct phase-3 spec URLs, note follow cascade-delete + 429 overload

Spec still showed the original illustrative /api/v1/posts etc paths;
shipped paths are /api/v1/me/posts etc (renamed during phase-3 planning
to avoid real route collisions with the cookie-authed siblings). Also
documents that unfollowing a remote account's last follower triggers its
removal (mirrors existing cookie-route behavior, not new), and that 429
now has two distinct meanings (subscription cap vs rate limit).

developed with the help of AI tools
EOF
)"
```

---

### Task 2: Rate-limit exhaustion surfaces as 429, not 401

**Files:**
- Modify: `core/src/api/auth.ts`
- Test: `core/test/api-key-rate-limit.test.ts` (new)

**Interfaces:**
- Consumes: `ApiKeyVerification`'s `verifyApiKey` (already defined in this
  file) — its return shape needs re-reading fresh; this task relies on
  `result.error` carrying `{code?: string; details?: {tryAgainIn?: number}}`
  when `result.valid` is `false`, confirmed against installed source (see
  Global Constraints).
- Produces: `apiKeyAuth` and `apiKeyAuthAdmin` both return `429` (not `401`)
  specifically when `result.error?.code === 'RATE_LIMITED'`, with body
  `{error: 'rate limit exceeded', code: 'RATE_LIMITED', tryAgainIn:
  result.error.details?.tryAgainIn}` — this exact shape is pinned in Global
  Constraints and matched by Task 1 Step 3's Errors-table row; no ordering
  dependency between the two tasks.

- [ ] **Step 1: Write the failing test**

```ts
// core/test/api-key-rate-limit.test.ts
import { test, expect } from 'vitest'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { mountPersonalApiRoutes } from '../src/api/logical-routes.ts'
import { ensureCoreUser } from '../src/api/auth.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'

// Same erasure this file's siblings hit (personal-api-routes.test.ts,
// api-key-plugin.test.ts) — createAuth's `plugins: BetterAuthPlugin[]`
// widens every plugin so betterAuth()'s .api inference can't see
// apiKey()'s createApiKey. rateLimitMax/rateLimitTimeWindow are real,
// server-only per-key overrides (createApiKeyBodySchema,
// @better-auth/api-key/dist/index.mjs:590-592) — not invented for this test.
interface ApiKeyCreation {
  createApiKey(input: {
    body: {
      configId?: string
      userId?: string
      permissions?: Record<string, string[]>
      rateLimitMax?: number
      rateLimitTimeWindow?: number
    }
  }): Promise<{ key: string; id: string }>
}

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const bus = createEventBus()
  const auth = makeAuth(repo)
  const service = createService(repo, bus, null, store)

  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'ratelimited@x.test', repo)
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const authUserId = session!.user.id
  await ensureCoreUser(repo, authUserId)

  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo, service, sourceService: createSourceService(repo, null) })
  return { app, auth, authUserId }
}

test('rate-limit exhaustion surfaces as 429 with tryAgainIn and code, not a bare 401', async () => {
  const { app, auth, authUserId } = await setup()
  const apiKeyApi = auth.api as unknown as ApiKeyCreation
  // 2 requests per 60s window — GET /me/timeline (timeline:read) is a real,
  // already-mounted probe route; no bespoke test route needed.
  const key = (await apiKeyApi.createApiKey({
    body: { configId: 'user', userId: authUserId, permissions: { timeline: ['read'] }, rateLimitMax: 2, rateLimitTimeWindow: 60_000 },
  })).key!

  const first = await app.request('/me/timeline', { headers: { 'x-api-key': key } })
  expect(first.status).toBe(200)
  const second = await app.request('/me/timeline', { headers: { 'x-api-key': key } })
  expect(second.status).toBe(200)
  const third = await app.request('/me/timeline', { headers: { 'x-api-key': key } })
  expect(third.status).toBe(429)
  const body = (await third.json()) as { error: string; code: string; tryAgainIn: number }
  expect(body.code).toBe('RATE_LIMITED')
  expect(body.tryAgainIn).toBeGreaterThan(0)
})

test('a genuinely invalid key still returns a plain 401, not 429 (regression guard)', async () => {
  const { app } = await setup()
  const res = await app.request('/me/timeline', { headers: { 'x-api-key': 'not-a-real-key' } })
  expect(res.status).toBe(401)
  const body = (await res.json()) as { code?: string }
  expect(body.code).not.toBe('RATE_LIMITED')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T core npm test -w core -- api-key-rate-limit`
Expected: FAIL — the third request currently gets 401, not 429.

- [ ] **Step 3: Fix `apiKeyAuth` and `apiKeyAuthAdmin`**

In `core/src/api/auth.ts`, both functions currently have (verify against
the real current file, this is illustrative of the SHAPE of the fix, not
guaranteed byte-exact given the file has changed across 4 phases of this
session's work):

```ts
if (!result.valid || !result.key) return c.json({ error: 'invalid or insufficient api key' }, 401)
```

Change to distinguish the rate-limited case, using the exact response
shape pinned in Global Constraints:

```ts
if (!result.valid || !result.key) {
  if (result.error?.code === 'RATE_LIMITED') {
    return c.json({ error: 'rate limit exceeded', code: 'RATE_LIMITED', tryAgainIn: result.error.details?.tryAgainIn }, 429)
  }
  return c.json({ error: 'invalid or insufficient api key' }, 401)
}
```

`ApiKeyVerification` (already defined in this file, cast target for
`auth.api as unknown as ApiKeyVerification`) needs widening — it currently
has no `error` field on its `verifyApiKey` return type. Add:

```ts
interface ApiKeyVerification {
  verifyApiKey(input: {
    body: { configId: string; key: string; permissions: Record<string, string[]> }
  }): Promise<{
    valid: boolean
    key: { referenceId: string } | null
    error: { code?: string; details?: { tryAgainIn?: number } } | null
  }>
}
```

(Illustrative of the fields this task needs — merge into whatever the
interface's real current shape already has, don't replace fields this task
doesn't touch.)

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec -T core npm test -w core -- api-key-rate-limit`

- [ ] **Step 5: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`

- [ ] **Step 6: Commit**

```bash
git add core/src/api/auth.ts core/test/api-key-rate-limit.test.ts
git commit -m "$(cat <<'EOF'
fix(core): surface api-key rate-limit exhaustion as 429, not 401

verifyApiKey already preserves the plugin's TOO_MANY_REQUESTS error
(code:'RATE_LIMITED', details.tryAgainIn) in its response -- apiKeyAuth
and apiKeyAuthAdmin were discarding it and returning the same flat 401
as an actually-invalid key, so a client legitimately hitting the ceiling
couldn't tell "revoked" from "rate-limited" and back off correctly.

developed with the help of AI tools
EOF
)"
```

---

### Task 3: Missing permission-isolation test for `GET /me/posts`

**Files:**
- Test: `core/test/personal-api-routes.test.ts` (extend)

**Interfaces:** None — test-only, no production code change.

- [ ] **Step 1: Write the test**

Read `core/test/personal-api-routes.test.ts` fresh for its established
`freshApp()`/`mintKey()` (or equivalent) helpers and existing permission
-isolation test style (several already exist for the read/write route
pairs this task's finding says are covered — find one and mirror it
exactly). Add one test: mint a key with ONLY `posts:write` (no `posts:
read`), call `GET /me/posts`, assert `401`.

```ts
test('a posts:write-only key cannot reach the posts:read-gated GET /me/posts (permission isolation)', async () => {
  const { app, cookie, auth } = await freshApp('write-only@x.test')
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
  const key = await mintKey(auth, session!.user.id, { posts: ['write'] })
  const res = await app.request('/me/posts', { headers: { 'x-api-key': key } })
  expect(res.status).toBe(401)
})
```

(This is illustrative of the shape — use this file's REAL helper names,
which may differ from `freshApp`/`mintKey`; read the file fresh before
writing the real test, per this project's own established convention of
never trusting a plan's paraphrase of test infrastructure that predates
the plan.)

- [ ] **Step 2: Run test to verify it fails or passes correctly**

Run: `docker compose exec -T core npm test -w core -- personal-api-routes`
Expected: this test should already PASS if `authorize()`'s subset
semantics work the way the original finding assumed (the finding rated
this "low risk") — but if it unexpectedly FAILS, that means the original
finding's risk assessment was wrong and this is actually a real gap, not
just missing coverage. Either outcome is informative; report which one
happened in your task report, don't just silently note "test added."

- [ ] **Step 3: Run the full core suite + typecheck**

Run: `docker compose exec -T core npm test -w core` and
`docker compose exec -T core npm run typecheck -w core`

- [ ] **Step 4: Commit**

```bash
git add core/test/personal-api-routes.test.ts
git commit -m "$(cat <<'EOF'
test(core): pin the missing posts:write-vs-posts:read isolation direction

GET /me/posts (posts:read) was only ever tested against the opposite
direction (a read-only key hitting a write route); this closes the gap
the phase-3 final review flagged as untested but low-risk.

developed with the help of AI tools
EOF
)"
```

---

## Self-Review

**Spec coverage:** all three in-scope backlog items (spec URL drift,
rate-limit 401-vs-429, missing permission-isolation test) map 1:1 to a
task. The two out-of-scope items (idempotency, follow-cascade) are
explicitly NOT tasks here — one deferred with its scope correction already
recorded in `ideas.md`, the other downgraded to a Task 1 doc note.

**Placeholder scan:** clean. Every step has complete code.

**Rev 2 (2026-08-05) — folding in a parallel ponytail-review + ponytail-audit
pass, both run against the rev-1 plan before any code was written:**
- Both passes independently flagged the same thing: rev 1 deferred two
  decisions (the 429 response shape, and the rate-limit test's per-key
  override mechanism) that were actually gettable during planning — the
  deciding facts (`result.error.code`, and `createApiKeyBodySchema`'s
  `rateLimitMax`) sat a few lines apart in the same already-open file the
  rate-limit mechanism itself came from. Both are now pinned in Global
  Constraints and Task 2's test is complete, real code — not deferred.
- The audit independently re-verified (by reading the real service-layer
  call graph, not trusting the plan's own claim) that the idempotency
  deferral is correct: `POST /me/posts`/`POST /me/api-follows` really do
  share `service.createLocalPostAs`/`addFollow` with the cookie-authed
  siblings, and neither has any command-ledger wrapping today, unlike
  `subscribeByUrl`'s real `BEGIN IMMEDIATE`+`command_ledger_v2` mechanism —
  a route-local fix would be a second, weaker, inconsistent idempotency
  mechanism next to the one canonical pattern already in use elsewhere.
  Not picked back up.
- The audit also found a third, pre-existing, currently-undocumented 429
  case (the firehose's per-IP connection cap) that rev 1's Errors-table fix
  would have missed — folded into Task 1 Step 3's now-complete table row.
- Rev 1's tripled repetition of the same "coordinate Task 1 with Task 2"
  caveat across Global Constraints/Task 1/Self-Review is gone — the
  response shape being pinned once in Global Constraints means Task 1 and
  Task 2 no longer have any real ordering dependency; either can run first.

**Type consistency:** no new shared interfaces introduced across tasks;
Task 2's `ApiKeyVerification` widening is entirely local to
`core/src/api/auth.ts` and doesn't ripple into other files.
