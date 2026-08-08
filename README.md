# RSC — Really Simple Conversations

A feeds-native social timeline. People who post through the instance and
people who post on their own site are equal citizens in the same timeline —
posts, replies, and whole conversations travel as RSS, so following,
threading, and federation all work over open feeds instead of a proprietary
API.

Inspired by Dave Winer's [Textcasting](https://textcasting.org) and [rss.chat](https://github.com/scripting/rss.chat).
It uses RSS, OPML, JSON Feed, WebSub, and rssCloud today, and aims to add
IndieWeb interop (IndieAuth, Micropub, Webmention) next — see the roadmap.

> **Status: pre-release, but deep.** Not everything below is polished and no
> release is cut yet — but the timeline, posting and editing, threading, feeds
> in and out, real-time federation, rss.chat interop, and accounts all work end
> to end today. It's at the point where it's worth showing people. The founding
> design is in
> [`docs/superpowers/specs/2026-07-15-textcaster-design.md`](docs/superpowers/specs/2026-07-15-textcaster-design.md).

## What works today

**One live timeline, four tabs.** Local posts and polled-in remote feed items
share a single server-rendered timeline that updates live over SSE
(Server-Sent Events), filtered through four tabs: **local** (posts born here),
**federated** (connected RSC instances), **following** (you + who you
follow), and **explore** (everything) — labels and subtitles an admin can
rename per instance. Logged-in users land on *following*, guests on *explore*. Works with JavaScript off — tabs are plain links and the live
updates are a progressive enhancement, not a requirement.

**Your own feed reader.** Registered users subscribe to any RSS/JSON/Atom
feed by URL (capped per user, admin-configurable), follow people, and manage
it all — subscribe, unfollow, OPML import/export — from their following page.
Feed titles become display names automatically on first fetch.

