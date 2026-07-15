# Textcaster milestone 1 — feed output + WebSub/rssCloud push-out

Date: 2026-07-15
Status: design approved (brainstorm); implementation not started
Author: Ricardo (rmdes) with Claude Code
Basis: design spec `docs/superpowers/specs/2026-07-15-textcaster-design.md`
(deferred item 1); main at `94bf81a` (spine + debt batch + feedsmith).

## What this is

The milestone where the federation loop closes: every local user's posts are
emitted as standard feeds, so another Textcaster instance can ingest them as
a remote user — two instances federate over plain RSS with zero extra
protocol. Plus the publish side of real-time: WebSub (external hub by
default, self-hosted hub as an operator choice) and rssCloud (operator
toggle, off by default).

Decisions taken at design time:

- **Scope**: feed output + push-OUT only. Push-in (WebSub subscriber,
  rssCloud notification receiving) is the next spec, where it can test
  against our own hub.
- **Formats**: RSS 2.0 + JSON Feed 1.1 per user, via feedsmith's
  `generateRssFeed`/`generateJsonFeed`. No Atom output.
- **Hub strategy**: operator-selectable. Default = external public hub
  (`https://websubhub.com/hub`); `self` = core runs a spec-compliant WebSub
  hub; `off` = plain feeds.
- **rssCloud**: supported as publish-side, env-toggled, default off. There
  is no "external hub" variant — rssCloud's publisher IS the notification
  server, so enabling it always means core hosts the endpoint.
- **Approach A**: one push subsystem, one `subscriptions` registry shared by
  the self-hosted WebSub hub and rssCloud, with two thin protocol adapters
  for delivery. External-hub mode bypasses the registry entirely.

## 1. Feed output (core-only; web untouched)

Two public, unauthenticated routes on core:

- `GET /users/:handle/feed.xml` — RSS 2.0, `content-type:
  application/rss+xml; charset=utf-8`
- `GET /users/:handle/feed.json` — JSON Feed 1.1, `content-type:
  application/feed+json; charset=utf-8`

Semantics:

- Handle is looked up after the existing normalization (lowercase). Unknown
  handle → 404 JSON error.
- **Remote user's handle → 302 redirect to their canonical `feedUrl`** —
  pass-through per the Textcasting profile; we never republish someone
  else's feed as ours.
- Local user → newest **50** posts by display order, via a new Repository
  method `getPostsByAuthor(authorId: string, limit: number):
  Promise<Post[]>` (ordered `published_at DESC, id DESC`, same ordering as
  the timeline; contract-pinned).

One shared mapper (`domain/feed.ts`) turns `(user, posts, config)` into the
feedsmith input shapes. Textcasting profile rules, binding:

- Item `title` present **only when `post.title` is non-null** — title-less
  items are legal RSS and the profile's namesake feature. Never synthesize a
  title from content.
- Full `content` in RSS `description` / JSON Feed `content_text` — no
  truncation.
- `guid` = `post.guid` (RSS `isPermaLink="false"`), JSON Feed `id` =
  `post.guid`.
- `link`/`url` only when `post.url` is non-null.
- `pubDate`/`date_published` = `post.publishedAt`.
- Channel/feed level: title = displayName, description/home link from
  `TEXTCASTER_PUBLIC_URL` when set.

Discovery links: `rel="self"` (the feed's own absolute URL) and, when WebSub
is enabled, `rel="hub"` — RSS via `atom:link` elements, JSON Feed via
`feed_url` + `hubs: [{ type: 'WebSub', url }]`. When rssCloud is on, the RSS
feed (only) carries the `<cloud>` element. When `TEXTCASTER_PUBLIC_URL` is
unset, self/hub/cloud links are omitted and feeds still render.

**Round-trip test principle**: feed output correctness is asserted by
parsing our own generated feeds back through the existing `parseFeed` and
checking guid/title/content/url/date survive — the exact code path another
Textcaster instance would run.

## 2. Config

- `TEXTCASTER_PUBLIC_URL` — the instance's public origin (e.g.
  `https://cast.example.com`), used to mint absolute topic/self URLs.
  Optional for plain feeds (links omitted); **required at startup (fail-fast,
  same style as the token check) whenever any push mode is enabled.**
  Trailing slash normalized away.
- `TEXTCASTER_WEBSUB` = `off` | `self` | `<hub URL>`. Default:
  `https://websubhub.com/hub`. Any value that is not `off`/`self` must parse
  as an http(s) URL (fail-fast otherwise).
- `TEXTCASTER_RSSCLOUD` = `on` | `off`. Default `off`. Any other value
  fails fast.

## 3. Push subsystem (approach A)

### Storage — migration 2

The first real schema upgrade (and it earns the 1→2 upgrade-path test the
debt-batch final review requested):

```sql
CREATE TABLE subscriptions (
  id text PRIMARY KEY,
  protocol text NOT NULL,          -- 'websub' | 'rsscloud'
  topic text NOT NULL,             -- absolute feed URL
  callback text NOT NULL,          -- subscriber's delivery URL
  secret text,                     -- websub only, nullable
  expires_at text NOT NULL,        -- ISO
  created_at text NOT NULL,
  UNIQUE (protocol, topic, callback)
)
```

Repository additions (contract-pinned, adapter-neutral):

- `upsertSubscription(s: Subscription): Promise<void>` — insert or refresh
  (same protocol+topic+callback replaces secret/expiry).
- `deleteSubscription(protocol, topic, callback): Promise<void>`
- `listActiveSubscriptions(topic: string, now: string):
  Promise<Subscription[]>` — `expires_at > now`, both protocols.
- `purgeExpiredSubscriptions(now: string): Promise<void>` — housekeeping,
  called opportunistically from the existing poller loop.

