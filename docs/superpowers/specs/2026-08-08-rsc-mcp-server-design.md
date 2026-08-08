# RSC MCP server — Design

**Status:** rev 3 (2026-08-08).

**Goal:** Let a Claude session read an RSC timeline and post/reply to it,
through a Model Context Protocol server that is a thin client over RSC's
**existing** `/api/v1` surface. Phase 1 is stdio-only, tools-only, three
tools.
No changes to `core/` or `web/`.

Three consumers motivated it, all served by the same three tools:

1. **rmdes, from Claude Code** — read the timeline, reply to conversations
   without opening the web UI.
2. **A `@claude` account** — Claude sessions post dev-log entries about work
   just completed ("shipped an MCP for RSC, here's the shape").
3. **Other RSC instances' users**, eventually — this ships in-repo as a real
   feature, not a local script. Packaging for that is phase 2.

## Background — everything backend already exists

The external API + firehose milestone (spec
`2026-08-01-external-api-and-firehose-design.md`, all 4 phases merged
2026-08-05) built exactly the surface an MCP server needs. Verified against
the code on 2026-08-08:

| Capability | Core route | Permission |
|---|---|---|
| own timeline | `GET /me/timeline` (`core/src/api/logical-routes/personal.ts:76`) | `timeline:read` |
| own posts | `GET /me/posts` (`personal.ts:86`) | `posts:read` |
| create post / reply | `POST /me/posts` (`personal.ts:107`) | `posts:write` |
| edit / delete own post | `PATCH`/`DELETE /me/posts/:id` (`personal.ts:123,137`) | `posts:write` |
| follow / subscribe / profile | `personal.ts:158,190,243` | `follows:write`, `profile:write` |
| public reads | `GET /timeline`, `/post/:id`, `/post/:id/thread` (`core/src/api/logical-routes/read.ts:77,104,115`) | none |

The permission vocabulary is whitelisted at `personal.ts:39`
(`ALLOWED_KEY_PERMISSIONS`) — a key cannot be minted for a permission no route
checks. `admin.*` is deliberately absent from it; admin keys are a separate
`configId: 'admin'` class issued by `POST /admin/api-keys`
(`core/src/api/logical-routes/admin.ts:79`) and are **out of scope here**.

**One base URL serves both keyed and keyless routes.** Verified in
`web/src/routes/api/v1/[...path]/+server.ts:22-28`: the catch-all forwards any
resolved core path *except* one starting `/api/` (the guard protecting core's
better-auth mount), attaching `x-api-key` and `content-type` only. So
`/api/v1/me/timeline` and `/api/v1/post/:id/thread` are the same origin, the
same proxy, and differ only in whether a key header is sent.

Consequence for this design: **there is no backend work.** Every tool below
maps onto a route that exists, is tested, and is deployed.

### One documentation gap this work must close

`docs/superpowers/documentation/API.md` currently states that exactly two
things need no key — the public firehose and the published RSS/JSON feeds. It
does **not** document the keyless reads (`/api/v1/timeline`,
`/api/v1/post/:id`, `/api/v1/post/:id/thread`) that the catch-all proxy in
fact forwards. `rsc_thread`, one of this design's three tools, depends on
that behaviour for `/post/:id/thread`.

Depending on undocumented reachability is a real fragility: someone
tightening the proxy to an allowlist later would break this server without
ever touching it, and would be right to think nothing depended on it. So
part of this work is a short API.md section turning those keyless reads into
a **stated contract**, matching what the code already does. This is a
documentation change only — no route behaviour changes.

## Scope decisions (and what they rule out)

| Decision | Chosen | Rejected |
|---|---|---|
| Transport | stdio now, HTTP later, via a transport-agnostic tool layer | HTTP-first; stdio-only-forever |
| UI | tools only — text/markdown output | MCP **App** with `ui://` timeline or compose views |
| Identity | per-post, `as` parameter, multiple keys in one process | single identity; separate `@claude`-only server |
| Tools | 3: timeline, thread, post | single-item get (subsumed by thread); edit/delete, follows, subscriptions, profile, admin, firehose |
| Write guard | the host's own per-tool-call permission prompt | dry-run/confirm flag; server-side draft queue |
| Layout | third npm workspace `mcp/`, run from source | npm publish now; inside `core/`; separate repo |

