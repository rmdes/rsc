# RSC — project conventions

A feeds-native social timeline: local posts and remote feed items are equal
citizens; posts/replies/conversations travel as RSS. Full picture in
`README.md`; founding design in `docs/superpowers/specs/2026-07-15-textcaster-design.md`.

## Verified hard facts — read before designing anything

Non-obvious truths about this codebase, each with the source that proves it.
Every one of these was missed by someone confident they understood the code, and
each cost real rework. **Line numbers drift — the claim is the fact, not the
number. Re-open the file before you rely on one.**

- **`replyCounts` and the renderer use different visibility predicates.**
  Rendering gates on `ORDINARY_ITEM_VISIBLE_SQL` = `hidden_at IS NULL AND
  structural_tombstone = 0` (`core/src/logical/projector.ts:368`). Counting uses
  `nodeVisible` → `remoteVisible` = `eligibleDeliveries(...).length > 0`
  (`:456-458`), which **never checks `hidden_at`**. Worse, `replyCounts`
  (`:486-505`) does `if (!nodeVisible(...)) continue` *before* pushing children,
  so an invisible node drops its whole subtree. Counts are wrong in **both**
  directions today, with no federation involved: a deleted local post
  under-counts and swallows live replies; a hidden remote item over-counts.
- **`itemOrdinaryVisible` ignores `hidden_at`.** It is `nodeVisible`
  (`core/src/logical/projector.ts:464-466`) and is exported as *the reply-target
  gate*, so **hidden items still accept replies**.
- **Ordinary users cannot delete their own posts from the web UI.** Both delete
  surfaces are gated on `data.me?.isAdmin` (`web/src/routes/+page.svelte:231`,
  `web/src/routes/post/[id]/+page.svelte:104`), and the self-serve
  `DELETE /me/posts/:id` is `apiKeyAuth`-only
  (`core/src/api/logical-routes/personal.ts:137`) with **zero callers in
  `web/`**. Deletion is an admin or API-key action, not a user action.
- **Handle reservation already exists and already covers rename.**
  `assertHandleUnreserved` (`core/src/logical/schema.ts:417-420`) is called by
  both handle-claiming paths — user insert (`core/src/storage/sqlite.ts:218`)
  and `PATCH /me` handle change (`core/src/logical/store.ts:394`). Any new
  handle rule extends **this guard**; a registration-only check misses rename.

**How a fact earns a place here:** you opened the file in the current session
and the cited line says what you claim. Not "I remember", not "a subagent
reported it", not "the spec says so". Add one whenever you burn time proving
something non-obvious — especially if you first got it wrong.

**Traps this repo sets.** Each of these has cost a session:

- **Subsystems are often derivations, not tables.** Membership is not a members
  table — it is a URL-prefix range query (`core/src/logical/membership.ts`,
  `instancePrefix`/`prefixUpperBound`/`approvedInstanceFor`). Grepping for
  `CREATE TABLE .*member` finds nothing and "there is no membership" is the
  wrong conclusion. Search for the **behaviour**, not for a table name.
- **A function you are about to write is not existing behaviour.** Never
  describe something a design proposes as something the code already does.
- **A route existing is not a route being used.** `GET /post/:id` has no
  consumer — `web/` and `mcp/` both use `/post/:id/thread`. Check callers before
  "fixing" a route.
- **The same concept can have two implementations that disagree** (see the
  visibility predicates above). Finding one does not mean you found the one that
  runs on the path you care about.

## Architecture

Three npm workspaces in one repo:

- **`core/`** — headless Hono/Node service, SQLite (better-sqlite3 + Kysely),
  `better-auth` for identity. Owns feeds, federation (WebSub/rssCloud),
  ingest/threading, the timeline API. **Never browser-facing.** Runs on Node
  22+ **native type stripping** — no build step, and therefore **no TypeScript
  parameter properties** in `core/src` (constructors assign fields plainly).
- **`web/`** — SvelteKit (Svelte 5 runes, `adapter-node`). The whole UI and
  the only thing browsers talk to; proxies auth + the SSE stream to core
  server-side via `CORE_API_URL`.
- **`mcp/`** — a Model Context Protocol server, a thin stdio client over
  core's `/api/v1`: read a timeline/thread, post/reply. Same native-type-
  stripping, no-build-step convention as `core/`. Not deployed — run from
  source via `claude mcp add`, see README.

