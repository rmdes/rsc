# Dev-only better-auth OpenAPI reference — design

**Date:** 2026-07-19
**Status:** approved (design); pending implementation plan
**Revisions:** rev 1 (2026-07-19) — folded cold ponytail-review
(`docs/superpowers/reviews/2026-07-19-auth-openapi-review.md`): core test now
asserts the flag toggles our conditional, not better-auth's schema output.
Review verdict otherwise "already minimal — ship."
**Building block:** better-auth `openAPI()` plugin (promoted from `ideas.md`
2026-07-19 audit)

## Goal

Give developers a live, auto-generated reference for the better-auth HTTP
surface (`/api/auth/*` — sign-in/up, verify, magic-link, reset, anonymous, and
any future plugin routes) to aid work on the web auth proxy and future auth
features — **without ever exposing it publicly**.

## The boundary problem (why this needs a design)

`openAPI()` registers its routes *under* the auth base path: a Scalar
"try-it-out" UI at `/api/auth/reference` and a spec endpoint at
`/api/auth/open-api/generate-schema`. Two existing invariants make a naive
`plugins: [openAPI()]` dangerous:

- Core mounts the whole auth surface with
  `app.on(['GET','POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw))`
  (`core/src/api/app.ts`), so the plugin's routes go live automatically.
- The web app proxies **all** of `/api/auth/*` to the browser
  (`web/src/routes/api/auth/[...path]/+server.ts`) and Caddy exposes web
  publicly. That proxy is load-bearing (emailed GET links need an injected
  `Origin`) — CLAUDE.md invariant.

Result of a naive add: a public, interactive auth-endpoint console at
`https://<instance>/api/auth/reference`. Unacceptable. The design keeps it
**dev-only** with two independent guards.

## Design

### 1. Enablement flag (`core/src/config.ts`)

Add `authOpenApi: boolean`, parsed from `TEXTCASTER_AUTH_OPENAPI` as
`'on'`/`'off'` with **default `'off'`**, following the existing `rssCloud` /
`pushIn` pattern exactly (validate the raw value; throw on anything else).
Thread it into `createAuth`'s deps alongside the other auth config.

Prod (`compose.prod.yaml`) and Cloudron do not set it → the flag is off →
the plugin is never registered there.

No DB migration: the open-api plugin adds no tables (contrast passkey).

### 2. Plugin registration (`core/src/auth.ts`)

When `deps.authOpenApi` is true, append `openAPI()` to the `plugins` array.
Leave the default Scalar reference UI enabled (`disableDefaultReference`
stays default `false`) — it is dev-only, reached by hitting core directly at
`http://localhost:8787/api/auth/reference` inside the Docker dev network. No
new core route is needed; the existing `/api/auth/*` mount routes the plugin's
endpoints through `auth.handler`. The `MAIL_GATED` set does not include these
paths, so they are unaffected.

### 3. Defense-in-depth denylist (`web/src/routes/api/auth/[...path]/+server.ts`)

At the top of `proxy`, return **404** (not 403 — do not confirm the route
exists) for any request whose `params.path` is `reference` or starts with
`open-api/`, in **every** environment regardless of the core flag. This is the
belt to the flag's suspenders: even a misconfigured `TEXTCASTER_AUTH_OPENAPI=on`
in production cannot leak the docs through the public web app. A single
misconfiguration cannot expose the surface; both guards must fail.

### 4. Compose wiring

Set `TEXTCASTER_AUTH_OPENAPI=on` in `compose.yaml` (dev) only. Leave it out of
`compose.prod.yaml` and the Cloudron manifest. Document the dev URL in
`README.md` / RUNNING.md as a dev affordance.

## New boundary invariant (to record in CLAUDE.md)

> `/api/auth/reference` and `/api/auth/open-api/*` are dev-only and never
> public — the core flag defaults off in prod **and** the web proxy hard-404s
> them. Both guards are load-bearing; keep both.

## Testing

- **core** (`core/test/`): assert only that the flag toggles *our* conditional,
  not better-auth's schema output (which is better-auth's to test) — with the
  flag on, `auth.api.generateOpenAPISchema` is defined; with it off, it is
  undefined. Two cheap truthy checks. *(rev 1)*
- **web (security-critical)** (`web/src/routes/…`): the proxy returns **404**
  for `GET /api/auth/reference` and `GET /api/auth/open-api/generate-schema`
  even when the upstream core would serve them — proves the public surface
  cannot leak the docs. This test is the real guarantee; it must not depend on
  the core flag's value.
- Run `tsc --noEmit` / `svelte-check` (native type-stripping means vitest
  passes on type errors — testing-gotchas memory).

## Out of scope

- Serving the reference in production (rejected: the access model is dev-only).
- Documenting the non-auth core API (feeds/timeline) — this spec covers only
  the better-auth surface.
- The other promoted plugins (passkey, multi-session) — separate specs.

## Grounding

- `core/src/auth.ts` — `createAuth`, current plugins (`magicLink`, `anonymous`).
- `core/src/config.ts` — `rssCloud`/`pushIn` on/off flag pattern to mirror.
- `core/src/api/app.ts` — `/api/auth/*` mount, `MAIL_GATED`.
- `web/src/routes/api/auth/[...path]/+server.ts` — the load-bearing proxy.
- better-auth `openAPI()` doc (via better-auth MCP): serves Scalar at
  `/api/auth/reference`, `auth.api.generateOpenAPISchema()`, config
  `path`/`disableDefaultReference`/`theme`/`nonce`.
