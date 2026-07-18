# Textcaster on Cloudron — Package Design

**Status:** design (pre-release, personal self-host target)
**Date:** 2026-07-18
**References:** `/home/rmdes/cloudron-skills/packaging-cloudron-apps/SKILL.md`,
`/home/rmdes/indiekit/indiekit-cloudron/` (real Node/IndieWeb Cloudron package),
the current prod stack (`compose.prod.yaml`, `Caddyfile`, `docker/`).

## Goal

Package Textcaster as a **single Cloudron app** that installs on a Cloudron
box and runs the full instance — timeline, posting, threading, feeds in/out,
WebSub + rssCloud federation, and guest + email/magic-link/reset accounts —
behind Cloudron's automatic HTTPS, with no manual configuration beyond
`cloudron install`.

## Non-goals (pre-release)

- **Cloudron App Store submission polish** (postInstallMessage, install
  checklist, screenshots, certified backup/restore + update cycles).
- **Cloudron LDAP/OIDC integration.** Textcaster's identity is guest-first +
  its own better-auth (handles, federation). A Cloudron user directory is
  orthogonal and would break "browse/post as a guest." The owner signs in via
  the existing email account. OIDC is a possible future add.
- **MongoDB.** See "Data store" below — SQLite is what ships; Mongo was always
  a deferred adapter, not current reality.

## Success criteria

`cloudron build` + `cloudron install` on the operator's box, then a manual
smoke pass succeeds:

1. Home timeline renders (server-rendered, no-JS baseline works).
2. Compose a post → it renders rich (Carta/unified pipeline).
3. Reply → threads inline and on the conversation page.
4. Add a remote feed → it polls in within one interval.
5. Register an email account → the verification email **arrives** (Cloudron
   sendmail) and the link works; magic-link sign-in works.
6. A WebSub/rssCloud federation round-trip delivers a post live.
7. Restarting the app preserves the DB **and the session** (secrets are
   stable across restarts).

## Architecture

One container, three processes. An in-container **nginx** on the manifest
`httpPort` reproduces the current Caddy public-path split; `core` and `web`
keep the exact internal ports they use in `compose.prod.yaml` and are never
published.

```
Cloudron proxy (external HTTPS, terminates TLS)
        │
        ▼  httpPort 8000
   nginx (in-container)
        ├── 7 public feed/federation paths ─────────▶ core  127.0.0.1:8787
        └── everything else (UI, /api/auth, /stream) ▶ web   127.0.0.1:3000
                                                              │ (server-side)
                                                              └▶ core 127.0.0.1:8787
```

- **core** — Hono/Node service; owns SQLite, feeds, federation, ingest,
  timeline API, better-auth. Internal only (127.0.0.1:8787).
- **web** — SvelteKit `adapter-node` server; the only browser-facing surface;
  proxies `/api/auth/*` and `/stream` to core server-side. Internal only
  (127.0.0.1:3000).
- **nginx** — entry point on `httpPort`; the security boundary, transcribed
  from the `Caddyfile`.

TLS, certificates, and the `/mail` basic-auth block from the prod Caddyfile
all disappear: Cloudron terminates TLS outside the container, and the
`sendmail` addon replaces Mailpit entirely.

## Data store: SQLite on localstorage (not MongoDB)

Textcaster is natively a SQLite app: `core`'s data layer is
better-sqlite3 + Kysely, the migration system is the SQLite `user_version`
pragma, and better-auth is wired to the better-sqlite3 adapter. The DB file
lives at `/app/data/textcaster.db` (via the `localstorage` addon). This is a
first-class Cloudron pattern (e.g. `navidrome` ships SQLite-on-localstorage).

**Backup consistency.** Cloudron backs up `/app/data` at the filesystem level;
a naive file copy can catch a SQLite file mid-write (uncheckpointed WAL → torn
snapshot). Handling (detailed in the plan):

- Confirm/enable **WAL journal mode** on the core DB (the plan verifies whether
  Textcaster already sets this).
- Provide a **pre-backup checkpoint** so backups are consistent: a
  `WAL checkpoint(TRUNCATE)` (or `.backup` into a snapshot file) triggered by
  Cloudron's backup hook mechanism.

**Future (design-preserved):** the founding design (`…/2026-07-15-textcaster-
design.md`) names a MongoDB adapter as the eventual Cloudron operator's choice
and kept the `Repository` contract adapter-agnostic for it. When that adapter
is built, this package flips `localstorage` → the `mongodb` addon and maps
`CLOUDRON_MONGODB_URL`. Out of scope for pre-release; noted so the path stays
visible.

## File structure (`cloudron/` in the monorepo)

Consistent with `compose.prod.yaml`, `Caddyfile`, and `docker/` already living
in-repo.

```
cloudron/
├── CloudronManifest.json
├── Dockerfile
├── start.sh
├── nginx.conf
└── README.md          # operator: cloudron build + install, env, backups
```

The Dockerfile builds from the repo root (workspaces), so it needs the repo as
build context — `cloudron build` is run from the repo root with
`-f cloudron/Dockerfile` (exact invocation pinned in the plan).

