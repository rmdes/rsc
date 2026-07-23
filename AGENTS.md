# RSC — agent guidance

Read `CLAUDE.md` before making changes. It is the detailed source of truth for
the architecture, load-bearing invariants, project workflow, UI rules, and Git
conventions. This file is the short operational entry point for agents that
automatically discover `AGENTS.md`.

## Repository shape

- `core/` is the internal Hono/Node service. It owns SQLite persistence,
  better-auth, feeds, ingest, threading, federation, and the timeline API. It
  runs TypeScript directly with Node 22 native type stripping; do not use
  TypeScript parameter properties in `core/src`.
- `web/` is the browser-facing SvelteKit/Svelte 5 application. Browsers must
  talk only to web. Web proxies auth, internal API calls, and the SSE stream to
  core.
- In production, only feed and federation endpoints from core are public. See
  `Caddyfile`; do not expose the rest of core.

## Load-bearing rules

- The Markdown sanitizer is the XSS gate. `core/src/domain/markdown.ts` and
  `web/src/lib/server/render.ts` are intentional twins protected by drift
  tests. Change both or neither. `{@html}` belongs only in
  `web/src/lib/PostBody.svelte`.
- `/api/auth/*` must go through web. The web proxy supplies the `Origin` header
  needed by emailed verification and magic-link navigations and relays cookies.
- Before changing UI, follow `design-system/rsc/MASTER.md`. Keep component
  colors tokenized through `web/src/app.css`.
- Preserve unrelated user changes. This is a shared checkout: stage explicit
  paths and never use `git add -A`.
- Commit messages must end with `developed with the help of AI tools`.
- Executed specs and plans under `docs/superpowers/` are historical records.
  Do not rewrite them to reflect later file moves; update live documentation
  instead.

## Development environment

Docker Compose is the primary development environment:

```bash
make up
```

The application is at `http://localhost:5173`, core is at
`http://localhost:8787`, and Mailpit is at `http://localhost:8025`.

Read `docs/superpowers/documentation/RUNNING.md` for configuration and
non-Docker operation. Read `docs/superpowers/documentation/TESTING.md` before
diagnosing test failures.

## Verification

When the Docker development stack is running, run tests inside its containers.
Host-side web commands may fail because the container owns Vite's temporary
directories.

```bash
docker exec rsc-core sh -c "cd /app && npm test -w core"
docker exec rsc-core sh -c "cd /app && npm run typecheck -w core"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm test -w web"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm run check -w web"
```

Unsetting `CORE_API_URL` for web verification is required. Compose supplies
`http://core:8787`, while web unit tests intentionally exercise the
`http://localhost:8787` fallback.

When the stack is not running, use the host commands:

```bash
npm test -w core
npm run typecheck -w core
npm test -w web
npm run check -w web
```

Run the smallest relevant test while iterating, then the complete affected
workspace suite and static check before claiming completion.
