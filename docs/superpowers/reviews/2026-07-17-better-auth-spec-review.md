# Spec review — better-auth session layer (2026-07-17, 935c1c7)

Security-first (this is an auth milestone), then correctness, then ponytail.
Every claim grounded in a file read of the current code.

**Verdict: NOT ready to plan as written.** The architecture is sound and the
dependency is the right call, but several *load-bearing security mechanics are
under-specified* — chiefly the cross-origin cookie forwarding/relay (SEC-1) and
where CSRF is actually enforced (SEC-2). Pin SEC-1/2/3, COR-1/3/4, and answer
the one ponytail question (P-1) before writing the plan. The rest is
enumeration.

The core problem is real and correctly diagnosed: today **every** mutating route
is `bearerAuth(token)` (`api/app.ts:67,79,101,111,154`) with a self-declared
`handle` in the body (`api/app.ts:82-83`; web `+page.server.ts:20-25`;
`api.ts:76`). One shared secret + a claimed handle = anyone-can-be-anyone. This
milestone closes it.

---

## Security

### SEC-1 — HIGH: the cross-origin cookie forward + Set-Cookie relay is the whole security model, and it's under-specified

The session cookie is minted by **core** (better-auth) but must be stored by the
browser against the **web** origin, presented to web, forwarded to core, and
validated there. Two facts from the code make this non-trivial:

- `web/src/lib/api.ts:4` — `base()` is `http://localhost:8787`, a **different
  origin** from the web app. SvelteKit's `event.fetch` forwards the browser's
  cookies **only** for same-origin/relative URLs — it will **not** attach them
  to a cross-origin absolute core URL. So "the web server forwards the incoming
  `Cookie` header on its server-side fetches" is not automatic: every `api.ts`
  function (which today receives only `f` + payload) must be changed to also
  thread the inbound `Cookie` header onto the outbound request.
- The reverse relay (`Set-Cookie` from core → browser) must re-emit the cookie
  with attributes correct for the **web** origin. If better-auth stamps a
  `Domain` bound to core's host, the browser will reject or mis-scope it. The
  spec says only "relays `Set-Cookie` back."

**Pin before planning:** (a) configure better-auth to emit a **host-only** cookie
(no `Domain` attribute) and set `baseURL`/`trustedOrigins` to the web origin so
the relay is verbatim; (b) specify exactly where the inbound cookie is read and
threaded (a `cookie` arg through `api.ts`, or a shared authed-fetch wrapper) and
where `Set-Cookie` is relayed (hooks for bootstrap; each auth form action for
register/login/logout); (c) name the httpOnly/SameSite=Lax/Secure attributes on
the **relayed** cookie, not just better-auth's originals. Get this wrong and
either every authed action 401s, or the cookie leaks/mis-scopes.

### SEC-2 — MED-HIGH: CSRF is enforced at browser→web (SvelteKit), NOT at better-auth

The spec says "better-auth's endpoints ship origin-checking." True — but
better-auth only ever sees **web→core server-side fetches**, whose `Origin` is
the server's or absent. The real trust boundary is **browser→web**, which
better-auth never sees. So better-auth's CSRF check sits at the wrong boundary;
the effective CSRF defense is **SvelteKit's** built-in cross-origin form-POST
rejection (`csrf.checkOrigin`, on by default).

**Pin:** (a) confirm SvelteKit's CSRF origin check stays enabled for
`/register`, `/login`, logout, compose, follow actions; (b) set better-auth
`trustedOrigins`/`baseURL` so the proxied server-side requests aren't *rejected*
by its own origin check (server fetches with no browser `Origin`). The spec's
security section should relocate the CSRF claim to the SvelteKit layer.

### SEC-3 — MED: `onLinkAccount` ordering + atomicity on upgrade

The upgrade re-points `users.auth_user_id` (anon → newUser) and better-auth then
deletes the anonymous auth record. Two failure modes the spec assumes away:
- If better-auth deletes the anon user **before** `onLinkAccount` re-points, or
  if the re-point throws, you get a dangling `auth_user_id` or a cascade that
  eats the guest's posts.
- The `databaseHooks.user.create.after` gate (`isAnonymous`) must ensure that
  registering-while-anonymous does **not** mint a *second* core user for the new
  non-anonymous user — the guest's core row must be reused via re-point only.

**Pin (plan-time probe against installed better-auth):** confirm `onLinkAccount`
runs before the anon deletion and both commit atomically; define behavior if the
re-point fails; assert the create-hook gate skips the registered user. This is
the one place a bug silently destroys a user's posts/follows.

### SEC-4 — account-on-landing mints on READ (accepted-risk, confirm scope)

Bootstrap fires on any no-cookie `Accept: text/html` load — so every unique
reader **and** every crawler that sends `text/html` without cookies mints an
auth user + core user + session before rendering. The spec ceilings this
(Accept-header heuristic + per-IP rate limit + idle sweep) with an honest
`ponytail:` note. Confirm: (a) better-auth's rate limiter is actually enabled
and tuned low on the anonymous route (the spec asserts it — the plan must wire
it), and (b) the operator accepts account-on-**read**, not just on write (see
P-1 — this is the same decision from the ponytail side).