Two of these deserve their reasoning recorded, because both were raised as
concerns and consciously accepted:

- **Two live write credentials in one process.** The flexibility (post as
  yourself or as `@claude` from the same session) was judged worth it. The
  mitigation is that identity is explicit and unforgiving — see Identity below.
- **No delete tool, so no in-session undo.** Accepted because the host already
  prompts before every tool call and displays the arguments, so the exact
  content is seen before it goes out, and retraction remains available in the
  web UI. If posting-by-agent turns out to happen faster than review in
  practice, `rsc_delete_post` is ~15 lines against a route that already exists.

**This is not an MCP App.** MCP Apps ship rendered `ui://` resources; this
ships tools whose output is text. The `mcp-apps:create-mcp-app` skill does not
apply to phase 1.

## Architecture

A third npm workspace alongside `core/` and `web/`:

```
mcp/
  package.json          @rsc/mcp, private, "type": "module"
  src/
    tools.ts     — the fetch helper + the three tool definitions; NO transport
    stdio.ts     — serveStdio(() => buildServer()); the entry
  test/
    tools.test.ts
```

Two source files. The split that exists is the one that earns it: `tools.ts`
exports a `buildServer()` that registers tools on an `McpServer` and knows
nothing about how bytes move; `stdio.ts` is the only file that mentions
stdio. Phase 2 adds one more entry (a SvelteKit route calling
`createMcpHandler`) against the same `tools.ts` — a second small file, not a
rewrite. That is a real seam with a named second consumer, not speculative
layering.

The fetch helper lives **in** `tools.ts` rather than a `client.ts` of its own:
it is one function over three routes, and a separate module for it would be a
file boundary with nothing on either side of it.

Node 22+ native type stripping, no build step, matching `core/`'s convention
(root `package.json` sets `engines.node >= 22.18`; `core/package.json` runs
`node src/server.ts` directly).

### Dependencies

CLAUDE.md requires justifying any new package. Both are confined to `mcp/`;
`core/` and `web/` dependency lists are untouched.

- **`@modelcontextprotocol/server@2.0.0`** — the protocol implementation.
  Verified on npm 2026-08-08: v2 is the current line, exporting `McpServer` +
  `registerTool` from the package root and `serveStdio` from
  `@modelcontextprotocol/server/stdio`; `createMcpHandler` (package root) is
  the HTTP path phase 2 will use. This supersedes the older
  `@modelcontextprotocol/sdk@1.30.0` package name. Hand-rolling the JSON-RPC
  framing plus initialize/capability negotiation is not "a few lines," and
  doing it would also have to be redone for the HTTP transport that this
  package gives us free.
- **`zod@^4`** — already a hard dependency of the above (`npm view` shows
  `zod: ^4.2.0`), and `registerTool`'s `inputSchema` mandates a Standard
  Schema object (`z.object({...})`; the raw-shape overload is deprecated in
  v2). Declaring it is honesty about a transitive, not an addition. This does
  deviate from core's hand-rolled-validators-over-`zValidator` house style —
  that rule is specifically about Hono request validation and does not reach
  outside Hono.

## Identity

Configuration is environment-only. No config file, no runtime key management.

```
RSC_API_URL=https://rsc.rmdes.be
RSC_IDENTITIES=me:rsc_live_xxx,claude:rsc_live_yyy
```

Two variables. That is the whole configuration surface.

- `RSC_API_URL` is required. Startup fails loudly (stderr + non-zero exit) if
  it is missing, rather than producing tools that all fail at call time.
- `RSC_IDENTITIES` is a comma-separated list of `name:key` pairs. A key
  containing a comma or colon is not supported; keys are opaque tokens from
  better-auth's api-key plugin and contain neither.

`rsc_post` takes `as?: string`, resolved by exactly two rules:

- **One identity configured** → it is used; `as` is optional and, if given,
  must match its name.
- **Two or more configured** → `as` is **required**. There is no default.

