# External API access + public firehose — Design

**Status:** Draft, pre-review. Brainstormed 2026-08-01.

**Goal:** Give RSC an external, keyed API surface — read a user's own data,
write on a user's behalf, drive admin/governance actions — plus a public,
anonymous SSE firehose, without widening the existing browser-facing surface
or weakening any existing route's trust model. Spec the whole architecture
now; implement it in phases (below).

## Background

RSC has two unrelated pieces of external-access precedent today, both narrow:

- **`/stream`** (`core/src/api/logical-routes.ts:544`, `mountLogicalStreamRoute`)
  — the durable, journal-backed SSE transport behind the web timeline. It
  already degrades to an anonymous viewer with no session
  (`core/src/server.ts:96-100`, `resolveViewer` returns `{localAccountId:
  null, activeSourceIds: []}` when `auth.api.getSession` finds nothing) — it's
  just never been treated as a public contract, only as what an anonymous
  browser tab happens to receive.
- **`/ops/sources/federation`** (`core/src/api/app.ts:467`) — a single shared
  bearer token (`bearerAuth`, constant-time compare against one configured
  secret), whose only real caller is the deploy-time smoke test
  (`core/src/smoke.ts`). Not a general admin API; not user-facing at all.

Nothing else external exists. `core/` is never browser-facing (CLAUDE.md
invariant) and only feeds/federation paths are exposed publicly via Caddy
today; everything else (auth, the SSE proxy) already goes through `web`
server-side. This design adds a third, deliberate external surface — it does
not change how the first two behave.

**better-auth's `api-key` plugin** (`@better-auth/api-key`, confirmed via the
better-auth MCP against current docs, not installed yet) is the mechanism:
per-user (or per-org, unused here) keys, built-in rate limiting, expiration,
and a `permissions: {resource: [action]}` model checked via
`auth.api.verifyApiKey({body:{key, permissions}})`. Its `configId` option
supports multiple named configurations (different prefix/rate-limit tiers)
under one plugin instance.

## Load-bearing invariants (do not break)

- **Core stays internal.** Every new external route is proxied through `web`
  server-side, exactly like `/api/auth/*` and `/stream` are today. No new
  Caddy public-allowlist entry for core.
- **No existing route's trust model changes.** `POST /posts`, `PATCH /me`,
  every `/admin/*` route, etc. stay cookie-session-only, exactly as today.
  New API-key-reachable capabilities are new routes calling the same
  underlying service functions — never a widening of what an existing route
  accepts.
- **`enableSessionForAPIKeys` is never turned on.** better-auth's own docs
  flag it as risky ("a leaked API key can be used to impersonate a user")
  because it mocks a session for *any* valid key on *any* `authed` route with
  no permission check. This design instead calls `verifyApiKey` explicitly,
  per new route, with a required permission — the plugin's actual
  access-control primitive, not its session-convenience shortcut.
- **Admin status is re-derived every request, never cached on the key.**
  `deriveIsAdmin` checks the request's email against the current
  `adminEmails` config on every call (`core/src/api/auth.ts`) — an admin key
  must be re-checked the same way, so a later-demoted admin's key stops
  working immediately, not whenever it happens to expire.
- **The deploy smoke test is untouched.** `core/src/smoke.ts`'s bearer token
  stays exactly as-is — it is a deploy-time credential, not a person, and
  doesn't fit the api-key plugin's user/org ownership model.
- **The firehose carries no permission model.** It's public and anonymous by
  design; it is not part of the key/permission vocabulary at all.

## Namespace

All new external routes live under **`/api/v1/...`** on `web`, forwarding to
new core route groups. Established now so later phases slot in without
reshaping the surface. Two separate proxy mechanisms, per how each is
authenticated:

