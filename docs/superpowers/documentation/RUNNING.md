# Running Textcaster

Textcaster is two deployables: **core** (headless API) and **web**
(SvelteKit client). The web app talks to core only over plain HTTP, from its
own server-side code — core is never exposed to browsers, and there is no
CORS to configure. Browsers only ever talk to the web app.

Every routine command is wrapped in the repo `Makefile`. Run `make` with no
argument to list the targets; this guide uses them, and each target's exact
command is visible in `make help` and in the `Makefile` itself.

## Two ways to run

|                | Docker (Option A)                         | Local Node (Option B)                                |
| -------------- | ----------------------------------------- | ---------------------------------------------------- |
| **Best for**   | trying it, self-hosting, one-command start | hacking on core/web with host tooling (tests, LSP)   |
| **Needs**      | Docker + Compose v2                       | Node.js 22.18+ and npm                               |
| **Start**      | `make up`                                 | `make install`, then `make dev-core` + `make dev-web` |
| **Mailpit**    | bundled                                   | separate `docker run` (or real SMTP)                 |

Both serve the same app at <http://localhost:5173>. Pick one — you don't need
both.

## Option A — Docker (recommended)

One command brings up core, web, and Mailpit with live reload: edits to
`core/` and `web/` on the host hot-reload inside the containers
(`node --watch` + `vite`). No host Node install needed.

**Prerequisites:** Docker Engine and the Compose v2 plugin — check with
`docker compose version`.

### Dev stack

```bash
git clone https://github.com/rmdes/textcaster.git && cd textcaster
make up
```

- The **first** boot runs `npm ci` inside the container to populate the shared
  `node_modules` volume — it takes a minute (core's healthcheck allows a 60s
  start window). Later boots are fast.
- App: <http://localhost:5173>
- Mailpit — every outgoing email (verification, magic-link, reset):
  <http://localhost:8025>
- Both ports are bound to `127.0.0.1` only.

```bash
make logs      # follow all three services
make down      # stop the stack
```

Federation push is off in dev (no public URL). Writable state — the dev
SQLite DB, `web/.svelte-kit`, web's `node_modules` — lives in **named
volumes**, not the bind mount, so the containers (which run as root) never
leave root-owned files in your checkout. Removing the stack's volumes resets
the dev database.

### Auth API reference (dev only)

The dev stack serves a live [OpenAPI](https://swagger.io/specification/) /
[Scalar](https://scalar.com/) reference for every better-auth route (sign-in,
sign-up, verify, magic-link, reset, anonymous, …) — an interactive "Try it out"
console plus the raw spec. It is gated by `TEXTCASTER_AUTH_OPENAPI` (set to `on`
in `compose.yaml`, unset everywhere else) and is **never reachable in
production** (see the boundary below).

**Access it (browser):**

- Interactive console: <http://localhost:8787/api/auth/reference>
- Raw OpenAPI 3.1.1 JSON: <http://localhost:8787/api/auth/open-api/generate-schema>
  (feed this to a client generator or any OpenAPI tool)

Note the port: **8787 is core directly**, not the app on 5173. Core is bound to
`127.0.0.1` only, so the reference is local to your machine.

**One-time step after pulling this change.** The flag is read from the
environment, which Docker fixes when the container is *created* — `node --watch`
hot-reloads code but not env. So a stack that was already running won't have it
until you recreate core:

```bash
docker compose up -d core      # or: make up  — recreates core with the new env
docker compose exec core printenv TEXTCASTER_AUTH_OPENAPI   # → on
```

**Why it's safe (the two-guard boundary).** The reference lives under
`/api/auth/*`, which the web app proxies to browsers — so on its own the plugin
would publish an auth-docs console. Two independent guards prevent that, and
they hold live:

| URL | Result |
| --- | --- |
| `http://localhost:8787/api/auth/reference` (core, dev) | **200** — the console |
| `http://localhost:8787/api/auth/open-api/generate-schema` (core, dev) | **200** — the JSON spec |
| `http://localhost:5173/api/auth/reference` (via the web app) | **404** — proxy hard-blocks it |
| `http://localhost:5173/api/auth/open-api/generate-schema` (via the web app) | **404** — proxy hard-blocks it |
| `http://localhost:5173/api/auth/sign-in/anonymous` (via the web app) | **200** — normal auth still forwards |

So: reach it through **core on 8787** (internal/dev); through the **public web
app it is 404**. Guard 1 — the flag defaults off in prod and Cloudron, so the
plugin is never registered there. Guard 2 — the web auth proxy
(`web/src/routes/api/auth/[...path]/+server.ts`) returns 404 for
`/api/auth/reference` + `/api/auth/open-api/*` in **every** environment. A
single misconfiguration (flag flipped on in prod) still cannot leak it.

### Prod self-host on a VPS

```bash
# 1. Point DNS (A/AAAA) for your domain at the server first.
make prod-env      # prompts for domain + a Mailpit password; writes .env
                   # (strong secrets via `openssl rand`, Mailpit bcrypt hash via Caddy)
make prod-up       # build images + start the stack behind Caddy
```

- Caddy terminates HTTPS and issues certificates **automatically** for
  `TEXTCASTER_DOMAIN` — no manual certs.
- core publishes **no** host ports. It's reachable only through Caddy's
  public-path split (per-user feeds, the firehose, comment feeds, federation
  callbacks) and internally via web. `/api/auth/*` deliberately routes through
  web: emailed link clicks are native GETs with no `Origin` header, and
  web's proxy supplies the one better-auth requires.
- Mailpit's UI is at `/mail` behind HTTP basic-auth (the credentials
  `make prod-env` generated).