No `RSC_DEFAULT_IDENTITY`, and no separate `RSC_API_KEY` shorthand. Both were
cut in rev 2 (see Revision history). The default-identity variable only ever
mattered with several identities configured — which is precisely the case
where this design says the choice must be explicit; keeping it would have let
an agent post in a voice it never named. `RSC_API_KEY` said nothing
`RSC_IDENTITIES=me:key` doesn't.

An unknown `as` name is an **error naming the configured identities** — never
a silent fall back. Choosing whose voice a public federated post goes out in
is not a recoverable-by-guessing decision.

`rsc_thread` sends no `x-api-key` at all and works with no identity
configured.

## Tools

Three. Each maps to one route.

### `rsc_timeline({ limit?, before? })`
`GET /api/v1/me/timeline` with `x-api-key`. Requires `timeline:read`.
`limit` is passed through to core's own `clampLimit`; `before` is core's
opaque cursor, echoed back from a previous call's `nextCursor`. Returns
rendered entries plus the cursor.

### `rsc_thread({ postId })`
`GET /api/v1/post/:id/thread`. No key. Returns the conversation — the
root-to-requested ancestor path plus the requested item's descendants — for
reading context before replying. Also the way to read **one** post: there is
no separate get-post tool, because `/post/:id/thread` strictly subsumes
`/post/:id`.

Verified rather than assumed (`core/src/logical/threading.ts:338`): the
thread projector resolves every node through the *same* `projectItem` that
`GET /post/:id` calls (injected at `core/src/logical/store.ts:78`, called at
`threading.ts:394`). So for a visible item the thread carries the identical
DTO; for an invisible item with no visible descendants it returns `undefined`
→ the same 404 (`threading.ts:419`); and for an invisible item whose
descendants are visible it returns a placeholder plus the subtree, where
`/post/:id` would 404. Never less, sometimes more.

**Known ceiling.** A thread is bounded by `THREAD_NODE_BUDGET` (500 nodes,
`core/src/logical/threading.ts:327`), so reading one post inside a very large
conversation costs more tokens than a
single-item fetch would have. Accepted: the situations where an agent wants
exactly one post with none of its context are rare, and the fix if it ever
bites is a depth/limit argument on this tool — not a second tool.

### `rsc_post({ content, inReplyTo?, as? })`
`POST /api/v1/me/posts` with `x-api-key` for the resolved identity. Requires
`posts:write`. `content` is markdown, 1..100000 chars (core's own bound,
`personal.ts:111`). `inReplyTo` is the reply target ref, 1..64 chars
(`personal.ts:112`), resolved server-side by `service.resolveReplyTarget`.
Reply is not a separate tool — it is this tool with `inReplyTo` set, exactly
as core models it.

## Output format and the untrusted-content boundary

Tool output is **markdown text, never HTML.** Each `LogicalItemDto`
(`core/src/logical/types.ts:115` for the envelope,
`LogicalItemDto` for the item) renders as a compact block:

```
[remote] @handle · 2026-08-07T09:14:00Z · id=<logical id>
<contentMarkdown, or content when contentMarkdown is null>
↳ 3 replies · <permalink>
```

`contentMarkdown` is the preferred field; remote items may carry `null` there
(it is optional in the normalized material — `core/src/logical/projector.ts:753`),
in which case `content` is used.

**RSC's "the sanitizer is the XSS gate" invariant does not transfer to this
workspace.** There is no browser, no `{@html}`, no display HTML produced here.
The analogous boundary is a different one: remote feed content is
attacker-controlled text entering a model's context — prompt injection, not
XSS. Format-stripping does not address that (markdown injects as well as HTML
does). The mitigation is labelling, and it is load-bearing:

- Every entry is emitted with its `origin` (`local` / `remote`) and author
  handle, so provenance is never ambiguous in the rendered text.
- Every read tool's description states that returned remote content is data
  to report on, never instructions to follow.

## Error handling

Tool failures return `{ content: [...], isError: true }` rather than throwing.
A thrown error kills the call; an `isError` result lets the model correct
itself — fix a bad `inReplyTo`, pick a real identity.