- **Key *management*** (create/list/revoke a key) rides the **existing**
  `/api/auth/*` cookie-based proxy (`web/src/routes/api/auth/[...path]/
  +server.ts`) for free — better-auth plugin endpoints (including
  `api-key`'s `create`/`list`/`delete`/`get`) are grouped under the same
  `auth.handler` mount core already exposes there. No new proxy code.
- **Key *use*** (calling `/api/v1/*` to read/write/act) needs a **new**,
  purpose-built proxy, since the existing auth proxy only forwards
  `cookie`/`origin`/`x-forwarded-for`/`content-type` — it does not forward
  `x-api-key` (checked directly against the file; it builds a fresh
  `Headers()` for the emailed-link/cookie flow specifically). Shaped like the
  existing `web/src/routes/stream/+server.ts` (one bespoke proxy per
  concern), not a blanket catch-all: a small, known set of routes, each
  explicitly forwarding `x-api-key`.
- **CORS is out of scope for every phase below.** API-key auth is a header,
  not a cookie, so a script/curl/server-side caller never triggers a
  preflight. A future phase wanting *browser-based* third-party clients
  calling `/api/v1/*` directly would need `hono/cors` added deliberately —
  noted, not built.

## Core mechanism: `apiKeyAuth(requiredPermission)`

One new middleware factory in `core/src/api/auth.ts`, beside `sessionAuth`/
`registeredOnly`/`requireAdmin` (same factory-returning-`MiddlewareHandler`
pattern):

```ts
export function apiKeyAuth(permissions: Record<string, string[]>): MiddlewareHandler {
  return async (c, next) => {
    const key = c.req.header('x-api-key')
    if (!key) return c.json({ error: 'api key required' }, 401)
    const result = await auth.api.verifyApiKey({ body: { key, permissions } })
    if (!result.valid || !result.key) return c.json({ error: 'invalid or insufficient api key' }, 401)
    // referenceId is the owning user's id (references: 'user' for both configs below)
    c.set('coreUser', await ensureCoreUser(users, result.key.referenceId))
    // admin routes additionally re-derive isAdmin here — see Admin tier below
    return next()
  }
}
```

Composed per-route with the exact resource/action it needs, e.g.
`apiKeyAuth({ posts: ['write'] })` on the new post-create route. Exact
signature/error shapes to be pinned against the installed `@better-auth/
api-key` source at implementation time (CLAUDE.md: read installed source,
don't write library calls from memory) — this is the shape, not a promise of
the literal types.

## Key tiers (`configId`)

Two configurations on one `apiKey` plugin instance:

- **`configId: 'user'`** — self-serve, any registered user, created from a
  new "API keys" panel in web Settings (cookie-authed, via
  `authClient.apiKey.create`). Permission vocabulary (checked per-key at
  creation, per-route at use):
  - `timeline: ['read']` — the Personal-tab equivalent
  - `posts: ['read', 'write']` — own posts; write = create/edit/delete
  - `follows: ['read', 'write']` — follow/unfollow, subscription management
  - `profile: ['read', 'write']` — `PATCH /me`-equivalent (handle, display
    name, bio)
  A user picks per-key permissions via checkboxes at creation time — a
  cross-posting bot gets a `posts`-only key; a read-only dashboard gets a
  `timeline`-only key. Rate limit: a conservative shared default (exact
  numbers at plan time), overridable per key up to a ceiling, per the
  plugin's built-in `rateLimit` options.
- **`configId: 'admin'`** — mintable *only* through a new route gated by
  `requireAdmin()` (i.e. you must already be an admin, via the existing
  cookie-session check, to ever get an admin-scoped key issued) — never
  self-serve, never reachable from the regular Settings panel. Permission
  vocabulary:
  - `admin.read: ['read']` — source list, user list, governance/moderation
    state (read-only visibility)
  - `admin.sources: ['write']` — the governance verbs already built in
    `/admin/feeds` (pause/resume/quarantine/allow/block/unblock/establish
    federation)
  - `admin.moderation: ['write']` — hard removal (`DELETE /admin/users/
    :handle`, `DELETE /admin/posts/:id` equivalents)

No `write`-tier key type differentiation beyond the per-resource permissions
above — a single `configId: 'user'` key can hold any combination of the four
resource permissions; `configId` distinguishes *ownership class* (self-serve
user vs admin-only-issued), not read-vs-write.

## Public firehose

**`GET /api/v1/firehose/stream`** (web) → new core mount,
`mountPublicFirehoseRoute` (same file/shape as the existing
`mountLogicalStreamRoute`). No permission, no key, no session lookup at all.

- Reuses `streamSSE` + the durable journal's `source.start`/`source.batch`
  verbatim — no new event-sourcing.
- Viewer is hardcoded anonymous: `{ localAccountId: null, activeSourceIds: [] }`.
- Frames are filtered to `item.origin === 'local'` before `writeSSE`,
  matching `/users/rss.xml`'s existing scope (`core/src/api/
  logical-routes.ts:437`, `projectLocalActivity`) — the same audience as the
  public RSS firehose, just pushed instead of polled.
- **Last-Event-ID replay** works identically to `/stream` today — the
  journal-backed cursor/reset contract needs no special-casing for anonymous
  callers.
- **Abuse guardrail (new, minimal):** a per-IP concurrent-connection cap —
  an in-memory counter, no new dependency, no new storage — because making
  this a *documented, public* contract (rather than an incidental anonymous
  capability) changes the risk profile enough to warrant it now. This is the
  cheapest slice of the pre-existing "Stream guardrails" backlog idea
  (`docs/superpowers/ideas.md`); the fuller version (max connection lifetime,
  tuning) stays backlog.

## Read endpoints (phase 2)

- **`GET /api/v1/me/timeline`** — `apiKeyAuth({timeline: ['read']})` — the
  Personal-tab equivalent, reusing the existing v2 timeline service call,
  reshaped into a stable API JSON contract (not the SvelteKit page-data
  shape a browser gets).
- **`GET /api/v1/me/posts`** — `apiKeyAuth({posts: ['read']})` — the
  authenticated user's own local posts.

## Write endpoints (phase 3)

New routes, each composing `apiKeyAuth` with the specific permission, calling
the same service functions the existing cookie-authed routes already call
(`service.create`, the follow/unfollow service calls, the profile-update
call) — no duplicated business logic, only a second, key-authenticated entry
point:

- **`POST /api/v1/posts`**, **`PATCH /api/v1/posts/:id`**, delete equivalent
  — `apiKeyAuth({posts: ['write']})`.
- **`POST /api/v1/follows`**, unfollow/subscription-management equivalents —
  `apiKeyAuth({follows: ['write']})`.
- **`PATCH /api/v1/me`** — `apiKeyAuth({profile: ['write']})`. Handle changes
  through this path inherit whatever the [[Handle history]] backlog idea
  eventually does about old-handle survival — not solved here, just noted as
  a shared seam.

## Admin tier (phase 4)

- **`GET /api/v1/admin/...`** (source list, user list, governance/moderation
  state) — `apiKeyAuth({'admin.read': ['read']})`.
- **Governance actions** (pause/resume/quarantine/allow/block/unblock/
  establish federation) — `apiKeyAuth({'admin.sources': ['write']})`.
- **Hard removal** (user, post) — `apiKeyAuth({'admin.moderation': ['write']})`.
- **Admin re-verification:** on top of the permission check, `apiKeyAuth`
  for every route under this tier re-derives `isAdmin` from the *current*
  `adminEmails` config for the key's owning user, every request — a key
  minted while its owner was an admin stops working the moment they're
  removed from `adminEmails`, without needing to revoke the key itself.
- **Admin key issuance route** (`POST /api/v1/admin/api-keys` or similar,
  exact path at plan time) is itself `requireAdmin()`-gated (cookie session)
  — the only way to mint a `configId: 'admin'` key.

## Key management UX

A new "API keys" panel in web Settings:

- **User tier:** list existing keys (name, prefix, created date, last used,
  permissions — never the key value itself after creation), create (name +
  checkbox-per-permission + optional expiry), revoke. Uses `authClient.
  apiKey.create/list/delete` directly — cookie-authed, existing `/api/auth/*`
  proxy, zero new web-to-core plumbing for this part.
- **Admin tier:** a separate admin-only panel (e.g. under `/admin/`) for
  minting `configId: 'admin'` keys, calling the new `requireAdmin()`-gated
  issuance route above.
- The key value is shown exactly once, at creation — standard practice,
  matches the plugin's own model (`get`/`list` never return `key`, only
  `getApiKey`'s omitted-`key` shape).

## Non-goals

- **No CORS** for any phase (see Namespace section) — revisit only if a
  browser-based third-party client is explicitly wanted later.
- **No organization-owned keys** — RSC has no multi-tenant/team concept;
  `references: 'user'` for both configs.
- **No full third-party-client scope beyond what's listed above** — enough
  surface for scripts/bots/automations, not a promise of parity with the
  browser UI. A genuine "build a full alternative RSC client" push is a
  separate, later backlog idea if it turns out this surface isn't enough.
- **The deploy smoke test's bearer token is not migrated onto this system**
  (see Load-bearing invariants).

## Open questions for implementation time (not resolved here)

- Exact `@better-auth/api-key` type signatures (`verifyApiKey`'s real return
  shape, `createApiKey`'s exact body) — pin against installed source, per
  CLAUDE.md, not this spec's illustrative code.
- Exact rate-limit numbers per tier/config.
- Exact response JSON shapes for the new `/api/v1/*` endpoints (a stable
  public contract, versioned by the `v1` in the path — changes need a `v2`
  path, not a breaking change to `v1`).
- Whether `/api/v1/me/timeline` needs its own cursor/pagination contract
  distinct from the browser's internal one.

## Tradeoffs

**A public, documented firehose is a bigger abuse surface than an incidental
anonymous one**, even scoped to local-origin posts only — mitigated by the
minimal per-IP cap now, with the fuller guardrail idea staying backlog for if
real abuse shows up.

**Per-resource permissions add real surface area** (four resources × up to
two actions, plus three admin resources) **compared to one undifferentiated
write grant** — the cost is more to document, test, and reason about; the
benefit is a leaked key's blast radius is one resource, not the whole write
surface. Chosen deliberately (your call, this session) over the simpler
option.

**Explicit `verifyApiKey` per route costs more code than
`enableSessionForAPIKeys`** — every new route needs its own `apiKeyAuth(...)`
composition instead of "it just works" on existing routes. That cost buys
exactly the guarantee that matters here: no existing route's trust model
changes, and a key's permissions are actually enforced, not just assumed.

**Two key tiers (`user`/`admin`) instead of one** — a small amount of extra
plugin configuration, in exchange for admin-key issuance being gated at the
route level (`requireAdmin()`) rather than trusted purely on a permission
string ever having been granted.
