# Running Textcaster

Textcaster is two deployables: **core** (headless API) and **web**
(SvelteKit client). The web app talks to core only over plain HTTP, from its
own server-side code — core is never exposed to browsers, and there is no
CORS to configure. Browsers only ever talk to the web app.

## Prerequisites

- Node.js 20+
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

## Stale DB warning

**The spine has no schema migrations yet.** If you're upgrading across a
schema change — including just pulling new commits after not running core
for a while — delete the dev database before starting core:

```bash
rm -f core/data/textcaster.db
```

An old-shape DB doesn't error at startup; it fails quietly later, as 500s on
every `POST /posts` and `POST /users`, and as swallowed-per-poll errors for
remote feeds. If core is throwing 500s on a fresh checkout, this is the
first thing to check.

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
