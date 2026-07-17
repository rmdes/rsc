# Textcaster — better-auth session layer (anonymous-first) design

Date: 2026-07-17 (rev 2 — folds in
`docs/superpowers/reviews/2026-07-17-better-auth-spec-review.md`
SEC-1/2/3/4, COR-1..5, P-1)
Status: rev 2 pending review
Author: Ricardo (rmdes) with Claude Code
Prior art: `2026-07-15-textcaster-design.md` (deferred: IndieAuth/auth);
`2026-07-16-textcaster-following-design.md` explicitly deferred to this
milestone twice: "real auth comes later", "the auth milestone replaces
[form-carried handles] with the session identity".

## What this milestone adds

Sessions, for everyone. better-auth mounts inside core and becomes the
default auth mechanism: a visitor's first action (post, reply, follow)
transparently mints an anonymous `@guest-XXXXX` account — no form-filled
handle ever again — registration with email + password makes the account
permanent, and unregistered accounts are discarded after N idle days.
Adding remote feeds becomes a registered-only action. The shared bearer
token stops authenticating user actions — that closes today's
anyone-can-be-anyone hole, which is the real security payoff.

better-auth is chosen for its plugin ecosystem: magic-link, generic
OAuth/OIDC (the IndieAuth path), and social providers are later milestones
that plug into the same mount point without rearchitecting. This is the one
deliberate new dependency; sessions + credential storage + anonymous
account linking is exactly the security surface we do not hand-roll.

## Architecture

better-auth lives in **core** (approach chosen over web-side auth: core is
the API every future frontend and IndieWeb endpoint talks to — "web is just
one client" — so core must know who's asking; web-side auth would be torn
out the moment Micropub/IndieAuth arrive).

- Mounted on the existing Hono app:
  `app.on(['GET','POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))`.
- Auth tables live in core's existing SQLite database, on **the same raw
  `better-sqlite3` `Database` instance core already opens** (COR-4).
  `createSqliteRepository` (`sqlite.ts:444`) currently keeps that handle
  private to the factory — it is exposed (factory returns it alongside the
  repository, or an equivalent minimal change) and handed to better-auth.
  A second `new Database(file)` on the same path is forbidden: two
  connections mean lock contention / `SQLITE_BUSY`. One file, one handle.
- better-auth's own runtime migrator stays **disabled** (COR-5): schema
  comes exclusively from core's `MIGRATIONS` (see Migrations). Two
  migration mechanisms on one database is a collision, not a convenience.
- Plugins this milestone: `anonymous` (with `onLinkAccount`) and the
  built-in email/password method. Nothing else. Rate limiting: better-auth's
  built-in limiter, enabled and wired in the plan (not assumed).
- Version: exact-pin the current better-auth release at plan time (probe
  the installed package; do not write API calls from memory).

### Identity model — accounts vs timeline identities

Two tables, two meanings, both survive:

- better-auth's `user` table = **accounts** (credentials, sessions,
  `isAnonymous` flag).
- core's `users` table = **timeline identities** (local people AND remote
  feeds — remote "users" are feeds, not accounts, so the tables are
  genuinely different things).

One new column links them: `users.auth_user_id`, nullable, **UNIQUE, and
indexed** (COR-1) — one core user per account, and every authed request
resolves session → core user through it, so it needs the index. SQLite
UNIQUE permits multiple NULLs, so remote feeds (always NULL) are
unaffected. Posts and follows key on the core user's UUID, so registration
and rename never move data.

### Session cookie mechanics (SEC-1 — this is the security model, pinned)

The cookie is minted by core (better-auth) but must live in the browser
against the **web** origin. `web/src/lib/api.ts:4` targets core at a
different origin (`http://localhost:8787`), and SvelteKit's `event.fetch`
forwards browser cookies only to same-origin/relative URLs — so nothing is
automatic. Pinned mechanics:

- better-auth is configured to emit a **host-only cookie** (no `Domain`
  attribute), with `baseURL` and `trustedOrigins` set to the web app's
  public origin. The relayed cookie is then valid verbatim for the web
  origin.
- **Forwarding (browser → core):** every authed `api.ts` call threads the
  inbound request's `Cookie` header onto the outbound core fetch. One
  shared authed-fetch wrapper in `api.ts` (takes the SvelteKit
  `RequestEvent` or its cookie header, sets it on the core request);
  individual functions stop being called with a bare `fetch` for authed
  operations.
- **Relay (core → browser):** whichever web form action triggers a
  better-auth `Set-Cookie` (first-write mint, register, login, logout)
  re-emits it on its own response via SvelteKit's `cookies` API,
  preserving httpOnly, `SameSite=Lax`, `Path=/`, and `Secure` in
  production. The relayed attributes are part of the contract, not an
  accident of proxying.
- Get-it-wrong modes named so tests target them: cookie not forwarded →
  every authed action 401s; `Domain`-scoped cookie → browser rejects or
  mis-scopes it. Both get integration tests.

### Lifecycle