Load-bearing invariants — don't break these without understanding why:

- **The sanitizer is the XSS gate.** Display HTML is produced by ONE path and
  sanitized server-side. `core/src/domain/markdown.ts` and
  `web/src/lib/server/render.ts` are hand-duplicated **twins** (same unified
  pipeline + sanitize-html config); a drift-canary test in both suites fails
  if they diverge. Change both or neither. `{@html}` appears in exactly one
  web component (`PostBody.svelte`).
- **`/api/auth/*` is served by web, never core directly.** Emailed
  verify/magic-link clicks are native GETs with no `Origin`; better-auth 403s
  those, so `web/src/routes/api/auth/[...path]/+server.ts` injects `Origin`
  and relays cookies. Keep it.
- **Both catch-all proxies match the RESOLVED upstream path, never the raw
  `params.path`.** SvelteKit hands rest params percent-decoded, so `..%2f` is a
  real `../` that a string match misses and `fetch` then normalizes away —
  checking the segment instead of the path actually sent turned the auth proxy
  into a general-purpose core proxy (fixed 2026-08-04). Build the URL from an
  **absolute** string (never `new URL(params.path, base)` — that permits
  `//evil.host`), match on `target.pathname`, and keep the auth proxy confined
  to `/api/auth/`.
- **Feeds/federation are the only core paths reachable DIRECTLY** (`Caddyfile`'s
  `@core` matcher / `cloudron/nginx.conf`: per-user feeds, comments feeds,
  following OPML, WebSub+rssCloud callbacks, `/hub`). Everything else reaches
  core **only through web** — which is a real, internet-facing path, not
  "internal": `web/src/routes/api/v1/[...path]` forwards the whole key-authed
  surface (`/me/*`, `/admin-api/*`) and `web/src/routes/api/auth/[...path]`
  forwards auth. Do NOT read "core is internal" as "core is unreachable" and
  under-protect a core route on that basis; equally, the v1 proxy is by design,
  not a perimeter breach. Both proxies match the RESOLVED upstream path (below).

## Core building blocks — Hono + better-auth

These two carry the whole backend; lean on them for everything, and never
reach for a new dependency where they already solve it.

- **Hono is core's entire HTTP layer.** Any task in `core/` that touches
  routing, middleware, request/response, SSE, error handling, or route tests
  MUST invoke the project **`hono` skill** (`.claude/skills/hono/SKILL.md`)
  first — it encodes the house style (hand-rolled validators over
  `zValidator`, `c.json({error}, status)` over `HTTPException`, global
  `ContextVariableMap`, `app.request` tests, no RPC client). Follow it.
- **better-auth owns identity.** Before using any better-auth API, use the
  **`better-auth` MCP** (`search_docs` → `get_doc`) for the current shape —
  don't write it from memory (many bugs here came from an assumed API). Config
  lives in `core/src/auth.ts`; the web proxy (`/api/auth` invariant above) is
  load-bearing. Plugins ACTUALLY in use (`core/src/auth.ts`): `emailAndPassword`
  (hard verify), `magicLink`, `anonymous`, `multiSession` (max 4), `apiKey`
  (ONE call, an ARRAY of two configs — `user` and `admin`; a second `apiKey()`
  call would REPLACE the first, the plugin registry keys on a fixed id), and
  `openAPI` dev-only. Plus three hand-rolled `hooks.before` plugins:
  `reject-anon-api-key-create`, `reject-non-admin-admin-key`,
  `cap-magic-link-volume` — copy that shape for any new gate.
  Still backlog in `docs/superpowers/ideas.md` (NOT adopted): passkey,
  username, `@better-auth/mongo-adapter`.
  Dev-only: `RSC_AUTH_OPENAPI=on` mounts the better-auth OpenAPI
  reference at `/api/auth/reference`; it is **never public** — the flag
  defaults off in prod AND the web proxy hard-404s `/api/auth/reference` +
  `/api/auth/open-api/*` (both guards load-bearing; keep both).

## Working here

- **Dev runs in Docker:** `docker compose up` (core + web + Mailpit, live
  reload). This is the dev environment — not host `npm run dev`. Details in
  `README.md`. `docker/`, `compose.yaml`, `compose.prod.yaml`, `Caddyfile`.