---

## Correctness

- **COR-1:** `users.auth_user_id` should be **UNIQUE + indexed**, not just
  "nullable column." One core user per auth user, and every authed request
  resolves session→core-user by it (needs the index). SQLite UNIQUE permits
  multiple NULLs, so remote feeds (`auth_user_id = NULL`) are unaffected. Spec
  names only the column.
- **COR-2 (enumerate the new repo surface):** the contract
  (`repository-contract.ts`) has none of what this needs —
  `getUserByAuthUserId`, a bulk `deleteUserCascade(userId)` (posts + follows in
  **both** directions + core row), and the sweep's "latest session `updatedAt`"
  query over better-auth's `session` table. `createLocalUser`/`insertUser`
  (`sqlite.ts:81-92`) must accept `auth_user_id`. List these as tasks so none is
  discovered mid-build.
- **COR-3:** the sweep cascade must run in **one better-sqlite3 transaction** —
  a crash mid-delete otherwise leaves a half-reclaimed guest (orphan posts/follow
  rows, dangling `auth_user_id`). Spec says "cascade" without pinning atomicity.
- **COR-4 — shared DB handle footgun:** `sqlite.ts:444` opens the raw
  `better-sqlite3 Database` (`sqlite`) then wraps it in Kysely (`:447`); that raw
  handle is currently **private to the factory**. better-auth must receive **that
  same instance** — if it opens its own `new Database(file)` on the same path you
  get lock contention/`SQLITE_BUSY`. Pin: expose the one handle and hand it to
  better-auth; the shared single sync connection is otherwise fine.
- **COR-5:** ensure better-auth does **not** run its own runtime migration —
  the spec bakes its generated SQL into `MIGRATIONS` (correct: `MIGRATIONS` is
  `string[][]` applied by `sqlite.exec`, `sqlite.ts:339,437`). If better-auth
  also auto-migrates at boot the two mechanisms collide. Disable its migrator.

---

## Ponytail

- **P-1 (the main flag): eager account-on-landing vs lazy account-on-first-write.**
  Minting the guest lazily — at the first compose/follow instead of on landing —
  would delete the Accept-header heuristic, the bootstrap hook, and **all**
  reader/crawler account churn (SEC-4 mostly evaporates), while still delivering
  "no form-filled handle ever." The only thing eager buys that lazy doesn't is a
  guest handle shown in the header to **pure readers** as a discovery cue. That's
  a real product goal — so flag, don't block — but the spec should state plainly
  that the header-identity-for-readers cue is worth the whole bootstrap +
  heuristic + read-time account machinery. If it isn't, lazy is materially less.
- **P-2:** better-auth itself is the correct ponytail call — sessions +
  credential storage + anonymous linking is exactly the security surface you do
  **not** hand-roll. No objection to the one new dependency.
- **P-3:** two-table split (accounts vs timeline identities), `PATCH /me`,
  `GET /me`, `/settings`, `session-or-token` on `POST /users` only — all minimal
  and justified. Remote feeds genuinely aren't accounts, so they can't share
  better-auth's `user` table; the single `auth_user_id` link is the least join.

---

## Verified sound
- DB is genuinely a raw `better-sqlite3 Database` wrapped in Kysely
  (`sqlite.ts:444-447`) → "better-auth accepts the Database core already opens"
  is architecturally valid (given COR-4's shared-handle pin).
- `MIGRATIONS: string[][]` applied per-statement via `sqlite.exec`
  (`sqlite.ts:339,437`) → committing better-auth's generated SQL as the next
  entry + `ALTER TABLE users ADD COLUMN auth_user_id` fits the established
  append-only pattern.
- `insertUser` catches `SQLITE_CONSTRAINT_UNIQUE` → `HandleTakenError`
  (`sqlite.ts:86-87`) → the `guest-XXXXX` retry loop is implementable as claimed.
- Posts/follows key on `users.id` (UUID, `sqlite.ts:82`) → registration and
  rename move no data, exactly as stated.
- Interval sweep matches the existing `setTimeout` poll loop (`server.ts:55-57`).
- Bearer demotion to `POST /users` only is a clean narrowing; current
  `bearerAuth` is already timing-safe (`auth.ts:8`).

## What to change before planning
SEC-1 (cookie forward/relay mechanics + better-auth cookie/baseURL config),
SEC-2 (CSRF belongs to SvelteKit; set `trustedOrigins`), SEC-3 (`onLinkAccount`
ordering/atomicity + create-hook gate), COR-1 (`auth_user_id` UNIQUE+index),
COR-3 (transactional sweep), COR-4 (share the one DB handle). Enumerate COR-2's
new repo methods. Answer P-1 (eager vs lazy) in the spec. The architecture,
dependency choice, identity-model split, and migration approach are sound.
