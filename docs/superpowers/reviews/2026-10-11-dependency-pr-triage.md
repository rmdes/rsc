# Dependency PR triage — 2026-10-11

Point-in-time findings. 18 open bot PRs went to 4; two of the remaining majors
were verified locally and both are real migrations, not bumps. Everything below
was run on the host in clean worktrees off `main` with a fresh `npm ci`.

**This repo has no CI on PRs.** `.github/workflows/` does not exist; the only
"checks" on a PR are Dependabot's own config validation and Renovate's artifact
errors. Local verification is the only gate, which is why
`.github/dependabot.yml` groups patch+minor but deliberately files each major
alone.

## Landed

- `8180ca2` — the 16-package patch+minor group (PR #42). Gates at merge:
  core typecheck 0, core 1224/1224, web 487/487, svelte-check 782 files / 0
  errors. Cherry-picked rather than merged to keep `main` linear, which is why
  GitHub could not auto-close #42.
- `af86d9c` — removed `@sveltejs/adapter-auto`. It was never used: web is
  always a Node server and the adapter is configured inline in
  `web/vite.config.ts` as `adapter-node`. kit 2.70 accepts plugin options and
  warns when a `svelte.config.js` exists alongside
  (`node_modules/@sveltejs/kit/src/exports/vite/index.js:150`); there is no
  `svelte.config.js` in this repo. Proof the removal is inert:
  `npm run build -w web` still prints `Using @sveltejs/adapter-node`.
- `dc84e85` — Renovate disabled. Both bots were live, so every major was filed
  twice and Renovate's one-PR-per-package style rebuilt the backlog
  `dependabot.yml` was written to end. Disabled rather than deleted: with no
  config file the Renovate app falls back to its own defaults and resumes.

## feedsmith v3 — BLOCKED, needs a migration

PR #24. Not a drop-in. v3 converts Atom text fields into text-construct
**objects**, and RSC binds those straight through to SQLite.

Measured on `feedsmith@3.0.1`:

- `core/src/domain/ingest.ts` — 2 tsc errors (TS2345 at 92,34 and TS2322 at
  94,89), both `title`.
- `core/test/migration-convert.test.ts` — 2 failures, `convergence matrix — 5a
  atom no-id+link` and `5b atom no-id no-link`, both
  `TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and
  null` at `seedPost` (test/migration-convert.test.ts:412).

The type errors understate it. Probed directly, `parseFeed` on an Atom entry
returns:

```
feed.title    {"value":"Feed Title"}
entry.title   {"value":"Entry Title"}
entry.summary {"value":"sum"}
entry.content {"value":"<p>body</p>","type":"html"}
entry.id      "urn:1"          <- still a string
```

and RSC's own `parseFeedWithMeta` therefore returns objects for **title and
content**. `toParsedItem` (`core/src/domain/ingest.ts:47`) declares
`content: string`, yet tsc flags only the two `title` sites — `content` reaches
persistence and rendering unchecked. The two test failures are the lucky case:
a loud SQLite bind error rather than a silent `[object Object]`.

Migration work, before this can be merged:

1. Unwrap text constructs at the ingest boundary — `it.title`, `it.content`,
   `it.summary` and `parsed.feed.title` in the `format === 'atom'` branch.
2. **Audit `<source url>`, now required by v3 per the RSS spec.** RSC emits
   `<source>` as its attribution byline and `parseFeedWithMeta` reads
   `sourceName` from it; this is a wire-format change on a documented interop
   surface.
3. RSS person fields became structured objects.
4. Parser errors were renamed/split (`DetectError`, `ParseError`,
   `MalformedError`, `GenerateError`) — check every `catch` in
   `core/src/domain/ingest.ts` and `core/src/logical/acquisition.ts`.
5. Lenient mode is gone; generate functions take `Date | string`.

feedsmith is the whole feed I/O layer in both directions — `parseFeed`
(`ingest.ts`, `logical/acquisition.ts`), `parseOpml` (`domain/source-service.ts`),
`generateRssFeed` + `generateJsonFeed` (`domain/feed.ts`), `generateOpml`
(`domain/opml.ts`) — so a green suite is weak evidence here. Re-validate against
valid.rss.chat after any v3 change.

## SvelteKit 3 + adapter-node 6 — mechanical, but a milestone

PRs #40/#34 (kit v3) and #28 (adapter-node v6). With `kit@3.0.1` +
`adapter-node@6.0.0` installed: web tests still pass 487/487, but
`npm run build -w web` **fails** and svelte-check reports 13 errors in 5 files.

Every failure is an import-path rename. The full verified map:

| from | to | surface |
| --- | --- | --- |
| `$lib` | `#lib` | 59 files, 153 occurrences |
| `$app/environment` | `$app/env` | 3 files, 4 occurrences |
| `Handle` from `@sveltejs/kit` | `@sveltejs/kit/hooks` | `src/hooks.server.ts` |
| `SubmitFunction` from `@sveltejs/kit` | `$app/forms` | `src/lib/confirm.ts`, `src/lib/ComposerDialog.svelte`, `src/routes/post/[id]/+page.svelte` |
| `tsconfig.json` extends | `$app/tsconfig` | 1 line |

Module homes confirmed in `web/node_modules/@sveltejs/kit/types/index.d.ts`
(`declare module '@sveltejs/kit/hooks'` for `Handle`, `declare module
'$app/forms'` for `SubmitFunction`). `$app/forms` (17 files), `$app/navigation`
(2) and `$env/dynamic` (4) are unchanged in v3 — only the `SubmitFunction`
import source moves.

The build error offers an escape hatch — `alias: { '$lib': 'src/lib' }` in the
SvelteKit config — which would cut the 153-occurrence rename to one line.

**Not merged, deliberately:** the `$lib` rename alone touches 59 files under
`web/src`, which collides head-on with the in-flight TimelineEntry retirement.
Sequence it after that lands, and prefer the alias over the mass rename unless
the mass rename is wanted for its own sake.

## Closed, with reasons

| PR | Why |
| --- | --- |
| #42 | landed as `8180ca2` |
| #21 #22 #23 #26 | superseded by #42 (better-auth 1.7.7, vitest 5.0.3, @types/nodemailer 8.0.2, MCP server 2.3.1) |
| #20 | `main` is on nodemailer 10.0.15; Dependabot will refile 10.1.0 in the next group |
| #39 #27 | `@sveltejs/adapter-auto` deleted in `af86d9c` — nothing left to bump |
| #41 #12 | TypeScript 7 is out of peer range: `svelte-check@4.7.6` declares `typescript: ^5.0.0 \|\| ^6.0.0`. #41 would also split the toolchain, putting core+mcp on 7 while web stays on ^6 |
| #38 | `@types/node` 26 would put types ahead of the runtime — Docker runs `node:24-bookworm-slim`, cloudron pins `ARG NODE_VERSION=22.22.2`, so tsc would accept APIs absent in production |
| #36 | Node 25 is an odd-numbered Current line, not LTS |
| #25 | duplicate of #35 |

## Still open

- **#35** cloudron/base 5.1.0 → 6.0.0 — held for a deliberate deploy window;
  it goes to all five live instances.
- **#40** kit v3, **#28** adapter-node v6, **#24** feedsmith v3 — mapped above,
  each needs its own task.

## Loose end

The push reported `1 low vulnerability on rmdes/rsc's default branch`
(`https://github.com/rmdes/rsc/security/dependabot/1`). Not investigated.

## Version drift worth converging

Three Node versions coexist: `engines: >=22.18` (root `package.json`),
`.node-version` `v24.18.0`, `docker/Dockerfile.{core,web}` `node:24-bookworm-slim`,
and cloudron `ARG NODE_VERSION=22.22.2` — the last tracked by no bot at all, as
`.github/dependabot.yml` already documents.