- **Read the installed source before using an API** (Hono, better-auth,
  carta-md, feedsmith, Caddy) — or the `better-auth` MCP / context7 MCP for
  docs. Probe against the real version; never from memory. Many bugs here came
  from an assumed API shape or assumptions without first reading the code 
  and its existing patterns, always read the code first. 
- **Git:** shared checkout — a parallel session commits on `main` too, so
  **never `git add -A`**; stage explicit paths. End commit messages with "developed with the help of AI tools". remote is github.com/rmdes/rsc

## How work gets done here

Milestone flow: **brainstorm → spec → plan → subagent-driven execution.**
Specs (`superpowers:brainstorming`) and plans (`superpowers:writing-plans`)
land in `docs/superpowers/`; a **parallel Claude session reviews** specs and
plans, dropping findings into `docs/superpowers/reviews/` — fold them in as
numbered revs before proceeding. Execute with
`superpowers:subagent-driven-development` (fresh implementer per task, a
review after each, a whole-branch review on the most capable model at the
end). Bug fixes go through `superpowers:systematic-debugging` (root cause
before fix).

## Ponytail workflow

Ponytail mode (lazy/minimal, plugin `ponytail`) is auto-active every session;
the ladder (YAGNI → reuse → stdlib → native → one line → minimum) governs all
code written here. Use the sub-skills systematically:

- `/ponytail-review` — run on the diff after finishing any task that changed
  code, before committing.
- `/ponytail-debt` — run before planning a debt batch; it harvests every
  `ponytail:` shortcut comment into a ledger. Mark every deliberate
  simplification with a `ponytail:` comment so this stays accurate.
- `/ponytail-audit` — whole-repo over-engineering audit; run before large
  refactors or when the codebase feels heavy, not routinely.
- `/ponytail-gain`, `/ponytail-help` — informational, on demand.

Written reports from audit/debt/review runs follow the documentation layout
below: `docs/superpowers/reviews/YYYY-MM-DD-<topic>.md`.

## UI and design system

`design-system/rsc/MASTER.md` is the source of truth for all UI:
color tokens (light + dark via `light-dark()`), typography (**Archivo**
throughout — the Libre Bodoni / Public Sans pairing was REPLACED by the
Modernist revision; MASTER.md records the old one only as history), spacing, component specs, and RSC-specific constraints
(no-JS first-class, jank-free live prepends, local/remote legibility, text
first / enclosures second, theme toggle as enhancement only).

- Any task that touches UI — pages, components, styles, layout, colors,
  typography, accessibility — MUST invoke the `ui-ux-pro-max:ui-ux-pro-max`
  skill first, and MUST follow MASTER.md. Page-specific overrides go in
  `design-system/rsc/pages/<page>.md` and beat MASTER.md.
- When writing or reviewing SvelteKit/Svelte 5 code in `web/`, consult the
  relevant `svelte-skills` first — `svelte-runes` (state/derived/effect/
  props/bindable — the reactivity traps), `sveltekit-data-flow` (loads vs
  form actions, fail/redirect, serialization), `sveltekit-structure`
  (routing, layouts, SSR/hydration), `svelte-template-directives`
  (`{@html}`, `{@render}`, `{@attach}` over `use:`). They're pattern
  references, not a mandate to adopt every feature (we don't use remote
  functions or component libraries — YAGNI).
- No raw hex in components: every color comes from a `--color-*` variable
  defined in `web/src/app.css` (which mirrors MASTER.md). Change palette in
  both places or not at all.

## Documentation layout

All generated markdown lives under `docs/superpowers/`, by kind:

- `specs/` — design documents
- `plans/` — implementation plans
- `reviews/` — code-review findings, improvement suggestions, audits
- `documentation/` — operator/user docs (RUNNING.md, …)
- `ideas.md` — a single running backlog of vetted, not-yet-specced improvement
  ideas (name · mechanism · why-novel · grounding · tradeoff · status). Append
  new ones here; promote to a `specs/` doc when one is picked up.

Dated documents are named `YYYY-MM-DD-<topic>.md`. Don't create markdown at
the repo root or directly in `docs/` — `README.md` is the only exception.
Executed plans/specs are historical records: don't rewrite paths inside them
when files move; update live references (README, newer specs) instead.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