- Federation (WebSub + rssCloud) is **on** by default in this stack.

```bash
make prod-logs
make prod-down
```

Mailpit only *catches* mail — it never delivers to real inboxes. For a real
multi-user instance, set `TEXTCASTER_SMTP_URL` (and `TEXTCASTER_MAIL_FROM`) in
`.env` to a real SMTP server, e.g. `smtps://user:pass@smtp.example.com:465`,
then run `make prod-up` again. Every prod setting and its default is
documented in `.env.example`.

## Option B — Local dev (host Node)

Run core and web directly with your own Node — best when iterating with host
tooling (test runner, typechecker, editor LSP).

**Prerequisites:** Node.js 22.18+ (or 24+) — core's dev script runs the
TypeScript sources directly via Node's native type stripping (default from
22.18 / 23.6) and loads `.env` via `--env-file-if-exists`. npm is used with
workspaces, so run all commands from the repo root.

### Install and seed env files

```bash
make install       # npm install, then copy core/.env + web/.env from the
                   # examples if they don't exist yet (never overwrites)
```

Then set the one required value — the auth secret — in `core/.env`:

```bash
# core/.env
TEXTCASTER_AUTH_SECRET=$(openssl rand -hex 32)   # paste the output as the value
```

`core/.env`:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TEXTCASTER_AUTH_SECRET` | yes | — | better-auth session/cookie signing secret. Generate with `openssl rand -hex 32`. |
| `TEXTCASTER_TOKEN` | yes | — | Ops bearer token. No longer needed for user actions — its one remaining job is `POST /users` (feed seeding/smoke), also usable there in place of a registered session. |
| `TEXTCASTER_WEB_ORIGIN` | no | `http://localhost:5173` | Must match the web app's public origin. Any request that carries a session cookie to `/api/auth/*` without a matching `Origin` header is rejected 403 by better-auth's CSRF check. |
| `TEXTCASTER_ANON_TTL_DAYS` | no | `7` | Anonymous (guest) accounts idle longer than this are reclaimed by an hourly sweep. |
| `TEXTCASTER_ADMIN_EMAIL` | no | — | Comma-separated admin email(s). An account whose **verified** email matches becomes an instance admin (`isAdmin` on `/me`; unlocks admin-only routes like `GET /admin/status`). Unset = no admin (admin routes 403 for everyone). |
| `TEXTCASTER_SMTP_URL` | no | — | SMTP connection URL, e.g. `smtp://localhost:1025` (Mailpit, no TLS/auth) or `smtps://user:pass@host:465` (production). Unset means mail is off — see "Email" below. |
| `TEXTCASTER_MAIL_FROM` | no | `textcaster@<host of TEXTCASTER_PUBLIC_URL or TEXTCASTER_WEB_ORIGIN>` | From-address on outgoing mail. |
| `TEXTCASTER_DB` | no | `./data/textcaster.db` | SQLite file path, or `:memory:`. |
| `TEXTCASTER_PORT` | no | `8787` | HTTP port core listens on. |
| `TEXTCASTER_POLL_SECONDS` | no | `60` | How often remote feeds are polled. |

