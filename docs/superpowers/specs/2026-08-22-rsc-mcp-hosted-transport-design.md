# RSC MCP hosted transport (phase 2, Track A) — Design

**Status:** rev 1 (2026-08-22).

**Goal:** Let any RSC instance serve MCP over HTTP at `/mcp`, so its users can
point an MCP client at their own instance with their own API key — without
cloning the repo or running a local stdio process.

This is Track A of the phase 2 named in
`docs/superpowers/specs/2026-08-08-rsc-mcp-server-design.md`. Track B (npm
publishing) is deliberately not in this spec: it is a separate decision about
whether this repo grows its first build pipeline.

## Background — what phase 1 established

Phase 1 shipped `mcp/`, a stdio MCP server that is a thin client over
`/api/v1`. Three tools: `rsc_timeline`, `rsc_thread`, `rsc_post`. It has been
in real use since 2026-08-14.

The seam it was built around is the reason this spec is short: `mcp/src/tools.ts`
imports no transport, and `mcp/src/stdio.ts` is the only file that knows how
bytes move. Track A adds a second entry beside it.

Verified against the code on 2026-08-22 (not recalled):

| Fact | Where |
|---|---|
| Every tool handler takes `(args, cfg: Config)` | `mcp/src/tools.ts` — `toolHandlers` |
| `buildServer(cfg)` closes over that `Config` | `mcp/src/tools.ts` |
| `resolveIdentity` returns the sole identity when one is configured | `mcp/src/tools.ts` |
| Core reads the key by hand from `x-api-key`, then calls `verifyApiKey({body:{key}})` | `core/src/api/auth.ts:99` |
| Per-key rate limit is 300 req/hr | `core/src/auth.ts:107` |
| The v1 proxy builds `${CORE_API_URL}/${params.path}` — the `/api/v1` prefix is STRIPPED | `web/src/routes/api/v1/[...path]/+server.ts:22` |
| `web` reaches core via `CORE_API_URL` | `web/src/lib/server/session.ts:4` |

And against the SDK docs: `createMcpHandler(factory, options)` returns
`{fetch, close, notify, bus}`, and **the factory takes no arguments** —
per-request state arrives either via `handler.fetch(request, {authInfo})` or
by constructing the handler per request.

## The central inversion

Phase 1's identity model is *the client owns N credentials and picks one with
`as`*. Hosting inverts it: **the server owns none, the caller presents one,
and the instance is fixed.**

That is exactly a **single-identity `Config`**. Because `resolveIdentity`
already treats one configured identity as the default, the inversion needs no
special casing and **no change to `mcp/src/tools.ts`**.

Consequence worth stating: on a hosted endpoint the `as` argument is
vestigial. It stays in the schema (the tools are shared with stdio), and a
caller passing an unknown value gets the ordinary "Unknown identity" error.
This is accepted as cosmetic rather than papered over with a second schema —
a hosted-only tool set would be a fork of the definitions, which is the twin-
drift problem this repo already fights elsewhere.

## Scope decisions

| Decision | Chosen | Rejected |
|---|---|---|
| Consumer | other instances' users, self-serve | just rmdes from claude.ai; generic-client-first |
| Credential | `Authorization: Bearer <key>` | `x-api-key`; accepting both; full OAuth |
| Rollout | on by default, key-gated | env flag off by default; admin UI setting |
| Handler lifetime | constructed per request | module-level handler + `authInfo` plumbing |
| Upstream target | loopback via the instance's own `/api/v1` | core directly (needs a `tools.ts` change) |

"Accepting both headers" was rejected for the same reason phase 1 cut
`RSC_DEFAULT_IDENTITY` and `RSC_API_KEY`: a second path to the same outcome is
where ambiguity lives.

## Architecture

One new file: **`web/src/routes/mcp/+server.ts`**. No changes to `core/`. No
changes to `mcp/src/tools.ts`.

Request flow:

1. Read `Authorization: Bearer <key>`. Missing or malformed -> `401`, before
   any MCP machinery runs.
2. Build a single-identity `Config`: `{ identities: Map([['self', { url, key }]]) }`.
3. `createMcpHandler(() => buildServer(cfg))`, then `handler.fetch(request)`.
   The handler is built per request because the factory takes no arguments;
   that is what lets a per-caller credential work without changing any tool
   handler's signature.
4. Delegate every HTTP method to `handler.fetch` — the SDK routes protocol
   methods itself.

### Why `url` is the instance's own origin, not `CORE_API_URL`

`rscFetch` builds `${baseUrl}/api/v1${path}`, but core has no `/api/v1`
prefix — the v1 proxy strips it. Pointing the hosted handler at
`CORE_API_URL` would request `${CORE}/api/v1/me/timeline` and 404.

So `url` is the instance's own public origin, and tool calls loop back
through its existing `/api/v1` proxy. Cost: one extra local HTTP hop per tool
call. Benefit: `mcp/src/tools.ts` is provably untouched, so the stdio server
cannot regress.

