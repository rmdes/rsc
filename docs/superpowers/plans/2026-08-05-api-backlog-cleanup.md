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
  api-key/dist/index.mjs`'s `consumeRateLimit` (around line 1790) throws
  `new APIError('TOO_MANY_REQUESTS', { message: decision.message, code:
  'RATE_LIMITED', details: { tryAgainIn: decision.tryAgainIn } })` when the
  window is exceeded. `verifyApiKey`'s own endpoint handler (around line
  1958) catches any `APIError` from `validateApiKey` and returns `ctx.json({
  valid: false, error: { ...error.body, message: error.body?.message, code:
  error.body?.code }, key: null })` — the specific code AND `details.
  tryAgainIn` survive into the JSON response. RSC's `apiKeyAuth`/
  `apiKeyAuthAdmin` (`core/src/api/auth.ts`) currently do `if (!result.valid
  || !result.key) return c.json({ error: 'invalid or insufficient api key'
  }, 401)` — discarding `result.error` entirely regardless of why
  verification failed. The fix is local to these two functions; nothing in
  better-auth needs changing. Re-verify this against the installed source
  before implementing, not from this paraphrase — versions can drift.
- **`docs/superpowers/documentation/API.md` already documents the intended
  429 behavior** (`### Rate limit` section: "Exceeding it returns an error
  with a `tryAgainIn` value in milliseconds") — this was written aspirationally
  by a parallel session before this fix landed. Task 2 makes the code match
  the docs, not the other way around; don't touch that section of `API.md`
  unless the real response shape ends up different from what's documented,
  in which case fix the docs to match reality.
  - **Wrinkle found during planning (2026-08-05)**: `API.md`'s existing
    `429` row in the Errors table currently means "subscription cap
    reached" (`| 429 | Subscription cap reached |`). Task 2 introduces a
    SECOND, unrelated meaning for the same status code (rate-limit
    exhaustion) — both are legitimate uses of 429, but a client can no
    longer assume "429 always means the subscription cap." Task 2 must
    make the two cases distinguishable in the response body (e.g. via the
    `error` message text, or a `code` field) and Task 1 should update the
    Errors table to note both meanings and how to tell them apart — read
    `API.md`'s current Errors section fresh before writing this, since Task
    1 and Task 2 both touch this doc and should be sequenced (Task 1 first)
    or coordinated to avoid one undoing the other's edit.
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

- [ ] **Step 3: Add the 429-ambiguity note to the Errors table (coordinate with Task 2)**