`web/.env`:

| Variable | Required | Notes |
|---|---|---|
| `CORE_API_URL` | yes | Base URL of core, e.g. `http://localhost:8787`. |

Web no longer needs a shared token — it forwards the visitor's own session
cookie to core instead. Nothing core-related is marked `PUBLIC_*` — the
browser never holds a core URL. Live updates reach the browser through web's
own `/stream` route, which proxies core's SSE endpoint server-side.

### Mailpit for local email

Optional — only if you want to exercise the email flows; the anonymous guest
flow needs no mail at all. (Option A bundles Mailpit; here you run it
yourself.)

```bash
docker run -p 1025:1025 -p 8025:8025 axllent/mailpit
```

Set `TEXTCASTER_SMTP_URL=smtp://localhost:1025` in `core/.env`, then read
captured verification/magic-link/reset emails at <http://localhost:8025>.

### Run

Two terminals, from the repo root:

```bash
make dev-core      # terminal 1
make dev-web       # terminal 2
```

Then open <http://localhost:5173>.

### Tests and checks

```bash
make test          # core + web test suites
make check         # typecheck core + svelte-check web
```

---

The rest of this document is **shared reference** — it applies however you
launched the instance.

## Identity & sessions

Textcaster uses [better-auth](https://www.better-auth.com/), mounted in core
at `/api/auth/*`, with cookie-based sessions (`textcaster.session_token`,
host-only, `httpOnly`, `SameSite=Lax`). There is no separate sign-up step to
start using the app:

- **Visitors act first.** The first write from a fresh browser (e.g.
  submitting the compose form) transparently mints an anonymous better-auth
  session and, with it, a local Textcaster identity handled `@guest-XXXXXX`.
  No form, no page reload.
- **Register to keep it.** Signing up while holding a guest session
  re-points that same identity at the new account — same handle, same
  posts, same follows — rather than creating a second one. Log in as an
  *existing* different account instead, and the guest identity is abandoned
  (its posts stay put; nothing is merged).
- **Idle guests are swept.** An anonymous identity untouched for
  `TEXTCASTER_ANON_TTL_DAYS` (and abandoned guests from the above) are
  deleted, cascading their posts and follows, by an hourly background sweep.
- **Adding a feed requires registration.** `POST /users` (add a remote
  user/feed) and OPML import (`POST /me/follows/opml`) 403 for
  anonymous sessions — each new feed is a standing polling cost, so only
  registered accounts can create them. Posting, replying, and following
  existing users work anonymously.
- **Behind a reverse proxy**, core's per-IP rate limiting (e.g. on anonymous
  sign-in) keys on `x-forwarded-for` as forwarded by the web server —
  production deployments must ensure the web server sets it to the real
  client address.

## Email (verification, magic link, password reset)

Email accounts require SMTP. Set `TEXTCASTER_SMTP_URL` to enable them; leave
it unset and the instance runs guest-only for email purposes (see below).
For where to point it, see the Mailpit notes in Option A/B above.

- **Hard verification.** `POST /register` (email + password) never signs the
  visitor in — an account can't sign in until its verification link (emailed
  on sign-up) is clicked. Guests keep working the whole time; only that one
  account is blocked until verified.
- **Magic link both logs in and verifies.** Requesting a login link
  (`POST /api/auth/sign-in/magic-link`) and clicking it is a full sign-in
  *and* marks the account verified in the same step — it's the recovery path
  for a registered-but-unverified account, not just an alternative to a
  password. NOTE (better-auth `revokeUnprovenAccountAccess`): when a magic
  link unblocks a *still-unverified* password registration, better-auth
  revokes that unproven password so a pre-verification hijacker can't keep
  it — the user's next password sign-in then fails, and they set a new one
  via `/forgot` → `/reset`. Expected, not a bug.