**Which origin, precisely:** `RSC_WEB_ORIGIN` when set, falling back to the
request's `url.origin`. Not `url.origin` alone — behind a reverse proxy that
reflects the internal address unless the adapter's `ORIGIN` is configured.
`RSC_WEB_ORIGIN` is already set on both deployment paths (`compose.yaml:29`
for dev, `cloudron/start.sh:37` in production), so it is the reliable source
and `url.origin` is only the fallback for anyone running without it.

The alternative — factoring the `/api/v1` prefix out of `rscFetch` so the
hosted path can target core directly — saves the hop but changes a function
every phase-1 test exercises. That is an optimisation for after this ships,
not part of it.

## Auth

`Authorization: Bearer <key>`, where the key is an ordinary key minted at
`/settings/api-keys`. Nothing about better-auth's configuration changes.

Confirmed via the better-auth MCP rather than from memory: the apiKey plugin
exposes an `apiKeyHeaders` option (default `x-api-key`), but it is **not on
our path**. Core extracts the key by hand and passes it as `body.key` to
`verifyApiKey`, so better-auth never inspects a request header. The
Bearer-to-`x-api-key` translation therefore lives entirely in the new route:
`/mcp` reads Bearer, and `rscFetch` sends `x-api-key` onward because that is
what core reads.

This matters because reconfiguring `apiKeyHeaders` would mean touching
`core/src/auth.ts`'s `apiKey()` call, and a second `apiKey()` call REPLACES
the first (the plugin registry keys on a fixed id). This design does not go
near it.

`enableSessionForAPIKeys` stays `false`, as it is today — better-auth's own
docs flag it as an impersonation risk.

Two properties are inherited rather than designed, because tool calls ride the
same routes as phase 1:

- **Rate limiting**: 300 requests/hour per key, enforced inside `verifyApiKey`.
- **Permissions**: each core route declares what it requires, so a key scoped
  to `timeline:read` reads timelines and gets `401` from `rsc_post`.

## Rollout

Live on every instance by default. The endpoint is inert without a valid key —
no key, `401`, nothing reachable — so there is no flag to set and none to
forget. Self-serve users get it when their operator upgrades, which is the
point of the chosen consumer.

## Error handling

| Condition | Result |
|---|---|
| No `Authorization` header | `401`, no upstream call |
| Malformed header (not `Bearer <token>`) | `401`, no upstream call |
| Key rejected by core | core's `401` propagates through `rscFetch`'s mapping |
| Rate limited | core's `429` propagates, with its existing message |
| Core unreachable | `rscFetch`'s existing `503` wording |

The key must never appear in a response body, an error message, or a log
line. This is asserted by a test, not by a comment.

## Testing

`web/src/routes/mcp/server.test.ts`, following the existing
`web/src/routes/api/v1/[...path]/server.test.ts` pattern:

- no `Authorization` header -> `401`, and the upstream fetch is never called
- malformed header -> `401`, upstream never called
- valid Bearer -> the upstream request carries `x-api-key` with that key
- the key appears in no response body
- a tool call round-trips: `rsc_timeline` through the handler produces the
  rendered timeline

## Risks and unknowns

1. **Cross-workspace import — unverified.** `web` must import `mcp/`'s `.ts`
   sources through Vite, which means adding `@rsc/mcp` as a workspace
   dependency and pulling `@modelcontextprotocol/server` + `zod` into web's
   tree. Whether Vite resolves a cross-workspace `.ts` specifier cleanly has
   NOT been tested. This is task 1 of the plan, as a probe — the same shape as
   phase 1's import probe, which existed for the same reason.

   Note that `mcp/package.json` currently declares **no `exports` field**
   (checked). Bare-specifier subpath imports therefore fall back to legacy
   resolution, which may work but is not a stated contract. If the probe needs
   one, adding an `exports` entry to `mcp/package.json` is in scope — the
   "no changes" claim above is specifically about `mcp/src/tools.ts`, whose
   contents must not change, not about the workspace's manifest.
2. **A new public surface on every deployment.** Unauthenticated requests
   reach the route before auth is checked. The mitigation is that the check is
   first and cheap, but this is a real change in exposure from phase 1, which
   had no server-side footprint at all.
3. **The loopback hop** doubles the request count per tool call against the
   instance's own web tier. Acceptable at expected volume; measure before
   optimising.

## Out of scope

npm publishing (Track B), OAuth, admin UI controls for the endpoint, any new
tool, and any change to `core/`. A hosted-only tool set is explicitly rejected
above.

## Revision history

- **rev 1** (2026-08-22) — initial design, from brainstorming with rmdes.
  Two findings shaped it: the single-identity inversion (which is why
  `tools.ts` needs no change), and the `/api/v1` prefix mismatch (which is why
  the upstream target is the instance's own origin rather than `CORE_API_URL`).
