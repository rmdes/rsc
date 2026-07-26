---
name: hono
description: Use when writing, editing, or reviewing anything in core/ that touches HTTP — routing, middleware, request/response handling, SSE streaming, error handling, auth mounting, or route tests. Keywords: Hono, new Hono, app.get/post, c.json, c.req.valid, MiddlewareHandler, ContextVariableMap, streamSSE, bodyLimit, app.onError, app.request, hono/node-server, better-auth handler.
---

# Hono in RSC (core/)

Hono `^4.x` is core's entire HTTP layer. `core/` is **never browser-facing**
(CLAUDE.md invariant): the web app is the only client, and it talks to core
over plain `fetch`. Everything here runs on `@hono/node-server` under Node's
native type-stripping — **no build step, no bundler**.

The whole app is assembled in one place: `core/src/api/app.ts` (`createApp`),
with middleware factories in `core/src/api/auth.ts`. Read those two files before
adding a route — match them, don't invent a parallel style.

## House style — what THIS repo does (and deliberately does NOT)

| Concern | RSC does | Do NOT reach for |
|---|---|---|
| Errors | `return c.json({ error: '…' }, status)`; domain errors bubble to `app.onError` (`DomainError → 400`) | `HTTPException` / `throw` in handlers |
| Validation | hand-rolled guards (`isString`, `readJsonBody`), plus domain normalizers that signal invalid input by throwing (`normalizeSourceUrl`) | `@hono/zod-validator`, adding `zod` |
| Typed context | global `declare module 'hono' { interface ContextVariableMap … }` | per-instance `new Hono<{ Variables }>()` generics |
| Middleware | factory fns returning `MiddlewareHandler` (`sessionAuth`, `requireAdmin`…) | inline `app.use` closures for auth |
| Web↔core | plain `fetch` + the `/api/auth` proxy | Hono RPC / `hc` client / `AppType` export |
| Tests | `app.request(path, init)` against `createApp(...)` | `testClient`, running a real server |

These are deliberate (YAGNI + no-new-deps). Don't "modernize" a route to
zValidator/HTTPException/RPC without an explicit ask — it breaks the pattern
and widens the dep surface.

## Patterns as they appear here

**Route + guard + hand validation** (`app.ts`):
```ts
app.post('/posts', authed, async (c) => {          // authed = sessionAuth(...) factory
  const body = await readJsonBody(c)               // try/catch c.req.json() → null
  if (!body) return c.json({ error: 'body invalid' }, 400)
  if (!isString(body.content, 1, N)) return c.json({ error: 'content invalid' }, 400)
  const me = c.get('coreUser')                     // typed via ContextVariableMap
  return c.json({ post: await service.create(me, ...) }, 201)
})
```

**Typed context variables** — augment once, globally (`api/auth.ts` top):
```ts
declare module 'hono' {
  interface ContextVariableMap { coreUser: User; sessionIsAnonymous: boolean; isAdmin: boolean }
}
```
Then `c.set('coreUser', …)` in middleware and `c.get('coreUser')` in handlers
are typed everywhere with no per-route generics.

**Middleware factory** returning `MiddlewareHandler` (`api/auth.ts`):
```ts
export function requireAdmin(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.get('isAdmin')) return c.json({ error: 'admin only' }, 403)
    return next()
  }
}
```
Compose them positionally, or gate a whole prefix with `app.use` (`api/app.ts`):
```ts
// One gate for the whole admin surface — every /admin/* route is admin-only
// by construction, so a new one can't ship ungated by forgetting the guard.
app.use('/admin/*', authed, requireAdmin())
```
The ops bearer token is a **separate, single-route** grant, never merged into
the session/admin gate (there is no `adminOrToken`-style combinator in the
current API — a bearer header gets no admin reach at all):
```ts
app.post('/ops/sources/federation', bearerAuth(token), jsonWrite, (c) =>
  establishFederation(c, opsActorId, 'operator_token'),
)
```
`bearerAuth` 401s anything without the exact token; a request with a
better-auth session but no bearer header still 401s here (this route doesn't
look at sessions), and a bearer header sent to any `/admin/*` route 401s there
too (`sessionAuth` runs first and finds no session) — the two grants never
overlap.

**Central error handler** (`app.ts`) — the only place internal errors are shaped:
```ts
app.onError((err, c) => {
  if (err instanceof DomainError) return c.json({ error: err.message }, 400)
  console.error(err); return c.json({ error: 'internal error' }, 500)
})
```

**Body limits** on public/federation POSTs (`hono/body-limit`):
```ts
app.post('/hub', bodyLimit({ maxSize: MAX_FORM_BYTES, onError: rejectOversized }), handler)
```

**SSE** — the live timeline (`hono/streaming`, `api/logical-routes.ts:mountLogicalStreamRoute`, mounted as `GET /stream`):
```ts
app.get('/stream', (c) =>
  streamSSE(c, async (stream) => {
    const viewer = await resolveViewer(c)

    // Register the wake-up listener BEFORE replay: a live effect landing
    // during replay must not be lost. The hint is coalesced (highest sequence
    // wins) and is only a wake — the pump re-reads the durable journal.
    let hintHigh = 0
    const off = bus.onSequenceHint((s) => { hintHigh = Math.max(hintHigh, s) })
    stream.onAbort(off)                     // cleanup on client drop — required

    // Last-Event-ID (browser sets it on auto-reconnect) takes precedence over
    // the initial `?last=` query. Missing/empty is invalid → reset.
    const cursor = c.req.header('Last-Event-ID') ?? c.req.query('last') ?? null
    const start = source.start(cursor && cursor.length > 0 ? cursor : null)
    if (start.kind === 'reset') {
      await stream.writeSSE({ event: 'reset', data: RESET_DATA })
      return
    }
    // ...drain the durable journal from start.afterSequence, writeSSE per event
  }),
)
```
The event source of truth is the durable journal, not the in-memory `bus` — the
bus only supplies coalesced wake-up hints; every frame is re-projected from the
journal. See `core/test/logical-sse.test.ts` (`app.request('/stream', { headers: { 'Last-Event-ID': cursor } })`) for the test shape.

**Mounting better-auth** — core delegates the whole `/api/auth/*` surface to the
better-auth handler with the raw request (`app.ts`):
```ts
app.on(['GET', 'POST'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw))
```
(Some POSTs are mail-gated first — see the `MAIL_GATED` set.) See the
**better-auth** side in `core/src/auth.ts`; use the `better-auth` MCP
(`search_docs`/`get_doc`) for its API, per CLAUDE.md.

**Testing** — Web-standard, no server (`core/test/*.test.ts`):
```ts
const app = createApp({ service, bus, token: 'secret', auth, users: repo, feeds })
const res = await app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ content: 'x' }) })
expect(res.status).toBe(201)
```
Type-stripping means vitest passes on type errors — always also run `tsc --noEmit`
(see testing-gotchas in memory).

## Going deeper

Don't write Hono APIs from memory (CLAUDE.md rule). For anything not shown above:
- **`better-auth` MCP** for auth-handler details.
- **context7 MCP** (`resolve-library-id` → `query-docs`) for current Hono docs.
- Full offline copy: `https://hono.dev/llms-full.txt` (index: `llms.txt`,
  condensed: `llms-small.txt`).
- Installed source: `core/node_modules/hono/`.