- **Guest → account carry-over is same-browser.** Registering while browsing
  as a guest keeps the guest's posts only if verification and the first
  sign-in happen in the SAME browser (the anon cookie is what links them).
  Verify on one device and first sign in on another → the guest is not
  carried over. Same-browser is the normal path; cross-device merge waits on
  IndieAuth.
- **Password reset** (`POST /api/auth/request-password-reset` then
  `POST /api/auth/reset-password`) needs mail for the same reason: the reset
  link is emailed.
- **Without SMTP, email accounts are unavailable.** `TEXTCASTER_SMTP_URL`
  unset means `GET /health` reports `mailEnabled: false`; core refuses
  `POST /sign-up/email`, `POST /sign-in/magic-link`, and
  `POST /request-password-reset` with `503` before any account row is
  created (no half-registered accounts), and the web app hides those forms
  behind a "post as a guest instead" message. The anonymous guest flow is
  entirely unaffected — it needs no email at all.

**Cloudron:** the mail addon injects its own SMTP env vars — point
`TEXTCASTER_SMTP_URL` at them (e.g. build it from `MAIL_SMTP_SERVER`,
`MAIL_SMTP_PORT`, `MAIL_SMTP_USERNAME`, `MAIL_SMTP_PASSWORD`) in the
package's start script or manifest env mapping; core itself only ever reads
`TEXTCASTER_SMTP_URL`.

## Feeds & push

Every local user's posts are published as standard feeds:

- `GET /users/<handle>/feed.xml` — RSS 2.0
- `GET /users/<handle>/feed.json` — JSON Feed 1.1

Another Textcaster instance can add either URL as a remote user — that is
the federation loop. A remote user's handle redirects (302) to their
canonical feed instead.

- `GET /users/rss.xml` — the firehose: every local post from every local
  user, newest first, RSS 2.0. Each item carries a core RSS `<source url=…>`
  naming its author and pointing at their personal feed (the same element
  our own ingest reads for attribution), so a subscriber can tell items
  apart even though they share one feed. It's a first-class push topic too —
  WebSub and rssCloud subscribers can register on it exactly like a
  per-user feed. Named divergence from the rss.chat/Dave convention
  (deliberate): rss.chat emits `guid isPermaLink="true"` where the guid IS
  the permalink; we instead put the shareable permalink in `<link>` and
  keep `<guid>` an opaque, stable UUID — changing guid values would make
  every existing post reappear as new to subscribers.

Push is **opt-in** (default: plain feeds, polling only):

| Variable | Values | Meaning |
|---|---|---|
| `TEXTCASTER_PUBLIC_URL` | `https://your.host` | Public origin; required for any push mode. |
| `TEXTCASTER_WEBSUB` | `off` (default) \| `self` \| hub URL | `self` runs a WebSub hub at `POST /hub`; a URL advertises that external hub and pings it on every local post. |
| `TEXTCASTER_RSSCLOUD` | `off` (default) \| `on` | Adds `<cloud>` to RSS feeds and serves `POST /rsscloud/pleaseNotify` (thin pings). |

Notes:
- Subscriber callbacks are verified with a challenge and must be public
  hosts — loopback/private addresses are rejected by design.
- Behind a reverse proxy, forward `X-Forwarded-For` — the rssCloud
  no-`domain` registration path needs the requester's address.
- Delivery is best-effort (one retry). Subscribers that miss a ping catch
  up on their next poll.

### Feed discovery

A followed URL returning an HTML page is automatically resolved to its
`<link rel="alternate">` feed, and the stored feed URL is rewritten to it.
IndieWeb pages with `h-entry` microformats but no feed link are ingested
directly, with the page re-parsed on each poll. Discovery runs at poll time
and is one-hop in the sense that the page is checked for a feed link once (no
discovery-of-discovery); the resulting feed fetch itself may still follow HTTP
redirects, each hop re-validated. Private-address links are rejected whether
direct or via redirect — SSRF-guarded.