**Browsing.** No account exists until you act (P-1 decision: **lazy
minting**). Pure readers — humans, feed readers, crawlers — never mint
anything: zero bootstrap machinery, no Accept-header heuristics, no
read-path account churn. Eager minting on landing was considered and
rejected: its only unique value was showing a concrete guest handle to
visitors who haven't acted yet, and it cost a bootstrap hook plus
heuristic gating plus crawler cleanup. Reversal is cheap (one hook later)
if the discovery cue proves wanted.

**First write (the mint).** A visitor's first post/reply/follow arrives at
a web form action with no session cookie. The action calls core
`POST /api/auth/sign-in/anonymous`, relays the `Set-Cookie` (mechanics
above), then performs the requested action with the fresh session — one
round trip, invisible to the visitor. Core, on anonymous auth-user
creation (better-auth `databaseHooks.user.create.after`, gated on
`isAnonymous`), creates the linked core local user: handle `guest-` +
short random suffix (retry on `HandleTakenError`), display name = handle.
All server-side — the no-JS constraint holds.

**Registration (upgrade).** Email + password submitted while anonymously
signed in → better-auth links: `onLinkAccount({ anonymousUser, newUser })`
re-points `users.auth_user_id` to `newUser.id`; better-auth then deletes
the anonymous auth record (its default, kept). The core user row — handle,
display name, posts, follows — is untouched. Login from another device
with the same email resumes the same identity.

SEC-3 pins (plan-time probe against the installed better-auth, not
memory): confirm `onLinkAccount` runs **before** the anonymous-user
deletion and that hook + deletion are atomic (or define compensating
behavior — a failed re-point must abort the link, never dangle
`auth_user_id` or let a cascade eat the guest's posts). Confirm the
`isAnonymous` gate on the create-hook prevents registration from minting
a **second** core user — the guest's core row is reused via re-point
only. Both facts get tests, whatever the probe finds.

**Login while anonymous into a DIFFERENT existing account:** the current
guest identity is abandoned (no merging of two identities) and the idle
sweep reclaims it. Pinned: no merge UI, ever, until a real need appears.

**Rename.** `PATCH /me` (session-authed) updates handle and/or display
name any time, anonymous included — set once, never re-type. Uniqueness
enforced as today (`HandleTakenError` → 409 → inline form error). Rename is
one UPDATE because everything keys on UUID.

**Idle cleanup.** Anonymous accounts idle > `TEXTCASTER_ANON_TTL_DAYS`
(default 7) are discarded by a core-side interval sweep (same `setTimeout`
pattern as the existing poll loop, `server.ts:55`). Idle = latest
better-auth session `updatedAt` (fallback: auth user `createdAt` when no
session rows survive). The cascade runs in **one better-sqlite3
transaction** (COR-3): the guest's posts, follow rows in BOTH directions
(others may follow a guest), the core user row, the auth user + sessions —
a crash mid-sweep must never leave a half-reclaimed guest. better-auth
session `expiresIn` is configured ≥ the TTL so a returning tester's cookie
outlives the sweep window. Registered accounts are never swept.

Pinned side-effects, accepted not fixed:
- Deleting a guest's posts can orphan replies from others; threading
  already tolerates missing parents (remote items arrive out of order), so
  orphans degrade to top-level. Not a bug.
- Posts already syndicated out via feeds/WebSub cannot be recalled;
  deletion is local-only.
- A cleared/lost cookie orphans the guest account either way; the sweep is
  the garbage collector for that too.

## Request flow and core API changes

Browsers talk only to the SvelteKit server, as today. Core stays unexposed
to browsers; the cookie forward/relay is specified above (SEC-1).

Route changes (breaking, pre-release, no compat shims):

- `POST /posts` — session-authed. Author = session's core user (resolved
  via `auth_user_id`). Body drops `handle`/`displayName`. Bearer token no
  longer accepted.
- `POST /me/follows`, `DELETE /me/follows/:target`,
  `POST /me/follows/opml` — session-authed, replace the
  `POST|DELETE /users/:handle/follows*` write routes (which are removed).
  You can only mutate your own follows now — this is the "lock lenses to
  their owner" the following spec deferred, applied to writes; lens
  *viewing* stays public (they are lenses, not private inboxes).
- `POST /users` — creating a REMOTE user (add feed to monitor) requires a
  session that is **not** anonymous (403 otherwise: a new feed is a real
  polling cost for the whole instance). The ops bearer token is also
  accepted on this route (smoke scripts, seeding) — `session-or-token`
  middleware, this route only.
- `PATCH /me` — rename (above). `GET /me` — the session's core user, for
  the web layout's identity block (404-shaped "no session" is a normal
  state now, not an error).
- Reads (`GET /timeline`, lenses, feeds, OPML export, SSE) stay public.
  Unchanged.
- `TEXTCASTER_TOKEN` survives as ops credential only (`POST /users`,
  future admin surface). It authenticates no user action.

New repository surface (COR-2 — enumerated so nothing is discovered
mid-build; contract-tested like the rest of `repository-contract.ts`):

