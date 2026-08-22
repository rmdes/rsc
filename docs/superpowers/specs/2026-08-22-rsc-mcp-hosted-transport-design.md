# RSC MCP hosted transport (phase 2, Track A) — Design

**Status:** rev 2 (2026-08-22). rev 1 was wrong in three places; see Revision history.

**Goal:** Serve RSC's existing MCP tool set over HTTP at `/mcp`, so a client
that cannot spawn a local process can reach an instance with an ordinary API
key.

Track B (npm publishing) is not in this spec.

## Background

Phase 1 (`docs/superpowers/specs/2026-08-08-rsc-mcp-server-design.md`, rev 5)
shipped `mcp/`: a stdio MCP server that is a thin client over `/api/v1`, with
three tools — `rsc_timeline`, `rsc_thread`, `rsc_post`. In use since
2026-08-14. `mcp/src/tools.ts` imports no transport; `mcp/src/stdio.ts` is the
only file that knows how bytes move. Track A adds a second entry beside it.

Verified against installed source and the repo on 2026-08-22:

| Fact | Where |
|---|---|
| `McpServerFactory = (ctx: McpRequestContext) => McpServer \| Server \| Promise<...>` | `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts:3808` |
| `McpRequestContext` carries `requestInfo?: Request` — "The original HTTP request being served" | same file, :3797 |
| `rscFetch` builds `${baseUrl}/api/v1${path}` | `mcp/src/tools.ts` |
| `rscFetch` sets `redirect: 'error'` | `mcp/src/tools.ts:262` |
| The v1 proxy strips `/api/v1`: `${CORE_API_URL}/${params.path}` | `web/src/routes/api/v1/[...path]/+server.ts:22` |
| Core mounts `/me/timeline` at root | `core/src/api/logical-routes/personal.ts:76` |
| Core reads `x-api-key` by hand, then `verifyApiKey({ body: { configId: 'user', key, permissions } })` | `core/src/api/auth.ts:99-101` |
| Per-key rate limit 300/hr | `core/src/auth.ts:107` |
| `web` reaches core via `CORE_API_URL` | `web/src/lib/server/session.ts:4` |
| `ORIGIN` is web's env var; `RSC_WEB_ORIGIN` is core's | `compose.prod.yaml:35` vs `:64`; `compose.yaml:29` is in the `core:` block |

## The inversion

Phase 1: the client owns N credentials and picks one with `as`.
Hosted: the server owns none, the caller presents one, the instance is fixed.

That is a **single-identity `Config`**, which `resolveIdentity` already handles
("one configured → use it"). `as` is vestigial on this path; the schema stays
shared with stdio rather than forking the tool definitions.

## Architecture

One new file: `web/src/routes/mcp/+server.ts`. No changes to `core/`.

```ts
const handler = createMcpHandler((ctx) => buildServer(configFor(ctx.requestInfo!)))
export const POST = ({ request }) => handler.fetch(request)
```

- **One module-level handler.** The factory receives per-request context, so
  the caller's credential is read from `ctx.requestInfo` at construction time.
  The SDK already builds a fresh `McpServer` per request; building a fresh
  *handler* would add nothing and would leak an event bus and keepalive timers
  whose `close()` nothing calls.
- **POST only.** Under the default `legacy: 'stateless'`, GET and DELETE are
  answered `405`. Exporting them would give an unauthenticated GET our `401`
  and an authenticated one the SDK's `405`.
- **`configFor`** reads `Authorization: Bearer <key>`, and returns a Config
  with one identity: `{ apiBase: CORE_API_URL, key }`.

### Upstream target: core directly

`rscFetch` hardcodes `/api/v1`, but core has no such prefix — the web proxy
strips it. Two consequences ruled out the alternative of looping back through
the instance's own public URL: that is a full round trip out through DNS, TLS
and the reverse proxy, and `redirect: 'error'` means any edge redirect
(http→https, canonical host) fails **every** tool call.