| Condition | Origin | Tool result |
|---|---|---|
| unknown `as` value | client, pre-flight | error listing the configured identity names; no fallback |
| `RSC_API_URL` unset | startup | stderr message, non-zero exit |
| 400 `content invalid` | `personal.ts:111` | core's message passed through verbatim |
| 400 `inReplyTo invalid` | `personal.ts:112` | verbatim |
| 404 `unknown post` | `personal.ts:116` | "reply target not found" plus the ref that failed |
| 401 | `apiKeyAuth` (`core/src/api/auth.ts:96`) | "key for identity `X` rejected — check RSC_IDENTITIES" |
| 429 | api-key plugin rate limit — 300 requests/hour per key (`core/src/auth.ts:107`) | surfaced plainly; **no auto-retry** |
| 503 `core unavailable` | `web/src/routes/api/v1/[...path]/+server.ts:44` | instance unreachable |

Two rules that are not obvious and are the reason this section exists:

1. **Writes are never retried automatically.** `POST /me/posts`
   (`personal.ts:107`) takes no `commandId` — unlike `POST
   /me/api-subscriptions` (`personal.ts:190`), which requires one precisely
   because subscribing is retry-prone. That asymmetry is a deliberate
   statement in the existing code: post creation is **not idempotent**. A
   retry after a timeout duplicates a post into the outbound RSS feed and out
   to every subscriber. The client retries nothing — not on the write path,
   not on reads, not anywhere: `rscFetch` (`mcp/src/tools.ts`) makes exactly
   one request, full stop. (This line originally said reads may retry once on
   a network-level error; the implementation never did that, and it's the
   better behavior, so rev 3 amends the line to match rather than "restore"
   a retry that was never built and isn't wanted — see revision history.)
2. **Nothing is ever written to stdout except JSON-RPC frames.** On a stdio
   transport stdout *is* the protocol channel; one stray `console.log`
   corrupts the stream and the host drops the connection. All diagnostics go
   to stderr, and the API key appears in none of them — not in error
   messages, not in debug output.

## Testing

`mcp/test/tools.test.ts`, vitest, matching `core/`'s configuration.

`mcp/` has **no native dependencies**, so unlike `core/` it runs on the host:
`npm test -w mcp` works without the dev container. (Core's host-test EACCES
problem comes from `better-sqlite3` and the root-owned `.vite-temp` — see
`docs/superpowers/documentation/TESTING.md`, Gotcha 1. Neither applies here.)

Covered, with `fetch` stubbed:

- identity resolution: named identity uses its own key; with one identity
  configured, omitted `as` uses it; with two or more, omitted `as` is an
  error; unknown `as` errors **and specifically does not fall back**
- URL and header construction per tool — keyed tools send `x-api-key`,
  `rsc_thread` sends none
- every row of the error table above
- `LogicalItemDto` → markdown rendering, with fixtures for local, remote with
  `contentMarkdown`, and remote with `contentMarkdown: null`
- exactly one outbound request on the write path when the response is 5xx
  (the no-retry rule, asserted rather than assumed)

Not covered: the SDK's own protocol handling. One manual end-to-end smoke
against `docker compose up` is documented in the README; it is not in CI.

## Documentation changes

Two, both small:

1. `docs/superpowers/documentation/API.md` — the keyless-reads section
   described above, making a stated contract of what the proxy already does.
2. `README.md` — a short "MCP server" section: what it is, the three tools,
   the two env vars, the `claude mcp add` line, and the manual smoke
   procedure.

## Operator steps (not code)

Documented in the README, no implementation task:

1. Create the `@claude` account on the target instance.
2. Mint it a key at `/settings/api-keys` scoped to `posts:write` (plus
   `timeline:read` if that account should read too).
3. Mint your own key with `timeline:read` + `posts:write`.
4. `claude mcp add rsc -- node ~/textcaster/mcp/src/stdio.ts`, with
   `RSC_API_URL` and `RSC_IDENTITIES` in the env.

## Phase 2 — named, not specced

Deliberately deferred so the tool shape proves itself over stdio before it
becomes an internet-facing endpoint on every RSC instance:

- `web/src/routes/mcp/+server.ts` using `createMcpHandler` against the same
  `tools.ts`.
- Its auth story — `x-api-key` header versus OAuth — which is a real design
  question, not a detail.

  **Carried warning from rev 2.** A "default credential" will be tempting
  here for exactly the reasons `RSC_DEFAULT_IDENTITY` was, and it has the
  same shape: a convenience option whose danger scales with the thing it
  exists to make convenient. One credential, no effect. Two, it silently
  picks one. Ten, it silently picks from a set nobody remembers the ordering
  of. It pays off in the simple case and takes over the decision precisely
  when the decision starts to matter. Whatever phase 2 chooses, it should not
  reintroduce that shape under a new name.
- npm publishing (`npx @rsc/mcp`), which needs a build step this repo
  deliberately does not have today.

## Out of scope

`rsc_edit_post`, `rsc_delete_post`, a single-item get tool (subsumed by
`rsc_thread` — see Tools), a tool over `GET /me/posts` (own-posts list —
`rsc_timeline` already shows your posts in context), follows, subscriptions,
profile updates, anything `admin-api`, the firehose SSE stream, and any
`ui://` resource. Each is cheap to add later against a route that already
exists; none is in v1.

## Revision history

- **rev 1** (2026-08-08) — initial design, from brainstorming with rmdes.
- **rev 2** (2026-08-08) — folded a ponytail-review of rev 1. Five cuts, all
  accepted:
  1. **Dropped `rsc_get_post`** — `/post/:id/thread` strictly subsumes
     `/post/:id`. Verified in `threading.ts:338-434` before accepting, since
     this one changes behaviour: same injected `projectItem`, same 404
     condition, and a superset in the placeholder case. Tool count 4 → 3. The
     500-node thread budget is now recorded as a known ceiling.
  2. **Dropped `RSC_DEFAULT_IDENTITY`** — it only had an effect with two or
     more identities configured, which is exactly the case this design says
     must be explicit. `as` is now required when several are configured.
  3. **Dropped the `RSC_API_KEY` shorthand** — `RSC_IDENTITIES=name:key`
     already expresses a single identity. Config surface is two variables.
  4. **Folded `client.ts` into `tools.ts`** — one fetch helper over three
     routes is not a module. The `stdio.ts` split stays: it is the phase-2
     seam with a named second consumer.
  5. **Merged documentation items** — the smoke procedure is part of the
     README section, not a third deliverable.

  The review also examined and explicitly did **not** cut: the
  `@modelcontextprotocol/server` dependency, `zod` as a direct dependency,
  the tools/transport split, and the no-retry rule with its test. Its three
  independently checkable factual claims (the npm package version, the
  keyless-read line numbers, the API.md gap) were each confirmed against the
  source.
- **rev 3** (2026-08-08) — folded a whole-branch code review's findings, all
  applied. The headline bug: `RscItem.selectedAuthor` was hand-declared from
  this design's own example output rather than from core's real
  `SelectedAuthor` union — the `remote_publisher` arm has no `handle` field,
  so every remote item rendered `(unattributed)`. Fixed by copying core's
  union shape verbatim instead of re-deriving a narrow view, with the
  remote-item fixtures rebuilt from the live `/api/v1/timeline` payload
  rather than invented. Also: `title` is now rendered; blank content (not
  just `null`) is treated as absent so it never emits an empty fence;
  fencing now follows item **origin**, not which field the text came from
  (a remote peer's `contentMarkdown` is attacker-controlled too); remote
  `displayName` is sanitized against embedded newlines before rendering;
  `rscFetch` treats a 2xx with an unparseable body as failure at the source
  instead of three blind casts downstream; `redirect: 'error'` closes a
  redirect-preserves-POST gap; the untrusted-content tool descriptions are
  now pinned by a test; and the Error-handling "reads may retry once" line
  above is corrected to match the implementation (see that section). README
  and `CLAUDE.md` doc drift (the `claude mcp add` command missing its env
  vars; the workspace count) fixed alongside, outside this doc.
