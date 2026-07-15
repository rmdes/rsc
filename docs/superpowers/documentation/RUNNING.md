# Running Textcaster

Textcaster is two deployables: **core** (headless API) and **web**
(SvelteKit client). The web app talks to core only over plain HTTP, from its
own server-side code — core is never exposed to browsers, and there is no
CORS to configure. Browsers only ever talk to the web app.

## Prerequisites

- Node.js 22.18+ (or 24+) — `core`'s dev script runs the TypeScript sources
  directly via Node's native type stripping (default from 22.18/23.6) and
  loads `.env` via `--env-file-if-exists`
- npm (workspaces are used; run all commands from the repo root)

## Install

```bash
npm install
```

## Configure

Copy the example env files and fill in a shared token:

```bash
cp core/.env.example core/.env
cp web/.env.example web/.env
```

`core/.env`:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TEXTCASTER_TOKEN` | yes | — | Bearer token core requires on writes. |
| `TEXTCASTER_DB` | no | `./data/textcaster.db` | SQLite file path, or `:memory:`. |
| `TEXTCASTER_PORT` | no | `8787` | HTTP port core listens on. |
| `TEXTCASTER_POLL_SECONDS` | no | `60` | How often remote feeds are polled. |

`web/.env`:

| Variable | Required | Notes |
|---|---|---|
| `CORE_API_URL` | yes | Base URL of core, e.g. `http://localhost:8787`. |
| `CORE_API_TOKEN` | yes | **Must equal core's `TEXTCASTER_TOKEN`.** |

There is no `PUBLIC_CORE_SSE_URL` and nothing core-related is marked
`PUBLIC_*` — the browser never holds the token or a core URL. Live updates
reach the browser through web's own `/stream` route, which proxies core's
SSE endpoint server-side.

## Feeds & push

Every local user's posts are published as standard feeds:

- `GET /users/<handle>/feed.xml` — RSS 2.0
- `GET /users/<handle>/feed.json` — JSON Feed 1.1

Another Textcaster instance can add either URL as a remote user — that is
the federation loop. A remote user's handle redirects (302) to their
canonical feed instead.

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

## Run

In two terminals, from the repo root:

```bash
npm run dev -w core
```

```bash
npm run dev -w web
```

Then open <http://localhost:5173>.

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

## Deployment note

The `/stream` route proxies core's SSE endpoint and needs a streaming-capable
host. `adapter-auto`'s static/serverless targets are fine for local dev but
don't hold a long-lived response open in production. If you deploy the web
app for real (Docker/self-host/etc.), switch to `@sveltejs/adapter-node`
first — dev mode (`npm run dev -w web`) streams fine as-is regardless of
adapter.

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

Create a local post (auth required — both `POST /users` and `POST /posts`
require `Authorization: Bearer <token>`, using core's `TEXTCASTER_TOKEN`):

```bash
curl -X POST http://localhost:8787/posts \
  -H "Authorization: Bearer $TEXTCASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"handle":"alice","displayName":"Alice","content":"hello, textcaster"}'
```

Add a remote user (also requires the bearer token):

```bash
curl -X POST http://localhost:8787/users \
  -H "Authorization: Bearer $TEXTCASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"handle":"bob-remote","displayName":"Bob","feedUrl":"https://example.com/feed.xml"}'
```