### Receiving push (push-in)

When a followed feed advertises WebSub (`rel="hub"`, also honored from HTTP
`Link` headers) or an rssCloud `<cloud>` element, core subscribes
automatically and new items arrive by push instead of waiting for the next
poll. Push-subscribed feeds still poll as a safety net, at 10× the normal
interval.

| Variable | Values | Meaning |
|---|---|---|
| `TEXTCASTER_PUSH_IN` | `on` (default) \| `off` | Kill-switch. Effective only when `TEXTCASTER_PUBLIC_URL` is set (subscriber callbacks need a public address); without it, push-in stays dormant and polling continues. |

Callback endpoints (public, no auth — verified by construction):
`GET|POST /websub/callback/<token>` (token is per-subscription and
unguessable; fat pings must carry a valid `X-Hub-Signature`, any of
sha1/sha256/sha384/sha512 — invalid pings are discarded silently) and
`GET|POST /rsscloud/notify` (thin pings only trigger a re-fetch of the
already-stored feed URL, floored at once per 30 seconds per feed).

The rssCloud `<cloud>` element has no scheme field, so an https instance
registering on a non-443 public port still advertises an `http` callback;
serve push on `:443` when running behind https.

## Stale DB warning

**Schema changes are now migration-gated.** Core refuses to start against a
database it cannot handle, with a clear error instead of silent 500s:

- `pre-migration database — delete it (dev data only) and restart` — the file
  predates the migration system. **The first boot after this change will say
  exactly that for every existing dev DB, including freshly recreated
  spine-era ones.** Delete it:

  ```bash
  rm -f core/data/textcaster.db
  ```

- `database is newer than this build` — the file was created by a newer
  checkout; update your checkout (or delete the dev DB).

From now on, schema upgrades apply automatically at startup.

**Before deploying migration 11** (per-user feeds): verify no duplicate remote
`feed_url` exists, or the `UNIQUE(feed_url)` index build will fail. On each
instance, run:

```sql
SELECT feed_url, count(*) FROM users WHERE kind='remote' GROUP BY feed_url HAVING count(*)>1
```

This must be empty. If duplicates exist, merge/delete them before upgrading.

## Feature notes

- Posts carry an optional title: remote feed items keep the title from
  their feed; posts composed locally are untitled.
- Handles are lowercased and restricted to `[a-z0-9-]{1,64}`.
- Remote feeds accept RSS 2.0, Atom, or JSON Feed — whichever the URL
  serves.
- A newly added remote user's first poll backfills its existing feed items
  silently (no flood into the live timeline). From the second poll onward,
  new items appear live, the same as local posts.
- Feeds are polled every `TEXTCASTER_POLL_SECONDS` (default 60). A feed
  added just now shows its content within one poll interval.
- Local composes are **Markdown** (GFM — bare URLs autolink). With
  JavaScript on, the composer is a Markdown editor with live preview
  (Carta); without it, the same plain textarea as always — posts are
  identical either way. Single newlines are line breaks, like a chat or
  microblog, not classic Markdown. `:shortcode:` emoji work (e.g. `:tada:`
  → 🎉); type `:` in the editor for autocomplete. Fenced code blocks with a
  language tag are syntax-highlighted; without a tag they render plain.
  Typing literal HTML (e.g. `<div>x</div>`) is not supported — the tag
  vanishes and the text remains; this is deliberate. Type `/` in the editor
  for the slash command menu. Feeds emit the
  Textcasting dual contract: `<source:markdown>` carries your source
  verbatim, `<description>`/`content_html` the rendered (and sanitized)
  HTML, so readers that don't know `source:markdown` still see rich posts.
- Incoming `source:markdown` is preferred for display, per the Textcasting
  contract. Post bodies render a safe HTML subset — paragraphs, links,
  emphasis, quotes, headings, code, lists, lazy images — everything else is
  stripped at render time, server-side. Feeds always re-emit remote
  content untouched (pass-through); only display is sanitized.