- `getUserByAuthUserId(authUserId)` — the per-request session → core-user
  resolution.
- `setAuthUserId(userId, authUserId)` — the `onLinkAccount` re-point.
- `updateUserProfile(userId, { handle?, displayName? })` — rename.
- `deleteUserCascade(userId)` — posts + follows both directions + user
  row, one transaction (the sweep's core half).
- `createLocalUser` gains an `authUserId` field (threads to `insertUser`).
- The sweep's "anonymous auth users with latest session `updatedAt` older
  than TTL" query over better-auth's tables (raw SQL on the shared handle;
  better-auth has no query API for this and doesn't need one).

## Web UX

Design-system rules apply (`design-system/textcaster/MASTER.md`; UI tasks
invoke `ui-ux-pro-max` first, per CLAUDE.md).

- **Identity block** in the layout header. No session: "Browsing as a
  guest — post or follow to get an identity", plus register/login links.
  With a session: display name + handle linking to your author lens;
  "Register to keep this account" while anonymous; logout when registered.
- **Forms lose identity fields.** Compose dialog, reply composer,
  follow/unfollow, OPML import: no more `handle`/`displayName` inputs — the
  session supplies identity server-side, minting it on first use.
- **Add-remote-feed gating.** Form renders only for registered users;
  anonymous users and sessionless visitors see a one-line "Register to add
  feeds" nudge. The 403 in core is the boundary; UI hiding is courtesy.
- **`/register`, `/login`** — plain SSR forms (email + password), SvelteKit
  actions proxying to core's better-auth endpoints, inline `fail()` errors
  (email taken, bad credentials). Register-while-anonymous = the upgrade.
- **`/settings`** — handle + display name edit. Nothing else this
  milestone.
- Every flow is forms + redirects; httpOnly server-set cookie; client
  bundle does not grow. No-JS stays first-class.

## Security

- **CSRF is enforced by SvelteKit, not better-auth** (SEC-2): the trust
  boundary is browser → web, and the effective defense is SvelteKit's
  default cross-origin form-POST rejection (`csrf.checkOrigin`), which
  stays enabled — a test pins it. better-auth's own origin check only ever
  sees web → core server fetches (no browser `Origin`); `trustedOrigins`
  is set so those proxied requests aren't rejected by it.
- Session cookie: httpOnly, `SameSite=Lax`, host-only, `Secure` in
  production — on the **relayed** cookie, per the mechanics section.
- New required config `TEXTCASTER_AUTH_SECRET` (fail-fast at boot, same
  pattern as `TEXTCASTER_TOKEN`). New optional
  `TEXTCASTER_ANON_TTL_DAYS=7`.
- Anonymous-account flooding: minting only happens on form POSTs (already
  CSRF-guarded), better-auth's per-IP rate limit covers the anonymous
  sign-in route, and the idle sweep is the backstop. `ponytail:` ceiling —
  throttle only; CAPTCHA/turnstile if a real flood ever happens.
- The bearer token's demotion to ops-only IS the security fix: user actions
  stop being authenticated by one shared secret plus a self-declared
  handle.

## Migrations

better-auth's CLI generates its table SQL **once at development time**; the
generated SQL is committed as the next `MIGRATIONS` entry (append-only,
`string[][]`, applied per-statement — the established pattern) together
with the `users.auth_user_id` column + its UNIQUE index. Runtime has no
CLI dependency and better-auth's migrator is off (COR-5); tests get the
full schema for free. If a later better-auth upgrade changes its schema,
that is a new migration entry, same rule.

## Testing

- Core: first-write mint creates the linked guest user (and retries handle
  collisions); session-authed post/follow attribute to the session user;
  401 without a session on user actions; 403 anonymous add-remote-feed;
  token still works on `POST /users`, and ONLY there; `PATCH /me` rename +
  409 conflict; `onLinkAccount` re-points the link, posts/follows survive
  registration, and no second core user is minted (SEC-3); sweep deletes
  the full cascade in one transaction, spares registered and
  active-anonymous users, and handles the no-session-rows fallback.
- Cookie mechanics (SEC-1): authed action without forwarded cookie → 401;
  minted cookie is host-only (no `Domain`) and relayed with
  httpOnly/`SameSite=Lax` intact.
- Web: form actions read identity from `locals`/cookie (no handle
  fields); first-write action mints then acts in one submission; add-feed
  gating renders both variants; SvelteKit CSRF rejection stays on (pin);
  register/login/settings action tests — existing Vitest patterns in both
  suites.
- Existing core API tests that authenticate user actions with the bearer
  token are UPDATED to session auth (the contract genuinely changed);
  read-route tests stay untouched. Smoke script signs in anonymously and
  exercises the real flow.

## Non-goals

Magic-link, IndieAuth, social providers (later milestones on this same
mount); email verification and password reset; account deletion UI;
merging two identities; avatars/profiles beyond handle + display name;
locking lens *viewing*; eager account-on-landing (rejected under P-1,
cheap to add later); any change to feeds, polling, push, or the SSE
protocol; admin UI for the ops token.