### Event wiring

`domain/push.ts` exposes `createPush(repo, config, feedRenderer, fetchFn)`
returning `{ onLocalPost(entry): Promise<void> }`, wired in `server.ts` to
the existing bus (`bus.onNewPost` → only when `entry.source === 'local'`;
remote posts never change our feeds). Topics per event: the author's
`feed.xml` and `feed.json` absolute URLs.

Failures never propagate: every outbound notification path is wrapped and
logged (same convention as `pollAll`), with the existing 10s fetch timeout.

### Mode: external hub (default)

Per topic, form-POST to the configured hub:
`hub.mode=publish&hub.topic=<topic>&hub.url=<topic>` (`hub.url` kept for
hub compatibility, per websubhub.com's documented behavior). Fire-and-forget
with timeout + log. No registry involvement.

### Mode: self-hosted WebSub hub

- `POST /hub` (form-encoded, public): `hub.mode=subscribe|unsubscribe`,
  `hub.topic`, `hub.callback`, optional `hub.lease_seconds` (default 10
  days, capped at 30 days), optional `hub.secret` (<200 bytes).
  - Topic must be one of OUR feed URLs (an existing local user's feed under
    `TEXTCASTER_PUBLIC_URL`) → otherwise 404 in the verification sense
    (reject with 4xx). Callback must be http(s).
  - Respond `202 Accepted`, then verify per spec: GET
    `<callback>?hub.mode=&hub.topic=&hub.challenge=<random>&hub.lease_seconds=`;
    subscriber must echo the challenge with 2xx → store (upsert) or delete.
    Failed verification → no state change, logged.
- Delivery (fat ping) on topic update: regenerate the topic's feed body,
  POST it to each active callback with the feed's content-type, `Link`
  headers (`rel=self`, `rel=hub`), and `X-Hub-Signature:
  sha256=<HMAC-SHA256(secret, body)>` when the subscription has a secret.
- Best-effort delivery: per-subscriber timeout, ONE immediate retry, then
  drop. `ponytail:` known ceiling — no durable retry queue until real
  subscribers justify one.

### Mode: rssCloud (additive toggle)

- RSS feeds gain
  `<cloud domain=<public host> port=<public port> path="/rsscloud/pleaseNotify"
  registerProcedure="" protocol="http-post"/>`.
- `POST /rsscloud/pleaseNotify` (form-encoded, public): `notifyProcedure`,
  `port`, `path`, `protocol` (only `http-post` accepted; anything else →
  4xx), `url1` (the topic; must be one of our RSS feed URLs), optional
  `domain`.
  - With `domain`: verify via the rssCloud challenge (GET the callback with
    `url=<topic>&challenge=<random>`; body must contain the challenge).
    Without `domain`: callback host = the requester's IP, no challenge
    (spec behavior).
  - Registration stored in the same table, `protocol='rsscloud'`, fixed
    expiry **25 hours**; subscribers re-register daily (their job).
- Notification (thin ping) on topic update: form-POST `url=<topic>` to the
  callback. Subscriber re-fetches the feed. Same best-effort policy.

## 4. The money test (end-to-end federation loop)

One test, two in-process instances: instance A (repo+bus+service+app) has
local user alice with posts; instance B ingests
`http://a.example/users/alice/feed.xml` as a remote user through the
existing `ingestRemoteUser`, with a `fetchFn` stub that routes the URL to
A's `app.request`. Assert alice's post appears in B's timeline as a
`remote` post with guid/title/content intact — federation over plain RSS,
no extra protocol. This test is the milestone's definition of done.

## Non-goals

- Push-IN: WebSub subscribing to remote feeds, rssCloud notification
  receiving — next spec.
- Durable delivery queue / redelivery beyond one retry.
- Feeds for remote users beyond the 302 pass-through redirect.
- Atom output, OPML output, whole-instance firehose feed.
- Web-app changes of any kind (no profile pages, no link tags — no web
  surface exists for them yet).
- Rate limiting on the new public endpoints (spine-stage; note as a known
  gap in the hardening ledger).

## Testing approach

TDD throughout:

- Contract suite: `getPostsByAuthor` ordering/limit; subscription
  upsert/refresh, active-vs-expired filtering, delete, purge.
- Feed routes: RSS + JSON round-trip through `parseFeed` (guid/title-less
  item/content/url/date survive); 404 unknown; 302 remote; self/hub/cloud
  links present or omitted per config.
- Config: mode parsing, fail-fast rules (push without PUBLIC_URL; bad
  values).
- Self hub: subscribe happy path (challenge echoed → stored), failed
  challenge → not stored, unsubscribe, non-our-topic rejected, lease cap,
  delivery POST carries body + signature (verify HMAC in test), expired
  subscription not delivered, delivery failure retries once then drops
  without throwing.
- rssCloud: registration (http-post only), domain-challenge path, thin ping
  shape, 25h expiry.
- External mode: publish ping fired per topic on local post (fake fetch),
  never on remote ingest.
- Migration: fresh DB → version 2; **version-1 DB upgrades in place to 2**
  (posts/users data preserved); fail-fast cases unchanged.
- End-to-end: the two-instance loop test (§4).

## Sequencing

1. Config additions (modes, PUBLIC_URL, fail-fast rules).
2. Migration 2 + subscription repository methods + contract pins +
   1→2 upgrade test.
3. `getPostsByAuthor` + feed mapper + the two routes (+ round-trip tests,
   302/404).
4. Push module: external-hub publish ping (smallest mode first).
5. Self-hosted hub: subscribe/verify/unsubscribe, then delivery.
6. rssCloud: cloud element, registration endpoint, thin ping.
7. Two-instance federation loop test + RUNNING.md (new env vars, hub modes).
