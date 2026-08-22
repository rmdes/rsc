# RSC MCP hosted transport (phase 2, Track A) — Design

**Status:** rev 3 (2026-08-22). Two reviews; see Revision history.

**Goal:** Serve RSC's existing MCP tools over HTTP at `/mcp`, so a client that
cannot spawn a local process can reach an instance with an ordinary API key.

Track B (npm publishing) is not in this spec.

## Background

Phase 1 (`2026-08-08-rsc-mcp-server-design.md`, rev 5) shipped `mcp/`: a stdio
MCP server, thin client over `/api/v1`, three tools — `rsc_timeline`,
`rsc_thread`, `rsc_post`. In use since 2026-08-14. `tools.ts` imports no
transport; `stdio.ts` is the only file that knows how bytes move. This adds a
second entry beside it.

Hosted inverts phase 1's identity model: the server owns no credentials, the
caller presents one, the instance is fixed. That is a single-identity
`Config`, which `resolveIdentity` already handles. `as` is vestigial here; the
schema stays shared with stdio rather than forking the tool definitions.

Verified against installed source on 2026-08-22:

| Fact | Where |
|---|---|
| `McpServerFactory = (ctx: McpRequestContext) => …` | `@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts:3808` |
| `requestInfo?: Request`, set on both legs | same file `:3798`; `dist/index.mjs:973`, `:1261` |
| A factory throw returns 500, not 401 | `dist/index.mjs:1030`, `:1313` |
| GET/DELETE answer 405 under `legacy:'stateless'` | `createMcpHandler-CLhGwQTn.d.mts:3833-3839` |
| `rscFetch` builds `${baseUrl}/api/v1${path}` | `mcp/src/tools.ts:253` |
| `rscFetch` sets `redirect:'error'` | `mcp/src/tools.ts:262` |
| `Identity.url` is read at exactly three sites | `mcp/src/tools.ts:336,347,357` |
| v1 proxy strips the prefix | `web/src/routes/api/v1/[...path]/+server.ts:22` |
| Core mounts `/me/timeline` at root | `core/src/api/logical-routes/personal.ts:76` |
| Core reads `x-api-key` at :100, calls `verifyApiKey({body:{configId:'user',…}})` at :102 | `core/src/api/auth.ts` |
| Per-key rate limit 300/hr | `core/src/auth.ts:107` |
| `base()` returns `CORE_API_URL` | `web/src/lib/server/session.ts:4` |
| Cloudron image copies only root + `core/` + `web/` manifests before `npm ci` | `cloudron/Dockerfile:14-16` |

## Architecture

One new file: `web/src/routes/mcp/+server.ts`.

```ts
const handler = createMcpHandler((ctx) => buildServer(configFrom(ctx.requestInfo!)))

export const POST: RequestHandler = ({ request }) => {
  if (!bearer(request)) return new Response(null, { status: 401 })
  return handler.fetch(request)
}
```

- **Auth is checked in the route, before `handler.fetch`.** A factory throw
  returns 500, so the check cannot live inside `configFrom`. The factory
  re-reads the same header once the route has admitted the request.
- **One module-level handler.** The factory receives per-request context, so
  the credential is read from `ctx.requestInfo`. The SDK already builds a
  fresh `McpServer` per request.
- **POST only.** GET and DELETE answer 405 under the stateless default;
  exporting them would give an unauthenticated GET a 401 and an authenticated
  one a 405.
- `configFrom` returns a single-identity `Config`: `{ url: base(), key }`,
  reusing `base()` from `$lib/server/session`.

### Upstream target: core directly

`rscFetch` hardcodes `/api/v1`, which core does not have — the web proxy
strips it. Looping back through the instance's public origin was rejected:
that is a full DNS/TLS/reverse-proxy round trip, and `redirect:'error'` makes
any edge redirect fail every tool call.

So `Identity.url` becomes the **full API base** rather than the instance
origin. `loadConfig` appends `/api/v1` when parsing `RSC_IDENTITIES`; hosted
passes `base()` unchanged; `rscFetch` builds `${baseUrl}${path}`. One field,
not two — nothing reads the bare origin.

Cost: two lines in `tools.ts` plus test expectations.

## Auth

`Authorization: Bearer <key>`, an ordinary key from `/settings/api-keys`.
Core extracts the key by hand and passes it as `body.key`, so better-auth
never inspects a header — the Bearer→`x-api-key` translation lives entirely in
the route, and `core/src/auth.ts` is untouched.

Inherited, not designed: per-key rate limiting (300/hr) and per-tool
permissions (a `timeline:read` key is refused by `rsc_post`).

## Build and rollout

Live on every instance, no flag; inert without a valid key.

**This is not free at the build layer.** Two changes are required:

1. `cloudron/Dockerfile` must `COPY mcp/package.json mcp/package.json` before
   `npm ci`, or the production image — the deployment path for every live
   instance — installs no MCP SDK.
2. `web/package.json` should declare `@modelcontextprotocol/server` and `zod`
   explicitly. They currently resolve only because they are hoisted from
   `mcp/`, which works by accident in dev and in `docker/Dockerfile.web`.

## Error handling

| Condition | Result |
|---|---|
| No / malformed `Authorization` | HTTP `401`, no upstream call |
| Key rejected, rate limited, core unreachable | in-band tool error (`isError: true`) inside an HTTP `200` JSON-RPC response |

The route's own 401 is the only genuine HTTP status it emits.

**Known leak:** with the base now `http://core:8787`, `rscFetch`'s error
strings put the internal address in tool output, and its 401 message tells the
caller to check `RSC_IDENTITIES` — an env var a hosted caller has never seen.
Accepted for now, recorded so it is a decision rather than an oversight.

The key must never appear in a response body or a log line — asserted by a
test.

## Testing

`web/src/routes/mcp/server.test.ts`, following
`web/src/routes/api/v1/[...path]/server.test.ts`:

- no header → `401`, upstream never called
- malformed header → `401`, upstream never called
- valid Bearer → a tool call round-trips and the upstream request carries
  `x-api-key`; the key appears in no response body

Plus `mcp/test/tools.test.ts` updates for the `url`-is-now-the-API-base change.

## Risks

1. **Cross-workspace import.** `@rsc/mcp` declares no `exports` or `main`, so
   the import must be a deep path (`@rsc/mcp/src/tools.ts`); the symlink
   exists at `node_modules/@rsc/mcp`. If Vite refuses it, a relative import
   works. Does not gate the milestone.
2. **A new public surface on every deployment.** Unauthenticated requests
   reach the route before auth; the check is first and cheap.

## Out of scope

npm publishing, OAuth, admin controls, new tools, changes to `core/`, a
hosted-only tool set.

## Revision history

- **rev 1** — initial design.
- **rev 2** — first review found three factual errors: the factory does take a
  context argument; the loopback was a public round trip broken by
  `redirect:'error'`; `RSC_WEB_ORIGIN` is core's variable, not web's.
- **rev 3** — second review found one error rev 2 introduced and two omissions.
  Auth in the factory returns 500, not 401, so it moves to the route.
  `Identity` keeps one url field instead of gaining `apiBase`. The Cloudron
  image never copies `mcp/package.json`, so rollout requires a build change.
  Also corrected an `auth.ts` citation and cut ~25 lines of prose defending
  decisions rather than stating them.
