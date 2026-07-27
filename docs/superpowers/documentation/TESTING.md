# Testing — running the suites & reproducing a run

Two Vitest suites plus static checks, run per workspace (there is no root test
script — this is an npm-workspaces monorepo):

| Workspace | Command | What it is |
|---|---|---|
| core | `npm test -w core` | `vitest run` — 92 files under `core/test/` |
| core | `npm run typecheck -w core` | `tsc --noEmit` (the ground truth; ignore stale LSP diagnostics) |
| web | `npm test -w web` | `vitest run` — 37 files under `web/src/**` |
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
Run the tests inside the container instead — but see Gotcha 3 below before
adapting these commands, since running vitest directly instead of through the
workspace script fails differently, and more confusingly:

```bash
docker exec rsc-web  sh -c "cd /app && env -u CORE_API_URL npm test -w web  -- src/routes/stream/server.test.ts"
docker exec rsc-core sh -c "cd /app && npm test -w core -- test/feed.test.ts"
docker exec rsc-web  sh -c "cd /app && env -u CORE_API_URL npm run check -w web"
```

**Gotcha 1 — `EACCES` on `.vite-temp` (host).** The dev stack bind-mounts the
repo at `/app` and the container runs as root, so it owns
`web/node_modules/.vite-temp/…`. A host-side `npm test -w web` then can't write
Vitest's bundled config and dies with `EACCES: permission denied`. Running
inside the container (which owns those paths) avoids it. Alternatively, stop the
stack (`docker compose down`) before running host-side.

**Gotcha 2 — `CORE_API_URL` collision (web only).** The container sets
`CORE_API_URL=http://core:8787`, but several web tests assert the
`http://localhost:8787` fallback (`base()`, now the single shared export in
`web/src/lib/server/session.ts`, and the SSE proxy). With the env var set,
those assertions see `http://core:8787` and fail (e.g. `stream/server.test.ts`
"proxies … with the right headers"). Prefix web test runs in-container with
**`env -u CORE_API_URL`** so `base()` uses the localhost fallback the tests
expect. Core tests don't read `CORE_API_URL`, so they don't need it.

**Gotcha 3 — a bare `vitest`/`npx vitest run` silently drops the web
aliases.** `docker exec`/`docker compose exec` into the `web` container lands
you in `/app` (the monorepo root, not `/app/web`), and vitest resolves its
config relative to CWD. Always go through the workspace script —
`npm test -w web -- <path>` (as in every example on this page) — never invoke
`vitest`/`npx vitest run` directly from `/app`. A direct invocation silently
misses `web/vitest.config.ts` and its `$lib`/`$env/dynamic/private` aliases,
so ordinary aliased imports fail with a misleading
`Error: Cannot find module '$lib/...'` — indistinguishable at a glance from a
real broken import, but it reproduces identically on a fully clean,
unmodified checkout (confirmed via `git stash`) and disappears the moment the
same file is run through `npm test -w web` instead. `npm test -w <workspace>`
always resolves the right config regardless of the shell's starting CWD; a
bare `vitest`/`npx vitest` does not.

## Notes

- LSP diagnostics like `SqliteRepository is missing <method>` are stale reindex
  artifacts during active development — `npm run typecheck -w core` is the
  authority; if it prints 0 errors, the code is fine.
- Container names assume the dev compose defaults (`rsc-web`,
  `rsc-core`); adjust if you renamed the services.
