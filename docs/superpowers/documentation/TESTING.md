# Testing — running the suites & reproducing a run

Two Vitest suites plus static checks, run per workspace (there is no root test
script — this is an npm-workspaces monorepo):

| Workspace | Command | What it is |
|---|---|---|
| core | `npm test -w core` | `vitest run` — 27 files under `core/test/` |
| core | `npm run typecheck -w core` | `tsc --noEmit` (the ground truth; ignore stale LSP diagnostics) |
| web | `npm test -w web` | `vitest run` — 15 files under `web/src/**` |
| web | `npm run check -w web` | `svelte-kit sync && svelte-check` (types + Svelte diagnostics) |

## What each suite covers (map)

- **core** (`core/test/`): the API surface (`api*.test.ts`), auth + sessions
  (`auth.test.ts`), feeds in/out and dual contract (`feed.test.ts`,
  `rich-content.test.ts`), ingest + discovery (`ingest*.test.ts`,
  `discovery.test.ts`), threading (`*threading*.test.ts`), federation
  (`federation*.test.ts`, `push*.test.ts`, `push-in.test.ts`), the SQLite
  adapter + migrations + WAL (`sqlite-repository.test.ts`, `migrations.test.ts`,
  `sqlite-wal.test.ts`), SSE (`sse.test.ts`), OPML, mail, config, the bus, and a
  `smoke.test.ts`.
- **web** (`web/src/**`): form actions (`*.actions.test.ts` for compose /
  addRemote / reply / follow / auth), page + layout loads (`*.load.test.ts`),
  the server render/sanitizer twin (`server/render.test.ts`), the cookie-relay
  session helpers (`server/session.test.ts`), the `/api/auth/[...path]` proxy,
  the SSE proxy (`stream/server.test.ts`), and lib units (draft, lens,
  plaintext, wedge, api).

## Reproducing a run

### Default — dev stack NOT running (or CI)

From the repo root on the host:

```bash
npm test -w core          # all core tests
npm test -w web           # all web tests
npm run typecheck -w core # core types
npm run check -w web      # web types + svelte-check
```

Filter to one file (path is relative to the workspace):

```bash
npm test -w web  -- src/routes/stream/server.test.ts
npm test -w core -- test/feed.test.ts
```

### When the dev Docker stack IS running — run tests INSIDE the container

Two gotchas make host-side `npm test` fail while `docker compose up` is live.
Run the tests inside the container instead:

```bash
docker exec textcaster-web  sh -c "cd /app && env -u CORE_API_URL npm test -w web  -- src/routes/stream/server.test.ts"
docker exec textcaster-core sh -c "cd /app && npm test -w core -- test/feed.test.ts"
docker exec textcaster-web  sh -c "cd /app && env -u CORE_API_URL npm run check -w web"
```

**Gotcha 1 — `EACCES` on `.vite-temp` (host).** The dev stack bind-mounts the
repo at `/app` and the container runs as root, so it owns
`web/node_modules/.vite-temp/…`. A host-side `npm test -w web` then can't write
Vitest's bundled config and dies with `EACCES: permission denied`. Running
inside the container (which owns those paths) avoids it. Alternatively, stop the
stack (`docker compose down`) before running host-side.

**Gotcha 2 — `CORE_API_URL` collision (web only).** The container sets
`CORE_API_URL=http://core:8787`, but several web tests assert the
`http://localhost:8787` fallback (`base()` in `web/src/lib/api.ts` and the SSE
proxy). With the env var set, those assertions see `http://core:8787` and fail
(e.g. `stream/server.test.ts` "proxies … with the right headers"). Prefix web
test runs in-container with **`env -u CORE_API_URL`** so `base()` uses the
localhost fallback the tests expect. Core tests don't read `CORE_API_URL`, so
they don't need it.

## Notes

- LSP diagnostics like `SqliteRepository is missing <method>` are stale reindex
  artifacts during active development — `npm run typecheck -w core` is the
  authority; if it prints 0 errors, the code is fine.
- Container names assume the dev compose defaults (`textcaster-web`,
  `textcaster-core`); adjust if you renamed the services.
