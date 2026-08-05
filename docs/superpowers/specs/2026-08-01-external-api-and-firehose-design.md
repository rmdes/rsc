# External API access + public firehose — Design

**Status:** rev 3 (2026-08-05) — rev 2 folded ponytail-review + ponytail-audit
findings: collapsed the per-route-family web proxies (phases 2-4) into one
catch-all, closed a real enforcement gap in admin-key issuance (a
`before`-hook, not a bespoke route, is the actual security boundary — and
this also simplifies the design by removing a route that turned out
unnecessary), named phase 4's concrete consumer, and added the
CLAUDE.md-required dependency justification for `@better-auth/api-key`. rev 3
records a real deviation found during phase 4 implementation: admin key
issuance needed its own route after all — see rev 3's Implementation
deviation under Admin tier. See Revision history.

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

**Dependency justification (CLAUDE.md: propose a new package only after
showing stdlib/existing-dependency won't do).** `@better-auth/api-key` is a
separate package from core `better-auth` (confirmed: not in
`better-auth@1.6.23`'s own plugin exports) — it is a genuinely new
dependency, not something already installed. The hand-rolled alternative
already exists in this file: `bearerAuth` (`core/src/api/auth.ts:14-22`,
`timingSafeEqual` against one configured secret) is exactly what a
single-secret grant needs, and is *not* being replaced here — the deploy
smoke test keeps using it. What the smoke test's one-token compare cannot
give us: per-key hashing, per-key rate limits, expiry, prefixes, individual
revocation, and a management API (create/list/delete) — reimplementing that
by hand is a real, multi-table feature, not "a few lines" the ladder would
prefer. The package is from the already-adopted better-auth family (same
vendor as `emailAndPassword`/`magicLink`/`anonymous`/`multiSession`, all
already in `core/src/auth.ts`), not a new vendor relationship. On that
basis: justified.

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
- **Key *use*** (calling `/api/v1/*` to read/write/act) needs a **new**
  proxy, since the existing auth proxy only forwards
  `cookie`/`origin`/`x-forwarded-for`/`content-type` — it does not forward
  `x-api-key` (checked directly against the file; it builds a fresh
  `Headers()` for the emailed-link/cookie flow specifically). **Shape
  (rev 2, corrected):** the phase 2-4 routes (`/me/timeline`, posts, follows,
  profile, admin) are all plain JSON REST with no framing concerns — one
  catch-all `web/src/routes/api/v1/[...path]/+server.ts`, same shape as the
  existing `/api/auth/[...path]` proxy, just forwarding `x-api-key` +
  `content-type` instead of `cookie` + `origin`. Core's `apiKeyAuth`
  enforces the actual permission check per-route regardless of how the
  request arrived, so a generic forwarder here is exactly as safe as the
  existing precedent. The **firehose** (`/api/v1/firehose/stream`) keeps its
  own bespoke proxy file, matching `web/src/routes/stream/+server.ts` — SSE
  framing genuinely differs from a JSON passthrough, the same reason that
  file is bespoke today.
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
- **`configId: 'admin'`** — never self-serve, never offered in the regular
  Settings panel. **Enforcement correction (rev 2):** the original design
  proposed a bespoke `requireAdmin()`-gated issuance *route* — but key
  management already rides the existing cookie-authed `/api/auth/*` proxy
  (see Namespace below), which forwards request bodies blindly with no
  path/body inspection, and better-auth's `createApiKey`/`updateApiKey`
  don't tie `configId`/`permissions` eligibility to caller identity the way
  `userId` is `@serverOnly` — so a route-based gate alone would be
  bypassable: any registered user could `POST` a `configId: 'admin'` key
  request through that same proxy today. The real boundary has to live
  **inside the plugin's own request path**, not beside it: a `before` hook
  on the `apiKey` plugin config (`core/src/auth.ts`) that rejects any
  `create`/`update` call requesting `configId: 'admin'` or any `admin.*`
  permission unless `deriveIsAdmin` (the same per-request check
  `sessionAuth` already runs) is true for the calling session. This is
  simpler than the route it replaces — no new endpoint, no second proxy path
  for admin keys — and it's the only place that's actually authoritative
  regardless of which proxy or client reached it. Permission vocabulary:
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

- **`POST /api/v1/me/posts`**, **`PATCH /api/v1/me/posts/:id`**, **`DELETE /api/v1/me/posts/:id`**
  — `apiKeyAuth({posts: ['write']})`.
- **`POST /api/v1/me/api-follows`**, **`DELETE /api/v1/me/api-follows/:target`**,
  **`POST /api/v1/me/api-subscriptions`**, **`DELETE /api/v1/me/api-subscriptions/:sourceId`**
  — `apiKeyAuth({follows: ['write']})`.
- **`PATCH /api/v1/me/api-profile`** — `apiKeyAuth({profile: ['write']})`. Handle changes
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
- **Admin key issuance** goes through the standard `authClient.apiKey.create`
  call (same as any user key), gated entirely by the plugin-level `before`
  hook described above — see rev 2's Enforcement correction under Key tiers.
  No separate issuance route. **Implementation deviation (rev 3):** this
  turned out not to work. better-auth's REST `/api-key/create` endpoint
  unconditionally strips/rejects any `permissions` field on a real HTTP call
  (`SERVER_ONLY_PROPERTY`, confirmed by reading the installed
  `@better-auth/api-key` source, and live during the final phase-4 review) —
  so a browser-originated `authClient.apiKey.create` can only ever mint an
  inert, permission-less key, admin or not. The shipped implementation adds a
  small server-only `POST /admin/api-keys` route instead: it runs behind the
  existing cookie-authed `/admin/*` gate (`sessionAuth` + `requireAdmin()`,
  mounted before this route — see app.ts), then calls the plugin's
  `createApiKey` **in-process** (no HTTP hop, so `SERVER_ONLY_PROPERTY` never
  triggers) with `configId: 'admin'` and the caller-supplied permissions,
  validated against a fixed `admin.*` whitelist. The plugin-level `before`
  hook described above stays in place unchanged — it is still the
  authoritative guard against a raw `/api-key/create` HTTP call requesting
  `configId: 'admin'` directly; this route is an *additional* path that
  exists only because the standard client-side call can't carry permissions
  at all. Don't restore the "no separate issuance route" design without
  re-solving the `SERVER_ONLY_PROPERTY` problem first.
- **Named consumer (rev 2):** RSC runs on multiple independent instances
  (four live Cloudron deployments as of this writing). An admin applying the
  same governance action (pause/block a misbehaving source, a moderation
  removal) across several instances today means logging into each one's
  `/admin` UI separately. A scripted admin client using one key per instance
  is the concrete driver for this tier — not symmetry with the user tier for
  its own sake.

## Key management UX

A new "API keys" panel in web Settings:

- **User tier:** list existing keys (name, prefix, created date, last used,
  permissions — never the key value itself after creation), create (name +
  checkbox-per-permission + optional expiry), revoke. Uses `authClient.
  apiKey.create/list/delete` directly — cookie-authed, existing `/api/auth/*`
  proxy, zero new web-to-core plumbing for this part.
- **Admin tier:** a separate admin-only panel (`/admin/api-keys`) for
  minting `configId: 'admin'` keys, with `admin.*` permission checkboxes.
  **Implementation deviation (rev 3):** does NOT call `authClient.
  apiKey.create` like the user panel — see the Implementation deviation note
  under Admin tier above for why that path can't carry permissions. Calls the
  server-only `POST /admin/api-keys` route instead, itself gated by the
  existing cookie-authed `/admin/*` middleware (not the plugin-level `before`
  hook, which stays as the guard against a direct API call).
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
plugin configuration, in exchange for admin-key issuance being gated inside
the plugin's own request path (a `before` hook re-checking `deriveIsAdmin`)
rather than trusted purely on a permission string ever having been granted.

## Revision history

- rev 1 (2026-08-01): initial design, from brainstorming — scope widened
  mid-conversation from "phase 1 (firehose + read-only) only" to the full
  4-phase architecture (firehose, read, write, admin) at the user's explicit
  request, reasoning that specifying the whole surface now avoids a redesign
  when write/admin phases land later. Implementation itself stays phased via
  the plan, not the spec.
- rev 2 (2026-08-01): folds ponytail-review + ponytail-audit findings
  (dispatched to two clean subagents in parallel, both verified claims
  against the installed better-auth version and the current tree rather than
  trusting the spec's own prose). Collapsed the phase 2-4 per-route-family
  web proxies into one catch-all (ponytail-review: no framing difference
  between them, unlike the firehose's SSE proxy, which stays bespoke). Fixed
  a real enforcement gap ponytail-audit found: the originally-proposed
  bespoke `requireAdmin()`-gated issuance route did NOT actually stop a
  non-admin from requesting `configId: 'admin'` through the existing generic
  auth proxy, since better-auth's `createApiKey`/`updateApiKey` don't tie
  `configId`/`permissions` eligibility to caller identity — replaced with a
  plugin-level `before` hook, the only boundary that's authoritative
  regardless of which proxy or client reached it (this also deleted a route
  the design turned out not to need). Named phase 4's concrete consumer
  (multi-instance admin scripting, ponytail-audit: previously the
  weakest-justified section, symmetry-with-phase-3 rather than a stated
  need). Added the CLAUDE.md-required stdlib/existing-dependency comparison
  for `@better-auth/api-key` (ponytail-review: the spec named the mechanism
  without showing that work, even though the reviewer expected it to
  survive the comparison).
- rev 3 (2026-08-05): records an implementation-time deviation found during
  phase 4's final whole-branch review. The rev 2 design ("no separate
  issuance route", Admin tier section) turned out to be unbuildable as
  written: better-auth's REST `/api-key/create` endpoint unconditionally
  rejects any `permissions` field on a real HTTP call
  (`SERVER_ONLY_PROPERTY`), so the standard `authClient.apiKey.create` path
  can only ever mint a permission-less admin key. Shipped a small
  server-only `POST /admin/api-keys` route instead, gated by the existing
  cookie-authed `/admin/*` middleware, calling the plugin's `createApiKey`
  in-process (no HTTP hop, so the server-only check never triggers). The
  plugin-level `before` hook from rev 2 is unaffected and still the
  authoritative guard on any direct HTTP attempt at `configId: 'admin'`. See
  the Implementation deviation note under Admin tier.
- rev 3 (2026-08-05): also corrects the Write endpoints section's illustrative
  paths to match the real shipped paths discovered during phase-3
  implementation — `/api/v1/me/posts` (not bare `/api/v1/posts`),
  `/api/v1/me/api-follows` and `/api/v1/me/api-subscriptions` (not bare
  `/api/v1/follows`), `/api/v1/me/api-profile` (not bare `/api/v1/me`). The
  naming changes come from real method+path collisions with existing
  cookie-authed siblings, verified live during phase-3 planning; see the
  naming rationale in `docs/superpowers/plans/2026-08-02-authed-write-api.md`'s
  Task descriptions for the concrete technical reason each one needed its
  alternate name.