So the hosted path targets `CORE_API_URL`, and the `/api/v1` prefix moves out
of `rscFetch` into the identity:

- `Identity` gains `apiBase`. stdio sets it to `${instanceUrl}/api/v1`;
  hosted sets it to `CORE_API_URL`.
- `rscFetch` builds `${apiBase}${path}`.

This is a real change to `mcp/src/tools.ts` — roughly 15 lines including test
updates, done once. rev 1 avoided it by paying a public HTTP hop per tool
call, which was a false economy.

## Auth

`Authorization: Bearer <key>`, an ordinary key from `/settings/api-keys`.

Nothing about better-auth's configuration changes. Confirmed via the
better-auth MCP: the apiKey plugin's `apiKeyHeaders` option (default
`x-api-key`) is **not on our path** — core extracts the key by hand and passes
it as `body.key`, so better-auth never inspects a header. The
Bearer→`x-api-key` translation lives entirely in the new route.

That matters because reconfiguring `apiKeyHeaders` would mean a second
`apiKey()` call in `core/src/auth.ts`, which REPLACES the first (the plugin
registry keys on a fixed id). This design does not go near it.
`enableSessionForAPIKeys` stays `false`.

Inherited, not designed: per-key rate limiting (300/hr, inside `verifyApiKey`)
and per-tool permissions (each core route declares its own, so a
`timeline:read` key gets `401` from `rsc_post`).

## Rollout

Live on every instance, no flag. The endpoint is inert without a valid key.

## Error handling

| Condition | Result |
|---|---|
| No / malformed `Authorization` | `401`, no upstream call |
| Key rejected by core | core's `401` propagates |
| Rate limited | core's `429` propagates |
| Core unreachable | `rscFetch`'s existing `503` |

The key must never appear in a response body or a log line — asserted by a
test, not a comment.

## Testing

`web/src/routes/mcp/server.test.ts`, following
`web/src/routes/api/v1/[...path]/server.test.ts`:

- no header → `401`, upstream never called
- malformed header → `401`, upstream never called
- valid Bearer → upstream request carries `x-api-key`
- the key appears in no response body
- one tool call round-trips through the handler

Plus updates to `mcp/test/tools.test.ts` for the `apiBase` change.

## Risks

1. **Cross-workspace import.** `web` importing `mcp/`'s `.ts` sources through
   Vite is untested. `mcp/package.json` declares no `exports`, so a bare
   specifier falls back to legacy resolution. If it fails, a relative import
   from the route works — this does not gate the milestone.
2. **A new public surface on every deployment.** Unauthenticated requests
   reach the route before auth is checked; the check is first and cheap.

## Out of scope

npm publishing, OAuth, admin controls, new tools, changes to `core/`, a
hosted-only tool set.

## Revision history

- **rev 1** (2026-08-22) — initial design.
- **rev 2** (2026-08-22) — a ponytail-review found three factual errors in
  rev 1, all verified against source before folding:
  1. **"The factory takes no arguments" was false.** Taken from the SDK's
     published docs; the installed `.d.mts` says
     `(ctx: McpRequestContext) => ...`. rev 1's per-request handler
     construction existed only to work around a constraint that does not
     exist. Now one module-level handler.
  2. **The loopback hop was not local, and was broken.** `ORIGIN` /
     `RSC_WEB_ORIGIN` are public origins, so the container would call itself
     out through DNS/TLS/proxy — and with `redirect: 'error'` set, any edge
     redirect fails every tool call. Now targets `CORE_API_URL`, moving the
     `/api/v1` prefix into the identity.
  3. **`RSC_WEB_ORIGIN` is core-only.** rev 1 claimed it was set on both
     deployment paths; it is set in the `core:` service block. `web` gets
     `ORIGIN`. The variable and its fallback branch are gone.

  Also cut: the "Consumer" row (rationale, not a decision — the route is
  byte-identical either way), and six lines defending the vestigial `as`.