- Post edits are tracked in the `post_revisions` table + `edited_at` column (migration 9). Local posts can be edited by their author; all revisions are retained and queryable via `GET /posts/<id>/revisions`.
- Instance-wide settings live in the `instance_settings` table (migration 11), keyed by name. Admin-only `GET/PATCH /admin/settings` exposes configurable knobs (e.g., `max_subs_per_user` for the per-user subscription cap).

## Following & lenses

A local user can follow remote feeds and other local users. The web app offers
two lens views of the timeline:

- `GET /u/<handle>` — author lens: timeline filtered to posts by `<handle>`
  only.
- `GET /u/<handle>/following` — followed lens: followed users' posts, with
  forms to manage follows (follow/unfollow), export following as OPML (`GET
  /users/:handle/following.opml`), and import follows from OPML.

**Self-serve subscriptions** (`POST /me/subscriptions`): registered sessions
only. Subscribe by feed URL (`{ url, type }`, where `type` is `"person"` or
`"webfeed"`); creates a follow edge. The endpoint is SSRF-guarded and enforces
a per-user cap (configurable via `GET/PATCH /admin/settings`, key
`max_subs_per_user`, default 500). Exceeding the cap returns `429`.

**Feed type taxonomy**: remote feeds carry a `feed_type` field (`"person"`,
`"webfeed"`, or `"instance"`). `"person"` and `"webfeed"` are self-serve
(created via `POST /me/subscriptions` or OPML import); `"instance"` is
admin-only (created via `POST /users`). On migration 11, existing rows were
classified as `"instance"` if their ingested items carried `source:markdown`
(Textcasting peer signal), else `"webfeed"`.

**Cleanup on orphaned feeds**: unfollowing the last follower of a self-serve
(`"person"` or `"webfeed"`) feed cascades deletion (polling stops); `"instance"`
feeds are never auto-cleaned, even if unused.

**Polling note:** Following an OPML import, feeds are picked up by the next
poller cycle — no synchronous fetch on import.

### API: query parameters and OPML routes

The timeline query supports two mutually exclusive lens filters:

| Query param | Meaning |
|---|---|
| `author=<handle>` | Posts by author `<handle>` (404 if unknown). |
| `followed_by=<handle>` | Posts by users followed by `<handle>` (404 if unknown). Requests both on the same query return `400`. |

Example:
```bash
curl http://localhost:8787/timeline?author=alice
curl http://localhost:8787/timeline?followed_by=alice
```

OPML routes (import requires a registered session; export is public):

| Method | Route | Notes |
|---|---|---|
| `GET` | `/users/<handle>/following.opml` | Export followed feeds as OPML. Public (no auth). |
| `POST` | `/me/follows/opml` | Import OPML. Registered session required (403 for anonymous — each imported feed is a new one). Core accepts up to 1 MB, flattens nested outlines, skips duplicates and non-`http(s)` feed URLs. |

**Web import upload size:** the browser import form POSTs through the
SvelteKit server, whose body limit (`BODY_SIZE_LIMIT`, ~512 KB by default
under `adapter-node`) can be smaller than core's 1 MB. Raise it on the web
host if operators need to import very large OPML files through the UI;
posting OPML directly to the core route is unaffected.

## Replies & conversations

Every post in the timeline links to its own `/post/<id>` page, labeled
"View conversation" when the post is itself a reply or a thread descendant
(`inReplyToPostId` or `threadRootId` set) and "Reply" otherwise — including
for a thread root that already has replies, since the timeline view never
fetches reply counts per post. That page is a plain HTML form — replying
needs no JS. An ingested reply whose ref never resolved to a local post
shows "in reply to ↗" pointing at the raw ref instead, when the ref itself
is an http(s) URL — a locally-composed reply's target is always a known
local post at compose time, so it never falls into this case.

Replies federate over the same plain feeds as everything else:

- Outgoing: a reply's feed item carries both `<source:inReplyTo>`
  (Textcasting) and `<thr:in-reply-to>` (RFC 4685) — dual-emit, no reader
  left behind.
- Incoming: ingest reads `source:`/`thr:` from RSS and Atom feeds (Atom
  exposes `thr:` only), and `u-in-reply-to` from IndieWeb `h-entry`
  microformats — a reply resolves to its parent by matching the parent's
  `url` (or, failing that, its `guid`) across instances.

