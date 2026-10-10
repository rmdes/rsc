---
name: run-rsc
description: Start, run, drive, smoke-test and screenshot RSC (the local docker dev stack — core + web + Mailpit). Use when asked to run RSC locally, start the dev stack, sign in as admin, exercise a feature end to end in the running app, verify a change "for real" (not just tests), take a screenshot of the UI, query the live dev database, or run the test suites.
---

RSC runs as a docker compose dev stack (core on :8787, web on :5173, Mailpit
on :8025). Drive it with `.claude/skills/run-rsc/driver.sh`: `curl` for
everything a user does (it signs in as the instance admin through a real
magic link and submits the UI's own form actions), headless `google-chrome`
for screenshots. All paths are relative to the repo root.

## Prerequisites

Docker with compose, `curl`, `python3`, and `google-chrome` (for screenshots
only). Node is NOT needed on the host — everything runs in the containers.

An admin address in the gitignored root `.env` (admin = that verified email):

```bash
grep -c '^RSC_ADMIN_EMAIL=.' .env    # must print 1
```

## Run (agent path)

```bash
.claude/skills/run-rsc/driver.sh up      # start/confirm the stack; waits for core healthy + web 200
.claude/skills/run-rsc/driver.sh login   # admin session via magic link -> Mailpit -> cookie jar
.claude/skills/run-rsc/driver.sh smoke   # health, web /, get-session, /admin/feeds as admin
.claude/skills/run-rsc/driver.sh flow    # whole source plane through the UI, then cleans up
.claude/skills/run-rsc/driver.sh shot /about about   # -> /tmp/rsc-shots/about.png
.claude/skills/run-rsc/driver.sh db "select count(*) as sources from remote_sources_v2"
.claude/skills/run-rsc/driver.sh test    # core typecheck + core/web suites + svelte-check
.claude/skills/run-rsc/driver.sh logout  # delete the cookie jar (it holds a live session token)
```

| command | what it does |
|---|---|
| `up` | `docker compose up -d`, polls core health and web `/`; auto-restarts web on a stale Vite pre-bundle 500 |
| `login` | POSTs web's `/api/auth/sign-in/magic-link` for `RSC_ADMIN_EMAIL`, reads the link from Mailpit's API, opens it, asserts a verified non-anonymous session. Jar: `/tmp/rsc-driver/jar.txt` |
| `smoke` | `PASS`/`FAIL` lines for the public routes and the admin feeds page |
| `flow [feedUrl]` | subscribe (`/?/subscribe`) → admin list + detail → pause → resume (2 audit rows) → following page + public OPML → unsubscribe → plain reap (refused) → force reap. Default feed `https://www.404media.co/rss/`. **Refuses** if that feed already exists as a source, because it force-reaps what it creates. Re-runnable; leaves the DB as found |
| `shot <path> [name]` | headless Chrome screenshot of a **public** web page → `/tmp/rsc-shots/<name>.png` |
| `db "<SQL>"` | read-only query against the **live** dev DB inside the core container; prints JSON rows |
| `test` | the gates, in the containers |

Every command prints `PASS`/`FAIL` lines and exits non-zero on the first failure.
`flow` asserts on the database, not on HTTP status (see Gotchas).

## Run (human path)

```bash
docker compose up -d    # then open http://localhost:5173; magic-link mail at http://localhost:8025
```

## Test

```bash
.claude/skills/run-rsc/driver.sh test
```

Expected: core typecheck PASS, core `1224 passed`, web `487 passed`,
`svelte-check found 0 errors and 0 warnings` (counts as of 2026-10-10).

## Gotchas

- **Call core through web, not directly.** Core answers **401** to the very
  session cookie that works through web (cookie present, `Origin` set — still
  401). Browsers never talk to core; drive the UI's form actions on web
  (`/?/subscribe`, `/admin/feeds?/source`, `/admin/feeds?/reap`,
  `/u/<handle>/following?/unsubscribe`) with `Origin: http://localhost:5173`,
  which SvelteKit's CSRF check requires. Core's public feed/OPML routes
  (`/users/<handle>/following.opml`) need no session.
- **Form actions answer 200 to curl, even on success.** No 303 redirect for a
  non-browser POST. Assert on the effect (`driver.sh db …`, page content).
- **The host can't typecheck or test.** The host's `node_modules` is stale:
  a host `tsc` fails even on unmodified code, and the editor shows phantom
  errors (e.g. `Cannot find module '@rsc/render/src/render.ts'`). Use
  `driver.sh test`; the containers have the current install.
- **The live dev DB is the core-data volume, not `core/data/dev.db`.** The
  host file is an old copy (it had 1 user while the live volume had 2).
  `driver.sh db` reads the right one. Inside the container, `better-sqlite3`
  (and `vitest`) live in `/app/core/node_modules`, not `/app/node_modules`.
- **The dev DB may be empty.** On 2026-10-10 it had 0 sources, so an admin
  list "passing" proved nothing. `flow` creates the data it needs.
- **Audited sources survive their last unsubscribe.** A source with audit rows
  (any admin action, e.g. pause/resume) is retained as `audit_history`; a
  plain admin reap is refused, and `force=true` is the override. A source
  with no audit rows is reaped automatically on the last unsubscribe.
- **curl writes HttpOnly cookies as `#HttpOnly_localhost …`** — `grep -v '^#'`
  on the jar hides exactly the session cookies (`rsc.session_token…`).
- **Screenshots are public-page only.** There is no `chromium-cli` here and
  Playwright isn't importable from the repo; `google-chrome --headless
  --screenshot` works but can't carry the session cookie.
- **Magic-link mail is capped at 20/hour instance-wide.** `login` once and
  reuse the jar; don't log in per command.

## Troubleshooting

- **web `/` returns 500 with `There is a new version of the pre-bundle for
  "…/node_modules/.vite/deps_ssr/…"`:** Vite's dependency cache went stale after
  a dependency change. `docker compose restart web` (web logs `Forced
  re-optimization of dependencies`). `driver.sh up` does this automatically.
- **`flow` FAILs with `… is already a source in the dev DB — refusing`:** by
  design. Pass a different feed: `driver.sh flow https://example.org/feed.xml`.
- **`smoke`/`flow` FAIL with `no session — run: … login`:** the jar is missing
  (e.g. after `logout`); run `driver.sh login`.