## CloudronManifest.json

```json
{
  "id": "net.textcaster.app",
  "title": "Textcaster",
  "author": "Ricardo Mendes",
  "description": "A feeds-native social timeline — posts, replies, and conversations travel as RSS.",
  "tagline": "A feeds-native social timeline",
  "version": "0.1.0",
  "healthCheckPath": "/",
  "httpPort": 8000,
  "addons": {
    "localstorage": {},
    "sendmail": {}
  },
  "manifestVersion": 2,
  "minBoxVersion": "8.0.0",
  "memoryLimit": 1073741824,
  "website": "https://github.com/rmdes/textcaster",
  "contactEmail": "hello@rmendes.net",
  "icon": "file://logo.png",
  "tags": ["rss", "indieweb", "social", "feeds", "textcasting"]
}
```

- **Addons:** `localstorage` (SQLite + secrets in `/app/data`) and `sendmail`
  (outbound email). No postgres/mongodb/redis/ldap/oidc.
- **`httpPort: 8000`** — nginx listens here; core/web stay internal.
- **`healthCheckPath: "/"`** — nginx starts first, so it answers during boot;
  once web is up, `/` returns 200. Cloudron's start window covers boot.
- **`memoryLimit` ~1 GB** — core + web (SvelteKit SSR) + nginx are light
  (unlike indiekit's Eleventy build). Tunable; the plan measures actual RSS.
- Manifest metadata (`minBoxVersion`, id, icon) is verified/pinned in the plan.

## Dockerfile (single image, both services)

Sequence (concrete steps in the plan):

1. `FROM cloudron/base:5.0.0@sha256:04fd70dbd8ad6149c19de39e35718e024417c3e01dc9c6637eaf4a41ec4e596c`
   — **re-verify the current base + SHA from git.cloudron.io at build time**
   (never fabricate).
2. Install **Node 22.x** via the nodejs.org tarball (core runs `.ts` sources
   through native type-stripping → needs ≥22.18; mirrors indiekit's Node
   install). Pin the exact version in the plan.
3. Install `build-essential python3` as a **fallback** so **better-sqlite3**
   compiles if no prebuilt binary matches the Node ABI (glibc base → the
   prebuild usually applies; the build tools are insurance).
4. `WORKDIR /app/code`; copy the repo; `npm ci` at the root (workspaces).
5. **`npm run build -w web`** (adapter-node → `web/build/`).
6. **`ENV NODE_ENV=production` AFTER** the install + build (the devDeps-timing
   gotcha — setting it before `npm ci` drops the build tooling).
7. Symlink writable paths into `/app/data` **in the Dockerfile** (read-only at
   runtime): `core/data → /app/data`.
8. Copy `start.sh` + `nginx.conf` to `/app/pkg/`; `CMD ["/app/pkg/start.sh"]`.

Node runs as `cloudron:cloudron` via `gosu` (never root); `/app/code` and
`/app/pkg` are read-only at runtime — only `/app/data`, `/run`, `/tmp` are
writable.

## start.sh (supervisor)

Much lighter than indiekit's (no static-site build/watcher/atomic-swap/OOM
dance — SvelteKit builds at image-build time). Responsibilities, in order:

1. **Ensure dirs:** `mkdir -p /app/data/config`.
2. **Generate + persist secrets once** (never regenerated — regenerating
   `TEXTCASTER_AUTH_SECRET` invalidates every session):
   ```
   [ -f /app/data/config/auth_secret ] || openssl rand -hex 32 > /app/data/config/auth_secret
   [ -f /app/data/config/ops_token ]   || openssl rand -hex 32 > /app/data/config/ops_token
   export TEXTCASTER_AUTH_SECRET="$(cat /app/data/config/auth_secret)"
   export TEXTCASTER_TOKEN="$(cat /app/data/config/ops_token)"
   ```
3. **Map `CLOUDRON_*` → `TEXTCASTER_*`** and web env (see table).
4. **`chown -R cloudron:cloudron /app/data`**.
5. **Start nginx** (foreground-backgrounded) so health checks pass during boot.
6. **Start core** (`gosu cloudron:cloudron … node core/src/server.ts`) — core
   runs migrations automatically at boot; no migration step needed.
7. **Wait for core ready** (poll `127.0.0.1:8787/health`), then **start web**
   (`gosu cloudron:cloudron … node web/build/index.js`).
8. **Watchdog** — a `while … wait $PID` loop restarts a crashed process (core
   or web), mirroring indiekit's supervisor.

CWD for any process that may write diagnostics is `/tmp` (`/app/code` is
read-only).

## Env mapping