Every post with at least one reply advertises the conversation in its own
feed item as `<source:comments count="N" feedUrl="…"/>`, pointing at:

| Method | Route | Notes |
|---|---|---|
| `GET` | `/post/<id>/comments.xml` | RSS feed of direct replies to `<id>` — the Winer-native "threadwalker" pull side. Always serves regardless of `TEXTCASTER_PUBLIC_URL`; only the `<source:comments>` advertisement pointing at it requires `TEXTCASTER_PUBLIC_URL` and is omitted without it. |
| `GET` | `/post/<id>/thread` | The whole conversation (root + all descendants) as JSON. |
| `PATCH` | `/posts/<id>` | Edit your own local post (session auth required, owner + source=`local` gate). No-op on unchanged content; records edit with prior version retained. |
| `GET` | `/posts/<id>/revisions` | Edit history for `<id>`; returns `{ post, revisions }` (prior versions oldest→newest, then the current post). Public; 404 if unknown. |

## Deployment note

The `/stream` route proxies core's SSE endpoint and needs a streaming-capable
host. The web app is already configured with `@sveltejs/adapter-node`
(`web/vite.config.ts`), which holds the long-lived SSE response open — the
Docker prod image (`make prod-up`) runs exactly this. Serverless/static hosts
that buffer or time out responses won't sustain the live stream; a plain Node
host or the bundled Docker stack will.

Serve production traffic over **HTTP/2** (any modern reverse proxy with TLS —
Caddy in the prod stack does this): over HTTP/1.1, browsers allow only 6
concurrent connections per origin and every open timeline tab holds one SSE
stream. The web app releases a hidden tab's stream and replays missed posts
when the tab returns, so tab count isn't fatal — but HTTP/2 removes the
ceiling entirely.

## Manual verification

### Two-tab live test

1. Open `http://localhost:5173` in two browser tabs.
2. In tab A, submit the compose form (handle + content).
3. Tab B's timeline updates with the new post immediately, with no reload —
   proof that the SSE proxy delivers live posts across sessions.

### JS-disabled test

1. Disable JavaScript in the browser (or use `curl`/a text browser).
2. Load `http://localhost:5173`.
3. The timeline, composer, and "add remote user" form all render and work:
   the compose and add-remote forms are plain HTML `<form>` posts handled by
   SvelteKit form actions, and the timeline itself is server-rendered. Only
   the live (no-reload) update is JS-only; everything else works without it.

## curl cheat sheet

Health check:

```bash
curl http://localhost:8787/health
```

Read the timeline (no auth required):

```bash
curl http://localhost:8787/timeline
```

Posting requires a session — without one, `POST /posts` 401s:

```bash
curl -i -X POST http://localhost:8787/posts \
  -H "Content-Type: application/json" \
  -d '{"content":"hello, textcaster"}'
```

Mint an anonymous session (the same one a fresh browser visitor gets on
their first action) — note the `Origin` header, required or better-auth
403s — and save the cookie:

```bash
curl -i -X POST http://localhost:8787/api/auth/sign-in/anonymous \
  -H "Origin: http://localhost:5173" \
  -H "Content-Type: application/json" -d '{}' \
  -c cookies.txt
```

Post under that session, then read the identity it minted:

```bash
curl -X POST http://localhost:8787/posts \
  -b cookies.txt -H "Content-Type: application/json" \
  -d '{"content":"hello, textcaster"}'

curl http://localhost:8787/me -b cookies.txt
```

Add a remote user (a new feed) — anonymous sessions are 403'd, since each
feed is a standing polling cost; the ops bearer token still works here (its
one remaining job, alongside a registered session):

```bash
curl -i -X POST http://localhost:8787/users \
  -b cookies.txt -H "Content-Type: application/json" \
  -d '{"handle":"bob-remote","displayName":"Bob","feedUrl":"https://example.com/feed.xml"}'
# → 403

curl -X POST http://localhost:8787/users \
  -H "Authorization: Bearer $TEXTCASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"handle":"bob-remote","displayName":"Bob","feedUrl":"https://example.com/feed.xml"}'
# → 201
```