If Task 2 hasn't landed yet when you do this step, still update the Errors
table now: change the `429` row from `Subscription cap reached` to note
BOTH meanings (subscription cap reached, or api-key rate limit exceeded)
and how a client tells them apart (Task 2 will define the exact
distinguishing field/message — if Task 2 isn't done yet, write this step
as a placeholder TODO comment in the doc source itself is NOT acceptable
per this project's "no placeholders" plan convention; instead, either
sequence Task 2 before this step, or write the real distinguishing text now
by reading Task 2's brief for its exact response shape before finalizing
this doc edit).

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
  specifically when `result.error?.code === 'RATE_LIMITED'`, with a response
  body that includes `tryAgainIn` (from `result.error.details?.tryAgainIn`)
  so a client can back off correctly — exact JSON shape decided at
  implementation time (e.g. `{error: 'rate limit exceeded', tryAgainIn:
  <ms>}`), but MUST be distinguishable from the existing subscription-cap
  `429` (Task 1 Step 3 documents whichever shape is chosen here — if this
  task lands after Task 1's doc edit, go back and make sure the doc
  matches the real shape, don't leave it stale).

- [ ] **Step 1: Write the failing test**

```ts
// core/test/api-key-rate-limit.test.ts
import { describe, test, expect } from 'vitest'
import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createAuth } from '../src/auth.ts'
import { apiKeyAuth } from '../src/api/auth.ts'

async function setup() {
  const db = new Database(':memory:')
  const repo = await createSqliteRepository(':memory:')
  // NOTE: two different repos above is likely wrong — createSqliteRepository
  // takes a filename and opens its own handle; read the real signature and
  // this file's own auth-helper.ts fresh before finalizing setup, this is
  // illustrative only. The key requirement: an auth instance whose
  // `configId:'user'` apiKey config has a LOW rateLimit.maxRequests (e.g. 2)
  // so the test can exceed it in a handful of requests without waiting an
  // hour — check whether createAuth's real options let you override this
  // per-test, or whether you need to mint the key with an explicit
  // low `rateLimitMax` via `auth.api.createApiKey`'s own per-key override
  // (the plugin supports this — confirmed in ALLOWED_KEY_PERMISSIONS-adjacent
  // code comments — read core/src/auth.ts's apiKey() config and the
  // installed plugin's createApiKey options to find the real per-key
  // override field name before writing this test for real).
}

describe('api-key rate-limit exhaustion', () => {
  test('surfaces as 429 with tryAgainIn, not a bare 401, once the window is exceeded', async () => {
    // Mint a key with a low rateLimitMax (e.g. 2 requests), hit a
    // timeline:read-gated probe route 3 times, assert the 3rd is 429 with
    // a tryAgainIn field — NOT 401. Write the real test body after
    // confirming the exact mechanism for overriding rateLimitMax per-key
    // (see the setup() note above).
  })

  test('a genuinely invalid key still returns 401, not 429 (regression guard)', async () => {
    // Confirms this fix didn't accidentally widen 429 to cover invalid-key
    // cases too — a bogus key string should still 401.
  })
})
```

This task's test skeleton is deliberately incomplete (unlike every other
task in this project's recent plans, which give complete code) because the
exact mechanism for making a test key exceed its rate limit quickly (rather
than waiting a real hour) needs grounding against the installed
`@better-auth/api-key` source at implementation time — don't guess the
per-key override field name, read `core/node_modules/@better-auth/api-key/
dist/index.mjs`'s `createApiKey` body (already read once during phase 2/3
planning — the same file this project's own `POST /me/api-keys` route
already reads for other fields) to confirm the exact override mechanism,
then write the real test.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec -T core npm test -w core -- api-key-rate-limit`
Expected: FAIL — first test currently gets 401 not 429.

- [ ] **Step 3: Fix `apiKeyAuth` and `apiKeyAuthAdmin`**

In `core/src/api/auth.ts`, both functions currently have (verify against
the real current file, this is illustrative of the SHAPE of the fix, not
guaranteed byte-exact given the file has changed across 4 phases of this
session's work):

```ts
if (!result.valid || !result.key) return c.json({ error: 'invalid or insufficient api key' }, 401)
```

Change to distinguish the rate-limited case:

```ts
if (!result.valid || !result.key) {
  if (result.error?.code === 'RATE_LIMITED') {
    return c.json({ error: 'rate limit exceeded', tryAgainIn: result.error.details?.tryAgainIn }, 429)
  }
  return c.json({ error: 'invalid or insufficient api key' }, 401)
}
```

Confirm `ApiKeyVerification`'s type (already defined in this file, cast
target for `auth.api as unknown as ApiKeyVerification`) actually types
`result.error` with a `code`/`details` shape — if it's currently typed as
`unknown` or omitted entirely, widen the interface to match what the
installed source really returns (re-read it fresh, per Global Constraints),
don't use an `as` cast to paper over a type mismatch.

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

**Placeholder scan:** Task 2's test skeleton is deliberately incomplete
(the rate-limit-override mechanism needs grounding against installed
source at implementation time) — this is flagged explicitly as a
deviation from this project's normal "complete code in every step" rule,
with a stated reason, not a silent gap. Every other step in this plan has
complete code or an explicit, reasoned deferral.

**Sequencing note:** Task 1 (docs) and Task 2 (code) both touch `API.md`'s
Errors table for the 429 row — Task 1 Step 3 explicitly calls out
coordinating with Task 2's actual response shape rather than guessing it.
If executed via SDD (fresh subagent per task), the controller dispatching
these tasks should either sequence Task 2 before Task 1's Step 3, or
re-check Task 1's doc edit against Task 2's real landed shape afterward —
this is the one place in this otherwise-independent 3-task plan where
task order matters.

**Type consistency:** no new shared interfaces introduced across tasks;
Task 2's `ApiKeyVerification` widening (if needed) is entirely local to
`core/src/api/auth.ts` and doesn't ripple into other files.