| Variable | Value / source | Consumer |
|---|---|---|
| `TEXTCASTER_PUBLIC_URL` | `$CLOUDRON_APP_ORIGIN` | core (federation) |
| `TEXTCASTER_WEB_ORIGIN` | `$CLOUDRON_APP_ORIGIN` | core (auth CSRF/Origin) |
| `TEXTCASTER_DB` | `/app/data/textcaster.db` | core |
| `TEXTCASTER_AUTH_SECRET` | generated once, persisted | core (better-auth) |
| `TEXTCASTER_TOKEN` | generated once, persisted | core (ops `POST /users`) |
| `TEXTCASTER_SMTP_URL` | built from `CLOUDRON_MAIL_SMTP_SERVER`/`_PORT`/`_USERNAME`/`_PASSWORD` | core (nodemailer) |
| `TEXTCASTER_MAIL_FROM` | `$CLOUDRON_MAIL_FROM` | core |
| `TEXTCASTER_WEBSUB` | `self` (default on) | core |
| `TEXTCASTER_RSSCLOUD` | `on` (default on) | core |
| `TEXTCASTER_PUSH_IN` | `on` (default on) | core |
| `CORE_API_URL` | `http://127.0.0.1:8787` | web |
| `PORT` | `3000` | web (adapter-node) |
| `ORIGIN` | `$CLOUDRON_APP_ORIGIN` | web (adapter-node CSRF) |
| `ADDRESS_HEADER` / `XFF_DEPTH` | `X-Forwarded-For` / depth for the Cloudron→nginx→web hops | web (`getClientAddress`) |

**SMTP URL construction:** `CLOUDRON_MAIL_SMTP_*` values may contain
URL-reserved characters → username/password must be percent-encoded when
building `smtp://user:pass@server:port`. The plan pins the exact construction
(Cloudron sendmail is typically plain SMTP on an internal port, no TLS).

**XFF depth:** there are now **two** proxies in front of the app (Cloudron's
proxy → in-container nginx). Per-IP rate limiting (core anon sign-in; web
`getClientAddress`) keys on the real client IP, so `XFF_DEPTH` and nginx's
`X-Forwarded-For` handling must be set so the real client — not the nginx or
Cloudron proxy IP — is read. The plan determines the exact depth empirically.

## nginx.conf

Transcribes the `Caddyfile` `@core` matcher. Public paths → core; everything
else → web.

```nginx
# core PUBLIC surface (feeds + federation callbacks) → core:8787
location = /users/rss.xml            { proxy_pass http://127.0.0.1:8787; ... }
location ~ ^/users/[^/]+/feed\.(xml|json)$   { proxy_pass http://127.0.0.1:8787; ... }
location ~ ^/users/[^/]+/following\.opml$    { proxy_pass http://127.0.0.1:8787; ... }
location ~ ^/post/[^/]+/comments\.xml$       { proxy_pass http://127.0.0.1:8787; ... }
location ^~ /websub/callback/                { proxy_pass http://127.0.0.1:8787; ... }
location = /rsscloud/notify          { proxy_pass http://127.0.0.1:8787; ... }
location = /rsscloud/pleaseNotify    { proxy_pass http://127.0.0.1:8787; ... }
location = /hub                      { proxy_pass http://127.0.0.1:8787; ... }

# SSE — MUST NOT buffer or the live timeline stalls
location = /stream {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    add_header X-Accel-Buffering no;
    proxy_read_timeout 24h;
}

# everything else → web:3000 (UI + /api/auth proxy + …)
location / { proxy_pass http://127.0.0.1:3000; ... }
```

- Standard proxy headers on every block: `Host`, `X-Real-IP`,
  `X-Forwarded-For`, `X-Forwarded-Proto https`.
- A small deny block for `.env`/`.git`/wp-probes (defense-in-depth, matches
  indiekit).
- **Path-matching parity is load-bearing** (it's the security boundary): the
  regex/prefix forms above must match exactly the Caddyfile's start-anchored,
  single-segment globs — `*` not crossing `/`. The plan pins each `location`
  form and adds a test that drives representative public/non-public paths and
  asserts each lands on the right upstream (mirroring the Docker milestone's
  ~30-path verification).

## Testing / verification

- **Build:** image builds clean (`cloudron build` from repo root with
  `-f cloudron/Dockerfile`); no `.env` or secrets baked in (`.dockerignore`
  covers `**/.env`).
- **Routing test:** a script (run against the built container or a local
  compose of nginx+core+web) driving each public path to core and
  representative non-public paths (UI, `/api/auth/*`, `/stream`) to web,
  asserting the upstream — the nginx analogue of the Caddy path-parity test.
- **Install smoke:** the 7 success-criteria steps on the operator's Cloudron.
- **Restart test:** `cloudron restart` → DB intact, still logged in (secrets
  stable).

## Open details resolved in the plan

1. Exact current `cloudron/base` version + SHA (verified from git.cloudron.io).
2. Exact Node 22.x version pin.
3. Whether core already sets SQLite WAL mode; if not, where to add it, plus the
   pre-backup checkpoint mechanism.
4. Exact `XFF_DEPTH` for the two-proxy chain.
5. SMTP URL construction with percent-encoding from `CLOUDRON_MAIL_*`.
6. Each nginx `location` form + the path-parity test.
7. `logo.png` source (reuse the existing brand asset).
```