**Rich posting.** A Markdown composer (built on [Carta](https://github.com/BearToCode/carta))
with syntax highlighting and a live preview. Line breaks, `:shortcode:`
emoji, GFM tables/strikethrough, and syntax-highlighted code blocks all
render through one [unified/remark](https://unifiedjs.com/) pipeline shared
between the editor preview and the published post — so what you preview is
what readers get. Composing opens in a resizable overlay with drafts that
survive a reload. Every post is sanitized server-side before it ever reaches
a browser.

**Live edits.** Authors can edit their own posts after publishing; each edit
keeps a full revision history (browsable per post) instead of silently
overwriting. Because posts travel as feeds, an edit stays current *everywhere
it federated*: it rides the post's stable permalink `guid` with an
`<atom:updated>` marker, so every instance that already ingested the post
detects the change on its next poll or push and updates its copy in place —
all over plain RSS, and without bumping the post to the top of
the timeline.

**Real conversations over plain RSS.** Replies are posts. Each conversation
appears once in the river at its root. A compact reply count expands the
sanitized thread inline, while the conversation permalink opens the complete
tree. Replies whose parent is not available remain visible with their carried
reply context instead of being silently discarded. Threads are reconstructed
from feeds using the RSS `source:` namespace (`source:inReplyTo`) plus RFC
4685 (`thr:in-reply-to`), with resolve-once matching, honest orphaning when a
reference can't be resolved, and adoption that heals out-of-order arrival — a
reply that shows up before its parent snaps into place when the parent lands.

**Feeds in.** Subscribe to any RSS, Atom, or JSON Feed. Import an OPML
blogroll. Feed discovery resolves an HTML page to its feed (`<link
rel=alternate>`) and ingests h-feed / microformats2 pages directly. Every
outbound fetch is SSRF-guarded with per-hop redirect re-validation.

**Feeds out.** Each user gets an RSS and a JSON feed; the instance also
publishes an all-users firehose at `/users/rss.xml` (Dave's rss.chat
convention). Local posts carry the Textcasting dual contract — rendered,
sanitized HTML for readers *and* the raw `source:markdown` beside it — plus
permalink `guid`s, `source:` attribution, and per-conversation
`source:comments` feeds. New posts are delivered in real time to subscribers
over both WebSub (fat pings) and rssCloud, and RSC receives the same
way (push-in), so federation is live, not just polled.

**Interop with rss.chat.** RSC consumes Dave Winer's rss.chat firehose
with correct per-item author attribution and full threading, and emits the
same `source:` namespace (`source:inReplyTo`, `source:markdown`,
`source:account`, `source:comments`) so his side can round-trip ours — a
conversation can federate A→B→A over nothing but RSS. Our feeds are walkable
by Dave's own [`threadwalker`](https://github.com/scripting/rss.chat)
verbatim: local posts use bare permalink `guid`s as the thread key, so his
reference walker reconstructs a RSC conversation with no changes. A
"Connected instances" panel advertises which Textcasting peers an instance
actually threads and interops with (detected from feeds that carry
`source:markdown`).

**Accounts.** Browse and post as an anonymous guest first (you get a
`@guest-xxxxx` handle on first write); upgrade to a permanent email + password
account with hard email verification; or sign in passwordlessly with a
magic link. Password reset included. Sessions and identity are handled by
[better-auth](https://www.better-auth.com/).

**Self-hosting.** A one-command Docker dev stack, and a production stack that
any VPS owner can run behind Caddy with automatic HTTPS (below).

## Roadmap

Not built yet, in rough order: IndieAuth sign-in and Micropub posting-in;
Webmention; OPML-category filtering of sources; media/enclosures and avatar
harvesting from source feeds. Trackable in [`docs/superpowers/specs/`](docs/superpowers/specs/).

## Develop

Docker Compose runs the whole dev stack — no host Node install needed.

```bash
git clone https://github.com/rmdes/rsc.git && cd rsc
make up                       # core + web + Mailpit, live reload
```

- App: [http://localhost:5173](http://localhost:5173)
- Mailpit (catches every outgoing email — verify links, magic links):
  [http://localhost:8025](http://localhost:8025)
- **Auth API reference (dev only):** with the dev stack up, browse
  <http://localhost:8787/api/auth/reference> for the better-auth OpenAPI/Scalar
  reference (raw spec at `/api/auth/open-api/generate-schema`). Enabled by
  `RSC_AUTH_OPENAPI=on` (set in `compose.yaml`); unset in prod, and the
  web proxy 404s it, so it is never public. After pulling, recreate core once so
  it picks up the env (`docker compose up -d core`). Full how-to + the
  reachability table: RUNNING.md → "Auth API reference (dev only)".

Edits to `core` and `web` hot-reload in the containers (`node --watch` and
`vite dev`). Federation push is off in dev. Run `make` to list every target;
prefer running against host Node instead of Docker? See
[`docs/superpowers/documentation/RUNNING.md`](docs/superpowers/documentation/RUNNING.md)
(Option B).

## Self-host on a VPS

```bash
# 1. Point DNS (A/AAAA) at the server for your domain first.
make prod-env       # prompts for domain + Mailpit password,
                    # generates secrets and writes .env
make prod-up        # build images + start behind Caddy
```

Caddy fronts everything and issues HTTPS automatically for
`RSC_DOMAIN` — no manual certificates. The Mailpit UI is reachable at
`/mail` behind HTTP basic-auth (the credentials `make prod-env` just
generated), since it displays every verify/magic-link email that goes out.
Federation (WebSub + rssCloud) is **on by default** in this stack.

**Mailpit only catches mail — it never delivers it.** That's fine for
trying the instance solo, but for real multi-user email (verification,
magic-link sign-in, password reset) you need real delivery: set
`RSC_SMTP_URL` (and `RSC_MAIL_FROM`) in `.env` to a real SMTP
server, e.g. `smtps://user:pass@smtp.example.com:465`, and redeploy.

## Architecture

Two workspaces in one repo:

- **`core`** — a headless Hono/Node service backed by SQLite, with
  `better-auth` for identity/sessions. It owns feeds, federation endpoints
  (WebSub, rssCloud), the ingest/threading logic, and the timeline API. It is
  never browser-facing.
- **`web`** — the SvelteKit app: the entire UI, and the only thing browsers
  talk to. It renders the timeline, sanitizes and serves content, and proxies
  auth + the SSE stream to core server-side.

In production, Caddy is the front door: it terminates HTTPS and routes core's
small **public** surface (feed/OPML XML, per-conversation comment feeds,
federation callbacks) directly to `core`, while everything else — the whole
UI and all of `/api/auth/*` — goes to `web`. `core` publishes no host ports
and is reachable only through that split. (Auth deliberately goes through
`web`, not straight to core: emailed verify/magic-link clicks are plain GET
navigations with no `Origin` header, and web's proxy supplies the `Origin`
that the auth layer requires.)

## Built with

Standards-forward, few dependencies, no framework lock-in:

- **core** — [Hono](https://hono.dev/) (HTTP) · SQLite via
  [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) +
  [Kysely](https://kysely.dev/) · [better-auth](https://www.better-auth.com/)
  (identity/sessions) · [feedsmith](https://github.com/macieklamberski/feedsmith)
  (RSS / Atom / JSON Feed / OPML parse + generate) ·
  [unified](https://unifiedjs.com/) / remark / rehype (Markdown → HTML) ·
  [sanitize-html](https://github.com/apostrophecms/sanitize-html) (the XSS
  gate) · [microformats-parser](https://github.com/microformats/microformats-parser)
  + [mf2tojf2](https://github.com/getindiekit/mf2tojf2) (h-feed ingest) ·
  [nodemailer](https://nodemailer.com/) (SMTP).
- **web** — [SvelteKit](https://svelte.dev/docs/kit) (Svelte 5 runes,
  `adapter-node`) · [carta-md](https://github.com/BearToCode/carta) +
  `@cartamd/plugin-slash` / `-emoji` (the Markdown editor) · the same unified
  pipeline for the live preview, with [DOMPurify](https://github.com/cure53/DOMPurify)
  guarding client-side paste.
- **ops** — [Docker Compose](https://docs.docker.com/compose/),
  [Caddy](https://caddyserver.com/) (auto-HTTPS), and
  [Mailpit](https://mailpit.axllent.org/) (dev/self-host mail).

## MCP server

Point a Claude session at your RSC account: read your timeline, follow a
conversation, and post or reply — over the Model Context Protocol.

Run `npm install` at the repo root first — `mcp/src/stdio.ts` resolves
`@modelcontextprotocol/server` from the hoisted root `node_modules`, and a
fresh clone has none.

```bash
claude mcp add rsc -e RSC_API_URL=https://rsc.example.org -e RSC_IDENTITIES=me:rsc_live_xxx -- node /path/to/rsc/mcp/src/stdio.ts
```

`claude mcp add` passes no environment by default; without `-e` the server
starts with `RSC_API_URL` unset and exits 1 immediately.

Two environment variables:

| Variable | Required | What it is |
|---|---|---|
| `RSC_API_URL` | yes | Your instance root, e.g. `https://rsc.example.org` |
| `RSC_IDENTITIES` | for posting | Comma-separated `name:key` pairs, from `/settings/api-keys` |

Three tools: `rsc_timeline` (needs `timeline:read`), `rsc_thread` (needs no
key), `rsc_post` (needs `posts:write`; set `inReplyTo` to reply).

`RSC_IDENTITIES` may name several accounts — a personal one and, say, a bot
account that posts release notes. Both `rsc_timeline` and `rsc_post` then
**require** their `as` argument: with more than one identity configured there
is no default, because whose timeline you are reading — and above all whose
voice a public federated post goes out in — should never be implicit.

Posting is public and federates over RSS. There is no delete tool; retract
from the web UI.

**Smoke test.** With the dev stack up (`docker compose up`), mint a key, set
the two variables, add the server, then call `rsc_timeline`, `rsc_post`, and
`rsc_thread` on the returned id — and confirm the post shows up in
`/users/<handle>/feed.xml`.

## Docs

- [`docs/superpowers/specs/`](docs/superpowers/specs/) — design documents for
  every major piece (spine, feeds, following, threading, rich content, the
  markdown composer, the firehose, auth, email, and Docker).
- [`docs/superpowers/documentation/API.md`](docs/superpowers/documentation/API.md) —
  the HTTP API: the keyless public firehose, and key-authed read/write access
  to your own timeline, posts, follows and profile. Keys are self-serve at
  `/settings/api-keys`.
- [`docs/superpowers/documentation/RUNNING.md`](docs/superpowers/documentation/RUNNING.md) —
  running RSC without Docker (npm workspaces directly), the full env
  var reference, and identity/session/email details.

## Credits

RSC stands on ideas and standards it did not invent:

- **Dave Winer** and [textcasting.org](https://textcasting.org) — the
  Textcasting manifesto, RSS, OPML, rssCloud, and
  [rss.chat](https://github.com/scripting/rss.chat)
- **The IndieWeb community** — Micropub, Webmention, IndieAuth, and
  microformats2.
- **JSON Feed** — Manton Reece and Brent Simmons.
- **WebSub** and the broader open-feed ecosystem.

![Alt](https://repobeats.axiom.co/api/embed/99fbb2c4ea3c4c4dd2475e42953a4c1379d1a0f8.svg "Repobeats analytics image")

## License

[MIT](LICENSE).
