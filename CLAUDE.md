# RSC — project conventions

A feeds-native social timeline: local posts and remote feed items are equal
citizens; posts/replies/conversations travel as RSS. Full picture in
`README.md`; founding design in `docs/superpowers/specs/2026-07-15-textcaster-design.md`.

## Architecture

Two npm workspaces in one repo:

- **`core/`** — headless Hono/Node service, SQLite (better-sqlite3 + Kysely),
  `better-auth` for identity. Owns feeds, federation (WebSub/rssCloud),
  ingest/threading, the timeline API. **Never browser-facing.** Runs on Node
  22+ **native type stripping** — no build step, and therefore **no TypeScript
  parameter properties** in `core/src` (constructors assign fields plainly).
- **`web/`** — SvelteKit (Svelte 5 runes, `adapter-node`). The whole UI and
  the only thing browsers talk to; proxies auth + the SSE stream to core
  server-side via `CORE_API_URL`.

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
- **Feeds/federation are the ONLY core paths exposed publicly** (via Caddy in
  prod); the rest of core stays internal. See `Caddyfile`.

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
  load-bearing. Plugins in use: `emailAndPassword` (hard verify), `magicLink`,
  `anonymous`. Candidate plugins/adapters (passkey, username, multi-session,
  open-api; `@better-auth/mongo-adapter` for a future Cloudron-on-Mongo
  switch) are **backlog** in `docs/superpowers/ideas.md`, not yet adopted —
  each is a feature that goes through brainstorm→spec, not a drop-in.
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
color tokens (light + dark via `light-dark()`), typography (Libre Bodoni /
Public Sans), spacing, component specs, and RSC-specific constraints
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
