# Hono compliance audit — core/ HTTP layer

**Date:** 2026-07-19 · **Scope:** the entire Hono surface of `core/`
(`api/app.ts` 496 L, `api/auth.ts` 103 L, `api/cursor.ts` 12 L, `smoke.ts`).
**Rubric:** the project `hono` skill (house style) + Hono `4.12.30` installed
source. **Method:** full read of every route/middleware + verification of two
candidate findings against `node_modules/hono`.

## Headline

The Hono layer is **highly compliant** — with its own *documented house style*,
which is the correct bar here. The "in-house custom patterns" a first pass
flagged are, in the large majority, **deliberate and blessed**: hand-rolled
guards over `zValidator`, `c.json({error}, status)` over `HTTPException`,
`app.request` tests over `testClient`, one global `ContextVariableMap` over
per-instance generics, plain `fetch` over RPC. Those are YAGNI/no-new-deps
choices the skill mandates — **not debt**, and not to be "modernized."

Anti-pattern sweep came back empty: no `HTTPException`, no `zod`/`zValidator`,
no `hc`/`AppType`/RPC, no `new Hono<{…}>` generics, no stray `c.req.json()`
outside `readJsonBody`. Every `throw` bubbles to `app.onError` by design.

The textbook-correct parts are worth naming: `app.onError` as the single error
shaper (`app.ts:72`), `streamSSE` + `stream.onAbort(off)` + `Last-Event-ID`
replay (`app.ts:464`), `bodyLimit` on every public/federation POST
(`/hub`, `/rsscloud/*`, `/websub/callback`, `/me/follows/opml`),
`MiddlewareHandler` factories, `c.req.parseBody()` for form posts, `app.on`
with a path array for the mail-gate.

So this is a **3-nits-and-one-structural-improvement** audit, not a rewrite.

---

## Findings (ranked)

### 1. [Important] The admin gate is repeated on all 6 `/admin/*` routes

`authed, requireAdmin()` is copy-pasted positionally onto every admin route:
`/admin/overview` (`app.ts:147`), `/admin/users` (`:154`), `GET+PATCH
/admin/settings` (`:156,:159`), `/admin/feeds` (`:170`), `DELETE
/admin/users/:handle` (`:181`), `DELETE /admin/posts/:id` (`:187`) — six
sites, identical guard.

**Why it matters (beyond DRY):** the gate is opt-in per route, so a *future*
`/admin/*` route that forgets the pair ships publicly with no compile-time or
review signal. That's a latent authorization footgun, not just repetition.

**Hono-native fix:** path-scoped middleware — register the gate once:
```ts
app.use('/admin/*', authed, requireAdmin())
```
then drop the per-route guards. New admin routes are gated by construction.
Idiomatic Hono (`app.use(prefix, …)`), no new dep, net-negative LOC.

**Caveat to honor:** `POST /users` and `DELETE /users/:handle` use
`adminOrToken` (token **or** admin) and are **not** under `/admin/*` — leave
them exactly as they are; the `app.use('/admin/*', …)` prefix doesn't touch
them. Verify no `/admin/*` route ever wants the token path (none does today —
all six are session-admin-only).

### 2. [Minor] No `bodyLimit` on authed JSON write routes

`bodyLimit` guards every public/federation POST but **none** of the authed
JSON writes: `POST /posts` (`:103`), `PATCH /posts/:id` (`:120`), `POST
/me/subscriptions` (`:295`), `PATCH /admin/settings` (`:159`), `POST
/me/follows` (`:212`), `POST /users` (`:91`), `PATCH /me` (`:193`). Each calls
`readJsonBody` → `c.req.json()`, which **buffers the full body** before the
`isString(content, 1, 100000)` length cap can reject it. Serving is
`serve({ fetch: app.fetch })` (`server.ts:83`) with no global `maxRequestBody`,
so core imposes no ceiling of its own — a large body is fully read before
validation.

**Severity:** low — these are session/token-authed and sit behind Caddy/nginx,
which cap upstream. But the house *already* treats `bodyLimit` as the pattern,
so extending a modest cap to JSON writes is consistent hardening, not new
machinery. Cheapest form: one shared `const jsonLimit = bodyLimit({ maxSize:
256*1024, onError: rejectOversized })` applied to the write routes (256 KB
comfortably clears the 100 000-char content cap).

### 3. [Minor] `HandleTakenError` maps to two different statuses

`HandleTakenError extends DomainError` (`domain/types.ts:3`), so it hits
`app.onError` → **400** with `err.message`. But `PATCH /me` catches it
explicitly and returns **409** (`app.ts:207`). `POST /users` (`:99`,
`service.addRemoteUser`) does **not** catch it — an admin adding a feed whose
handle collides gets a **400**, while a user renaming into a collision gets a
**409**. Same error, two contracts.

**Fix (pick one):** either catch `HandleTakenError` in `POST /users` and return
409 to match `PATCH /me`, or accept 400 there deliberately and note why. The
inconsistency — not the specific code — is the finding.

### 4. [Observation — reviewed, not a defect] `adminOrToken` manual composition

`adminOrToken` (`auth.ts:92`) hand-composes middleware —
`viaSession(c, (() => mustBeAdmin(c, next)) as unknown as Next)` — to express
"bearer token **OR** (session **AND** admin)", relying on `return next()`
propagation (why `sessionAuth`/`requireAdmin` use `return next()`, `:69,:76,:83`)
and one `as unknown as Next` cast.

Hono ships the native combinators for exactly this shape — `hono/combine`
`some(...)` (OR) / `every(...)` (AND), confirmed present in 4.12.30. **But**
`some`/`every` detect a failed branch via a **thrown exception**, and the house
style deliberately **returns** `c.json({error}, status)` and never throws. So
adopting `some`/`every` here would force throw-based auth errors — a *regression
against* the no-throw convention, not an improvement. The manual composition is
a justified, well-commented deviation. **Keep it.** Optional: add one test
asserting `Authorization: Bearer <wrong>` still 401s through this path, to pin
the return-propagation contract the cast depends on.

### 5. [Trivial] Dead-defensive `c.req.param('x') ?? ''`

Path params for a matched route are always `string` in Hono, so the `?? ''` on
`c.req.param('handle')`/`('id')`/`('target')` (`:176,:182,:188,:222,:229,…`) is
unreachable-branch defensiveness. Harmless; drop on touch. Not worth its own
change.

---

## Out of audit scope (spotted, not Hono)

- `GET /posts/:id/revisions` (`app.ts:135`) is **unauthenticated** — public
  revision history for any post id. That's an authorization design choice, not
  a Hono-compliance matter; flag only to confirm it's intended (the rendered
  post is public, so likely yes).
- The `/timeline` query-parsing block (`:417-462`) is the one verbose,
  hand-rolled spot (~45 L). Correct and readable; Hono offers no query coercion
  without a validator, which the house avoids — so it stays. Noted only because
  it's the densest handler.

## Verdict

Ship-as-is is defensible. If acting: **do Finding 1** (real safety +
simplification), optionally fold **2 and 3** as one small hardening/consistency
commit. Findings 4 and 5 are "leave it / touch-on-sight." No finding requires a
spec or a new dependency; all fit a single focused PR against `core/src/api/`.
