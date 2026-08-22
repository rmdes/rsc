# RSC MCP Hosted Transport (Phase 2, Track A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve RSC's three existing MCP tools over HTTP at `POST /mcp` in the
web workspace, authenticated by an ordinary RSC API key presented as
`Authorization: Bearer <key>`.

**Architecture:** One new SvelteKit route (`web/src/routes/mcp/+server.ts`)
holds a single module-level `createMcpHandler`. The handler's factory builds a
fresh `McpServer` per request from `@rsc/mcp/src/tools.ts`'s existing
`buildServer`, reading the caller's key from `ctx.requestInfo`. Auth is checked
in the route *before* `handler.fetch`, because a factory throw is answered
`500` by the SDK. `Identity.url` changes meaning from "instance origin" to
"full API base" so the hosted route can point straight at core.

**Tech Stack:** SvelteKit (adapter-node), `@modelcontextprotocol/server@2.0.0`,
`zod@^4` (`zod/v4`), vitest, Node 22 native type stripping (`mcp/`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-22-rsc-mcp-hosted-transport-design.md` (rev 3).
- **Do not regress phase 1.** `mcp/src/stdio.ts` is in daily use. It must keep working unchanged.
- **No new dependencies.** `@modelcontextprotocol/server` and `zod` already exist in `mcp/`; this plan only *declares* them in `web/`.
- **`core/` is not touched.** The Bearer→`x-api-key` translation lives entirely in the web route.
- **Shared checkout:** NEVER `git add -A`. Stage explicit paths only.
- **Every commit message ends with the line:** `developed with the help of AI tools`
- **Tests run in the container** while the dev stack is up: `docker compose exec -T web npx vitest run <path>` and `docker compose exec -T core npx vitest run <path>`. Host `npm test -w core` fails EACCES.
- **`mcp/` has no build step** — native type stripping. No TypeScript parameter properties.
- Ponytail ladder governs all code: shortest diff that actually works.

## Verified facts (re-checked against installed source on 2026-08-22)

Every claim below was opened in this session. Spec rev 3's fact table was
confirmed; the last four rows are **new** — empirically probed, absent from the
spec, and each one would otherwise burn an implementer.

| Fact | Evidence |
|---|---|
| `McpServerFactory = (ctx: McpRequestContext) => …` | `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts:3808` |
| `requestInfo?: Request` on `McpRequestContext` | same file `:3797-3798` |
| `requestInfo` is set on **both** legs | `dist/index.mjs:972` (legacy), `:1261` (modern) |
| A factory throw → **500** | factory at `index.mjs:1258` sits outside the `invoke` try (`:1298`); it unwinds to `handle`'s try (`:1339`) → catch (`:1347`) → `internalServerErrorResponse` (`:1349`) → `jsonRpcErrorResponse(500, -32603, …)` (`:945`) |
| GET/DELETE → `405` | `index.mjs:968`; probed: GET returns 405 |
| `rscFetch` builds `${baseUrl}/api/v1${path}` | `mcp/src/tools.ts:253` |
| `rscFetch` sets `redirect:'error'` | `mcp/src/tools.ts:262` |
| `Identity.url` read at exactly 3 sites, all as `rscFetch`'s `baseUrl` | `mcp/src/tools.ts:336,347,357` — **none of them change** |
| `loadConfig` normalises url at | `mcp/src/tools.ts:65` |
| `buildServer(cfg: Config): McpServer` | `mcp/src/tools.ts:402` |
| `base()` returns `CORE_API_URL ?? 'http://localhost:8787'` | `web/src/lib/server/session.ts:4` |
| Cloudron image copies only root + `core/` + `web/` manifests | `cloudron/Dockerfile:14-16` |
| `mcp` IS a declared workspace | `package.json` → `"workspaces": ["core","web","mcp"]`; symlink `node_modules/@rsc/mcp` exists |
| **NEW — the deep import already works.** `import { buildServer } from '@rsc/mcp/src/tools.ts'` resolved in web's vitest and `buildServer` constructed | probed in-container this session; spec Risk 1 is **closed**, no relative-import fallback needed |
| **NEW — `Accept` must list BOTH types.** `application/json` alone → **406** `"Client must accept both application/json and text/event-stream"` | probed |
| **NEW — the response is SSE, not JSON.** `content-type: text/event-stream`, body `event: message\ndata: {…}\n\n`. `await res.json()` **throws** | probed |
| **NEW — wrong/missing `content-type` → 415** before anything else | `index.mjs:1328-1331`; probed |
| **NEW — no initialize handshake needed.** A bare `tools/call` POST is served 200 by the legacy stateless leg | probed |
| **NEW — no Host/Origin validation by default.** `CreateMcpHandlerOptions` has no such field; `validateHostHeader`/`validateOriginHeader` are separate opt-in exports | `createMcpHandler-CLhGwQTn.d.mts:3828-3889` |

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `mcp/src/tools.ts` | MODIFY (2 lines): `Identity.url` becomes the full API base | 1 |
| `mcp/test/tools.test.ts` | MODIFY: expectations for the new url semantics | 1 |
| `web/package.json` | MODIFY: declare `@modelcontextprotocol/server` + `zod` | 2 |
| `cloudron/Dockerfile` | MODIFY: `COPY mcp/package.json` before `npm ci` | 2 |
| `web/src/routes/mcp/+server.ts` | CREATE: the hosted transport — auth guard + handler | 3 |
| `web/src/routes/mcp/server.test.ts` | CREATE: 401 paths, round-trip, key-never-leaks | 3 |
| `README.md` / `docs/api/API.md` | MODIFY: document the hosted endpoint | 4 |

---

### Task 1: `Identity.url` becomes the full API base

`rscFetch` hardcodes `/api/v1`, a prefix that exists only on web's proxy — core
mounts `/me/timeline` at root. The hosted route must reach core directly, so
the prefix moves out of `rscFetch` and into `loadConfig`, where the stdio entry
(which does talk to the public origin) still gets it.

Net effect for stdio: **identical absolute URLs as before.** This is a pure
refactor from stdio's point of view, and Step 6 pins that.

**Files:**
- Modify: `mcp/src/tools.ts:65` (loadConfig), `mcp/src/tools.ts:253` (rscFetch)
- Test: `mcp/test/tools.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Identity { url: string; key: string }` where `url` is now the **full API base** (origin + `/api/v1` for stdio; a bare core origin for hosted). `rscFetch(baseUrl: string, path: string, opts?: FetchOpts)` now fetches `${baseUrl}${path}`. `buildServer(cfg: Config): McpServer` is unchanged — Task 3 calls it.

- [ ] **Step 1: Write the failing tests**

Edit `mcp/test/tools.test.ts`. Change these existing expectations (line numbers
from the current file; re-open before relying on them):

At `describe('loadConfig')` — "parses an identity per instance":

```ts
  it('parses an identity per instance', () => {
    const cfg = loadConfig({ RSC_IDENTITIES: TWO })
    expect(cfg.identities.get('be')).toEqual({ url: 'https://rsc.rmdes.be/api/v1', key: 'k-be' })
    expect(cfg.identities.get('net')).toEqual({ url: 'https://rsc.rmendes.net/api/v1', key: 'k-net' })
  })

  it('strips a trailing slash from each url before appending the api base', () => {
    const cfg = loadConfig({ RSC_IDENTITIES: JSON.stringify({ me: { url: 'https://rsc.example/', key: 'k1' } }) })
    expect(cfg.identities.get('me')!.url).toBe('https://rsc.example/api/v1')
  })
```

In `describe('resolveIdentity')`:

```ts
  it('uses the only identity when as is omitted', () => {
    expect(resolveIdentity(one, undefined)).toEqual({ url: 'https://rsc.example/api/v1', key: 'k1' })
  })
```

```ts
  it('resolves a named identity to its own instance and key', () => {
    expect(resolveIdentity(two, 'net')).toEqual({ url: 'https://rsc.rmendes.net/api/v1', key: 'k-net' })
  })
```

Change the `BASE` constant (currently `const BASE = 'https://rsc.example'`) to
the full API base, since `rscFetch` no longer adds the prefix:

```ts
const BASE = 'https://rsc.example/api/v1'
```

Replace the `rscFetch` prefix test with one asserting verbatim concatenation,
and add a composition regression guard:

```ts
  it('appends the path to the base verbatim and sends no key when none is given', async () => {
    const spy = stubFetch(200, { ok: true })
    await rscFetch(BASE, '/post/li_1/thread')
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://rsc.example/api/v1/post/li_1/thread')
    expect(new Headers(init.headers).has('x-api-key')).toBe(false)
  })

  // Regression guard: stdio's absolute URLs must be byte-identical to what
  // they were before the prefix moved out of rscFetch and into loadConfig.
  it('composes with loadConfig to the same absolute url as before the move', async () => {
    const spy = stubFetch(200, { ok: true })
    const cfg = loadConfig({ RSC_IDENTITIES: JSON.stringify({ me: { url: 'https://rsc.example', key: 'k1' } }) })
    const id = resolveIdentity(cfg, undefined) as { url: string; key: string }
    await rscFetch(id.url, '/me/timeline', { key: id.key })
    expect(spy.mock.calls[0][0]).toBe('https://rsc.example/api/v1/me/timeline')
  })

  // The hosted transport passes a bare core origin (no /api/v1): core mounts
  // /me/timeline at root. Same helper, no special case.
  it('supports a base with no /api/v1 segment (the hosted transport case)', async () => {
    const spy = stubFetch(200, { ok: true })
    await rscFetch('http://core:8787', '/me/timeline', { key: 'k' })
    expect(spy.mock.calls[0][0]).toBe('http://core:8787/me/timeline')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
docker compose exec -T core npx vitest run --root /app/../mcp 2>/dev/null || npx vitest run --root mcp
```

If neither runs cleanly, use the workspace script from the repo root:

```bash
npm test -w mcp
```

Expected: FAIL — several assertions report the received url lacking `/api/v1`
(loadConfig) or carrying a doubled `/api/v1` (rscFetch with the new `BASE`).

- [ ] **Step 3: Make the change in `mcp/src/tools.ts`**

At `loadConfig`, line 65 — append the API base once, at parse time:

```ts
    // `url` is the FULL API BASE, not the instance origin. The stdio entry
    // points at a public instance, whose MCP-reachable REST surface is web's
    // /api/v1 proxy; the hosted transport (web/src/routes/mcp/+server.ts)
    // passes core's origin unprefixed, because core mounts /me/timeline at
    // root. One field, resolved by whoever builds the Config — rscFetch just
    // concatenates. Nothing reads the bare origin.
    identities.set(name, { url: `${v.url.trim().replace(/\/+$/, '')}/api/v1`, key: v.key.trim() })
```

At `rscFetch`, line 253 — concatenate verbatim:

```ts
    res = await fetch(`${baseUrl}${path}`, {
```

Also update the `Identity` interface comment (line 13-16) so the meaning is
documented where the type is declared:

```ts
export interface Identity {
  /** Full API base — origin PLUS any REST prefix. Paths are appended verbatim. */
  url: string
  key: string
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w mcp
```

Expected: PASS, all tests. Note the two tests at the bottom of the file that
assert `'/api/v1/me/timeline'` via `cfgOne`/`cfgTwo` — those build their Config
through `loadConfig`, so they must stay green **unchanged**. If they fail, the
prefix moved to the wrong place.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck -w mcp
```

Expected: no output, exit 0. (Native type stripping means vitest passes on type
errors — this gate is not optional.)

- [ ] **Step 6: Prove stdio did not regress**

`RSC_IDENTITIES` for a real instance must still produce the same absolute URL.
Run the server and confirm it starts and lists tools:

```bash
RSC_IDENTITIES='{"me":{"url":"https://rsc.rmdes.be","key":"rsc_not_a_real_key"}}' \
  node --input-type=module -e '
    import { loadConfig } from "./mcp/src/tools.ts";
    const c = loadConfig(process.env);
    console.log(c.identities.get("me").url);
  '
```

Expected output: `https://rsc.rmdes.be/api/v1`

- [ ] **Step 7: Commit**

```bash
git add mcp/src/tools.ts mcp/test/tools.test.ts
git commit -m "$(cat <<'EOF'
refactor(mcp): Identity.url is the full API base, not the instance origin

rscFetch hardcoded /api/v1 — a prefix that exists only on web's proxy, not
on core, which mounts /me/timeline at root. The hosted transport talks to
core directly, so the prefix moves to loadConfig (where stdio still gets it)
and rscFetch concatenates verbatim. stdio's absolute URLs are unchanged;
a composition test pins that.

developed with the help of AI tools
EOF
)"
```

---

### Task 2: Build-layer prerequisites

Two changes with no runtime behaviour of their own, both of which the hosted
route silently depends on. Without #1 the **production image for all five live
instances** ships without the MCP SDK and the web build fails or the route
500s. Without #2 web's imports resolve only by npm hoisting from `mcp/` — true
today by accident, false the moment `mcp/` drops either dependency.

**Files:**
- Modify: `web/package.json` (dependencies block)
- Modify: `cloudron/Dockerfile:14-16`

**Interfaces:**
- Consumes: nothing.
- Produces: `@modelcontextprotocol/server` and `zod` importable from `web/` by declaration rather than by hoisting; `mcp/`'s manifest present at `npm ci` time in the Cloudron image.

- [ ] **Step 1: Declare the dependencies in `web/package.json`**

Add to the `"dependencies"` block, keeping it alphabetically sorted (the block
currently starts with `@cartamd/plugin-emoji`; `@modelcontextprotocol/server`
sorts after it, and `zod` goes last):

```json
		"@cartamd/plugin-emoji": "4.3.0",
		"@cartamd/plugin-slash": "4.2.0",
		"@modelcontextprotocol/server": "2.0.0",
		"carta-md": "^4.11.2",
```

and at the end of the same block:

```json
		"unist-util-visit": "5.1.0",
		"zod": "^4.4.3"
```

Pin `@modelcontextprotocol/server` to the exact same `2.0.0` as `mcp/`, and
`zod` to the same `^4.4.3` range. Two workspaces resolving the same package to
different versions would give the route a different `McpServer` class than
`buildServer` constructs.

- [ ] **Step 2: Verify the lockfile is unchanged by the declaration**

```bash
npm install --package-lock-only && git diff --stat package-lock.json
```

Expected: `package-lock.json` gains only `web`'s two new dependency entries —
**no version changes** to `@modelcontextprotocol/server` or `zod` themselves.
If a version moves, pin harder until it does not.

- [ ] **Step 3: Copy `mcp/package.json` in the Cloudron image**

Edit `cloudron/Dockerfile`. After line 16 (`COPY web/package.json web/package.json`):

```dockerfile
COPY package.json package-lock.json ./
COPY core/package.json core/package.json
COPY web/package.json web/package.json
# mcp/ is a declared workspace (root package.json) and web's /mcp route imports
# @rsc/mcp/src/tools.ts. Without this manifest `npm ci` installs none of mcp's
# dependencies, so the production image — the deployment path for every live
# instance — would ship without the MCP SDK.
COPY mcp/package.json mcp/package.json
```

- [ ] **Step 4: Verify the image actually installs the SDK**

This is the gate that matters; do not skip it on the grounds that the edit
"obviously works". Build to the install layer only:

Build the image from the repo root (never from `cloudron/` — and never
symlink `CloudronManifest.json`/`logo.png`, they are tracked files):

```bash
docker build -f cloudron/Dockerfile -t rsc-mcp-buildcheck . 2>&1 | tail -30
```

Then confirm the SDK actually landed in the image:

```bash
docker run --rm rsc-mcp-buildcheck ls /app/code/node_modules/@modelcontextprotocol/server/package.json
```

Expected: the path prints.

This build is slow (full workspace install + web build). If it cannot be run
here, the minimum acceptable substitute is to prove the dependency directly —
show that `npm ci` under-installs without the manifest, e.g. by staging the
same COPY set into a scratch dir and running `npm ci` there both ways. Record
whichever you actually ran, with its output, in the report. **Do not report
this step complete on a `grep` of the Dockerfile alone** — the whole point of
the task is that the edit is invisible until an image is built.

- [ ] **Step 5: Commit**

```bash
git add web/package.json package-lock.json cloudron/Dockerfile
git commit -m "$(cat <<'EOF'
build: declare mcp's deps in web, and copy mcp/package.json in the image

web's /mcp route imports @rsc/mcp/src/tools.ts, so it needs
@modelcontextprotocol/server and zod — which until now resolved only by
hoisting from mcp/. The Cloudron image never copied mcp/package.json before
`npm ci`, so the production image for every live instance would install no
MCP SDK at all.

developed with the help of AI tools
EOF
)"
```

---

### Task 3: The `/mcp` route

**Files:**
- Create: `web/src/routes/mcp/+server.ts`
- Create: `web/src/routes/mcp/server.test.ts`

**Interfaces:**
- Consumes: `buildServer(cfg: Config): McpServer` and `Config { identities: Map<string, Identity> }` from Task 1's `@rsc/mcp/src/tools.ts`; `base(): string` from `$lib/server/session`.
- Produces: `POST` (a `RequestHandler`) and the exported helper `bearer(request: Request): string | null`, which the test imports directly.

- [ ] **Step 1: Write the failing tests**

Create `web/src/routes/mcp/server.test.ts`. Modelled on
`web/src/routes/api/v1/[...path]/server.test.ts` (same `global.fetch` stubbing
and `afterEach` restore).

Note the wire facts these tests encode, all probed this session: the request
must carry `content-type: application/json` (else 415) **and** an `Accept`
listing both `application/json` and `text/event-stream` (else 406); the
response comes back as SSE, so the body is parsed out of the `data:` line
rather than with `res.json()`.

```ts
import { test, expect, vi, afterEach } from 'vitest'
import { POST, bearer } from './+server.ts'

const originalFetch = global.fetch
afterEach(() => {
	global.fetch = originalFetch
})

// The SDK requires BOTH: application/json alone is answered 406, and a POST
// without content-type: application/json is answered 415 before routing.
const MCP_HEADERS = {
	'content-type': 'application/json',
	accept: 'application/json, text/event-stream'
}

const TIMELINE_CALL = {
	jsonrpc: '2.0',
	id: 1,
	method: 'tools/call',
	params: { name: 'rsc_timeline', arguments: {} }
}

function rpc(headers: Record<string, string> = {}) {
	return new Request('http://x/mcp', {
		method: 'POST',
		headers: { ...MCP_HEADERS, ...headers },
		body: JSON.stringify(TIMELINE_CALL)
	})
}

// Responses are text/event-stream: `event: message\ndata: {…}\n\n`.
function sseData(body: string): unknown {
	const line = body.split('\n').find((l) => l.startsWith('data:'))
	if (!line) throw new Error(`no data frame in SSE body: ${body}`)
	return JSON.parse(line.slice('data:'.length).trim())
}

test('a request with no Authorization header is 401 and never calls upstream', async () => {
	const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await POST({ request: rpc() } as never)

	expect(res.status).toBe(401)
	expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
	['a non-Bearer scheme', 'Basic aGk6dGhlcmU='],
	['Bearer with no token', 'Bearer'],
	['Bearer with an empty token', 'Bearer   '],
	['a bare key with no scheme', 'rsc_looks_like_a_key']
])('%s is 401 and never calls upstream', async (_label, authorization) => {
	const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await POST({ request: rpc({ authorization }) } as never)

	expect(res.status).toBe(401)
	expect(fetchMock).not.toHaveBeenCalled()
})

test('bearer() accepts the scheme case-insensitively, per RFC 7235', () => {
	expect(bearer(new Request('http://x', { headers: { authorization: 'bearer rsc_k' } }))).toBe('rsc_k')
	expect(bearer(new Request('http://x', { headers: { authorization: 'Bearer rsc_k' } }))).toBe('rsc_k')
	expect(bearer(new Request('http://x'))).toBe(null)
})

test('a valid Bearer key round-trips a tool call and reaches core with x-api-key', async () => {
	const fetchMock = vi.fn(async () => new Response(
		JSON.stringify({ timeline: [], nextCursor: null }),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await POST({ request: rpc({ authorization: 'Bearer rsc_secret_key' }) } as never)

	expect(res.status).toBe(200)
	expect(fetchMock).toHaveBeenCalledTimes(1)

	// Upstream is core directly, at base() — no /api/v1 (core mounts at root).
	const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
	expect(String(url)).toBe('http://localhost:8787/me/timeline')
	expect(new Headers(init.headers).get('x-api-key')).toBe('rsc_secret_key')

	const payload = sseData(await res.text()) as { result?: { content?: { text?: string }[] } }
	expect(payload.result?.content?.[0]?.text).toContain('No entries.')
})

// The key is a live credential: it must never come back to the caller, in a
// success body or in an error message.
test('the API key never appears in the response body', async () => {
	global.fetch = vi.fn(async () => new Response(
		JSON.stringify({ timeline: [], nextCursor: null }),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	)) as unknown as typeof fetch

	const res = await POST({ request: rpc({ authorization: 'Bearer rsc_secret_key' }) } as never)
	expect(await res.text()).not.toContain('rsc_secret_key')
})

test('the API key never appears in an upstream-failure body either', async () => {
	global.fetch = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch

	const res = await POST({ request: rpc({ authorization: 'Bearer rsc_secret_key' }) } as never)
	const body = await res.text()
	expect(body).not.toContain('rsc_secret_key')
})

// GET/DELETE are deliberately not exported: SvelteKit answers 405, matching
// what the SDK itself answers for 2025-era session operations. Exporting them
// would give an unauthenticated GET a 401 and an authenticated one a 405.
test('GET and DELETE are not exported', async () => {
	const mod = await import('./+server.ts')
	expect('GET' in mod).toBe(false)
	expect('DELETE' in mod).toBe(false)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
docker compose exec -T web npx vitest run src/routes/mcp/server.test.ts
```

Expected: FAIL — `Failed to resolve import "./+server.ts"`, because the route
does not exist yet.

- [ ] **Step 3: Write the route**

Create `web/src/routes/mcp/+server.ts`:

```ts
import { createMcpHandler } from '@modelcontextprotocol/server'
import { buildServer } from '@rsc/mcp/src/tools.ts'
import { base } from '$lib/server/session'
import type { RequestHandler } from './$types'

// Phase 2, Track A: the hosted transport. Sits beside mcp/src/stdio.ts against
// the same buildServer — the tool definitions are shared, only the way bytes
// move differs. Spec:
// docs/superpowers/specs/2026-08-22-rsc-mcp-hosted-transport-design.md
//
// Hosted inverts stdio's identity model: the server owns no credentials, the
// caller presents one, and the instance is fixed. That is a single-identity
// Config, which resolveIdentity already handles; `as` is vestigial here.

// RFC 7235: the auth scheme is case-insensitive. Exported for the test — this
// predicate is the whole perimeter, so it gets asserted directly.
export function bearer(request: Request): string | null {
	const raw = request.headers.get('authorization')
	if (!raw) return null
	const m = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim())
	return m ? m[1] : null
}

// ONE module-level handler. The SDK builds a fresh McpServer per request from
// this factory, so the per-caller credential is read from ctx.requestInfo
// rather than captured here — nothing about the caller is module state.
//
// `base()` (CORE_API_URL) is core's origin, and Identity.url is now the full
// API base, so it is passed unprefixed: core mounts /me/timeline at root, and
// only web's proxy carries /api/v1. Looping back through the instance's public
// origin was rejected — a full DNS/TLS/reverse-proxy round trip, and
// rscFetch's `redirect: 'error'` makes any edge redirect fail every tool call.
const handler = createMcpHandler((ctx) => {
	// Non-null on both counts: POST below rejects every tokenless request
	// before handler.fetch runs, and the SDK sets requestInfo on both the
	// modern and legacy legs (dist/index.mjs:1261 and :972).
	const key = bearer(ctx.requestInfo!)!
	return buildServer({ identities: new Map([['hosted', { url: base(), key }]]) })
})

export const POST: RequestHandler = ({ request }) => {
	// Auth is checked HERE, not inside the factory. A factory throw unwinds to
	// the SDK's own handle() catch and is answered 500 (dist/index.mjs:1339-1349,
	// via internalServerErrorResponse at :945) — so a missing key raised in the
	// factory would reach the caller as a server error instead of a 401. The
	// factory re-reads the same header once the route has admitted the request.
	if (!bearer(request)) return new Response(null, { status: 401 })
	return handler.fetch(request)
}

// No GET/DELETE export: SvelteKit answers 405, which is what the SDK answers
// for those 2025-era session operations anyway (dist/index.mjs:968). Exporting
// them would hand an unauthenticated GET a 401 and an authenticated one a 405 —
// a distinction that tells an anonymous prober whether a key is valid.
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
docker compose exec -T web npx vitest run src/routes/mcp/server.test.ts
```

Expected: PASS, all tests.

If the round-trip test reports `406`, the `Accept` header is wrong — it must
list both `application/json` and `text/event-stream`. If it reports `415`, the
`content-type` is missing. If it reports `500`, the factory threw: check that
`ctx.requestInfo` is being read rather than a captured request.

- [ ] **Step 5: Run the whole web suite for regressions**

```bash
docker compose exec -T web npx vitest run
```

Expected: PASS. Record the count.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/mcp/+server.ts web/src/routes/mcp/server.test.ts
git commit -m "$(cat <<'EOF'
feat(web): serve the RSC MCP tools over HTTP at POST /mcp

One module-level createMcpHandler over the same buildServer the stdio entry
uses; the caller presents an ordinary API key as `Authorization: Bearer`,
translated to core's x-api-key. Auth is checked in the route, not the
factory: a factory throw is answered 500 by the SDK, which would turn a
missing key into a server error. GET/DELETE stay unexported so an anonymous
prober cannot tell a valid key from an invalid one.

developed with the help of AI tools
EOF
)"
```

---

### Task 4: Production build proof, docs, and review

The route works under vitest; that is not yet evidence it survives a real
`vite build`, which is what every live instance actually runs.

**Files:**
- Modify: `README.md`
- Modify: `docs/api/API.md` (if that is where the MCP client is documented — confirm with `grep -rl "rsc_timeline" docs README.md` before editing)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: no code.

- [ ] **Step 1: Prove the cross-workspace import survives a production build**

```bash
docker compose exec -T web npx vite build 2>&1 | tail -25
```

Expected: a successful build, no `Failed to resolve import "@rsc/mcp/src/tools.ts"`
and no "externalized for browser compatibility" warning naming it. The route is
server-only, so the import must end up in the server bundle.

Confirm the tools actually got bundled:

```bash
docker compose exec -T web sh -c 'grep -rl "rsc_timeline" build/server 2>/dev/null | head'
```

Expected: at least one file. If the build fails to resolve the deep path, the
documented fallback is a relative import (`../../../../mcp/src/tools.ts`) —
spec Risk 1. Only reach for it if the build genuinely refuses; the vitest
resolution is already proven.

- [ ] **Step 2: Typecheck web**

```bash
docker compose exec -T web npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -15
```

Expected: 0 errors. Warnings that predate this branch are acceptable — say so
explicitly rather than letting them pass silently.

- [ ] **Step 3: Smoke-test the live route**

With the dev stack up, an unauthenticated call must be 401 and a GET must be 405:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:5173/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expected: `401`

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/mcp
```

Expected: `405`

Then with a real key from `/settings/api-keys` on the dev instance:

```bash
curl -s -X POST http://localhost:5173/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $RSC_DEV_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expected: an SSE frame listing `rsc_timeline`, `rsc_thread`, `rsc_post`.

If no dev key is available, say so and skip this step explicitly — do not
report it as passed.

- [ ] **Step 4: Document the endpoint**

Find the existing MCP documentation first:

```bash
grep -rln "rsc_timeline\|claude mcp add" README.md docs/
```

Add a short section to whichever file documents the MCP client, covering: the
URL (`https://<instance>/mcp`), the `Authorization: Bearer <key>` header, where
the key comes from (`/settings/api-keys`), the inherited 300/hr per-key rate
limit, that per-tool key permissions apply (a `timeline:read` key is refused by
`rsc_post`), and that `as` is not used on the hosted transport because the
instance and identity are fixed by the key.

Also record the known leak the spec accepted: `rscFetch`'s error strings put
the internal core address in tool output, and its 401 message names
`RSC_IDENTITIES`, an env var a hosted caller has never seen. This is a decision,
not an oversight — note it as a follow-up rather than fixing it here.

- [ ] **Step 5: Run the ponytail review on the whole diff**

Per CLAUDE.md, `/ponytail-review` runs on the diff after any task that changed
code, before the work is called done.

```bash
git diff origin/main...HEAD --stat
```

Then invoke `/ponytail-review` on that diff and fold anything accepted.

- [ ] **Step 6: Full gate**

```bash
npm test -w mcp && npm run typecheck -w mcp
docker compose exec -T web npx vitest run
docker compose exec -T core npx vitest run
```

Expected: all green. Report the actual counts — not "tests pass".

- [ ] **Step 7: Commit**

```bash
git add README.md docs/api/API.md
git commit -m "$(cat <<'EOF'
docs(mcp): document the hosted transport at POST /mcp

developed with the help of AI tools
EOF
)"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| One new file, `web/src/routes/mcp/+server.ts` | 3 |
| Auth checked in the route before `handler.fetch` | 3, Step 3 |
| One module-level handler, credential from `ctx.requestInfo` | 3, Step 3 |
| POST only; GET/DELETE unexported | 3, Steps 3 + 1 (asserted) |
| `configFrom` returns single-identity Config reusing `base()` | 3, Step 3 (inlined — see note) |
| `Identity.url` becomes the full API base; `loadConfig` appends `/api/v1`; `rscFetch` concatenates | 1 |
| Bearer → `x-api-key`, `core/` untouched | 3 |
| `cloudron/Dockerfile` copies `mcp/package.json` | 2 |
| `web/package.json` declares the SDK and zod | 2 |
| 401 on missing/malformed auth, no upstream call | 3, Step 1 |
| Key never in a response body — asserted by a test | 3, Step 1 (two tests: success and failure paths) |
| `mcp/test/tools.test.ts` updated for the url change | 1 |
| Cross-workspace import probed | Verified before planning; re-proven under a production build in 4, Step 1 |
| Known leak recorded as a decision | 4, Step 4 |

**Deviation from the spec, deliberate:** the spec names a `configFrom` helper.
The route inlines it — it is a single `new Map([...])` expression used once, and
a named one-line wrapper around it is the kind of abstraction the ponytail
ladder's rung 1 exists to skip. `bearer` **is** extracted, because it is used
twice (route and factory) and is the entire auth perimeter, so it earns a
direct test.

**Spec citation corrected:** rev 3 cites `dist/index.mjs:1030, :1313` for the
factory-throw-is-500 claim. Those are the legacy-leg and `invoke` catches; the
catch that actually swallows a *factory* throw on the modern leg is
`:1347-1349`. The conclusion is right and the architecture is unaffected — only
the line reference was off.
