# Textcaster — all-users RSS firehose (`/users/rss.xml`) design

Date: 2026-07-17 (rev 2 — folds in
`docs/superpowers/reviews/2026-07-17-firehose-spec-review.md`: push-out
scoped as real work (F-1), the local-posts query enumerated (F-2),
source:account pinned outbound-only (F-3))
Status: rev 2, ready to plan. better-auth HAS landed (4c88ed6..5cea86d) —
`core/src/api/app.ts` is stable again.
Author: Ricardo (rmdes) with Claude Code
Basis: rss.chat interop work (permalink guids `fac1e08`, `<source>`
attribution, `source:inReplyTo` threading — see memory `rsschat-interop`);
Dave Winer's implementation studied at `/home/rmdes/rss.chat-upstream/`
(`server/code/rssnetwork.js`: `buildFeedForEveryone`, `buildFeedItems`,
`getDefaultHeadElements` — pulled 2026-07-17).

## Why

We consume rss.chat's all-users firehose and rebuild its conversations with
per-item attribution; we publish nothing equivalent. A `/users/rss.xml`
firehose (Dave's convention) makes Textcaster a peer: one subscription
gives any aggregator — rss.chat tooling included — every local author with
correct attribution and threadable replies, over nothing but RSS 2.0 + the
source namespace. Interop-maximizing is the stated goal: emit what Dave's
generator emits, so his side round-trips ours the way ours round-trips his.

## The endpoint

`GET /users/rss.xml` on core (public, no auth — it is a feed). Content: the
most recent N posts by LOCAL users only, newest first, N = the same item
limit the per-user feeds use (read it from the existing feed route at plan
time; do not invent a new constant). Remote content is NEVER re-broadcast:
their feeds are the canonical source, and re-publishing others' content is
out of scope on both etiquette and SEC grounds.

Routing note: `/users/rss.xml` is a static path; it cannot collide with
`/users/:handle/feed.xml` (different segment count) — assert with a test
that a user named `rss` still gets `/users/rss/feed.xml` untouched.

## Channel (mirrors `buildFeedForEveryone`)

- `title`: `<host>: all posts` (host from PUBLIC_URL)
- `link`: PUBLIC_URL (placeholder-host rule from `channelLink` applies when
  unset, same as per-user feeds)
- `description`: `Posts from all users on <host>`
- `atom:link rel="self"` → `${publicUrl}/users/rss.xml`; `rel="hub"` when
  WebSub configured (same logic as per-user feeds)
- `<cloud …>` when rssCloud enabled (same shape as per-user feeds)
- `<source:self>` → the firehose URL (feedsmith generates channel
  `sourceNs.self` — probed 2026-07-17)

Deliberately skipped (cosmetic, no interop weight — do not add): channel
`<source:localTime>`, channel `<image>`.

## Items (mirrors `buildFeedItems(items, flSourceAttribution=true)`)

Every field the per-user feed emits, unchanged (title only when real,
`pubDate`, `description` per the dual contract, `source:markdown`,
`source:inReplyTo` + `thr:in-reply-to` on replies, `guid`), plus:

1. **RSS core `<source url="…">Name</source>`** on every item:
   `url` = the author's per-user feed (`${publicUrl}/users/<handle>/feed.xml`),
   element text = the author's displayName. feedsmith generates item
   `source: { title, url }` (probed).
2. **`source:comments`** via the existing `injectSourceComments` injector
   (feedsmith cannot serialize it — unchanged limitation).
3. **`source:account`**: `<source:account service="<host>"><handle></source:account>`
   — feedsmith DROPS `sourceNs.account` on generate (probed, same class as
   comments), so the injector grows a sibling: same guid-keyed matching,
   same xmlns bookkeeping. Delete both the day feedsmith serializes them.
   PINNED (review F-3): `source:account` is OUTBOUND-ONLY interop. Our
   ingest attributes from the RSS core `<source url>` element and never
   reads `sourceNs.account`; the round-trip money test asserts the former.
   Do not add phantom `account` consumption to "complete" the round trip.

## Local posts gain a permalink URL

`createLocalPost` sets `url = ${publicUrl}/post/<id>` when PUBLIC_URL is
configured (today local posts store `url: null`). Consequences, all wanted:

- Firehose and per-user items carry `<link>` (the shareable permalink the
  web UI already uses).
- Future replies TO local posts reference the permalink (`replyTo.url ?? guid`
  already prefers url), matching Dave's permalink-based `inReplyTo` style.
- Existing local posts keep `url = null` — no backfill, no migration; their
  items simply keep today's shape.

**Named divergence from Dave (deliberate — do not "fix"):** rss.chat emits
`guid isPermaLink="true"` where the guid IS the permalink. We keep stored
UUID guids emitted with `isPermaLink="false"`: changing guid VALUES would
make every existing post reappear as new to current subscribers and break
existing cross-instance reply refs that resolved against UUID guids.
Opaque guid + `<link>` is fully RSS 2.0 compliant; the permalink lives one
element over. New-post guids stay UUIDs for the same stability reason.

## Push-out (REAL WORK — review F-1, not a one-liner)

The firehose is a first-class push topic, both protocols. The catch:
`resolveLocalTopic` (push.ts:37) returns a user-shaped `{ user, format }`
and has THREE callers (topic-existence check, rssCloud format check, and
the notify path that renders THAT USER's feed for the fat ping). The
firehose topic has no user and renders the all-users feed, so:

- The resolver's return contract becomes a discriminated union —
  `{ kind: 'user', user, format } | { kind: 'firehose', format: 'xml' }` —
  or an equivalent sibling resolver; the plan picks after reading all
  three call sites.
- Every caller handles the userless case; the notify path renders the
  firehose XML for firehose-topic subscribers.
- On every local post, push notifies the firehose topic's subscribers in
  addition to the author's own feed subscribers (WebSub fat ping carries
  the firehose XML; rssCloud pings the topic URL).
- rssCloud registration for the firehose topic works like any other topic.

## New repository surface (review F-2)

No existing query returns "recent posts by all local users" —
`getPostsByAuthor` is single-author and `getTimeline` has no kind filter.
The firehose adds ONE repo method (+ Repository contract + service
passthrough):

- `getRecentLocalPosts(limit: number): Promise<Post[]>` — posts whose
  author has `kind = 'local'`, ordered `published_at DESC, id DESC`,
  limited. No cursor (feeds are windows, not pagination).

## What does NOT change

- Per-user feeds: byte-identical output for existing posts (guid scheme,
  item shape). New local posts add `<link>` there too — additive only.
- Ingest, threading, sanitizer, web UI: untouched.
- `injectSourceComments`'s existing behavior; it gains a sibling, not a
  rewrite.

## Testing

- Feed shape: required RSS 2.0 channel elements present (title, link,
  description); every item carries `<source url>` + guid; a local reply
  carries `source:inReplyTo` + `thr:`; `source:account` and
  `source:comments` present post-injection; xmlns:source declared once.
- Round-trip (the money test): feed the generated firehose XML through OUR
  OWN `parseFeedWithMeta` + `ingestItems` into a fresh repo as a remote
  user — every item lands with sourceName = author displayName,
  sourceFeedUrl = per-user feed, replies resolve into threads. This is the
  rss.chat consumption path run against ourselves.
- Guid stability: a post's guid in the firehose equals its guid in the
  per-user feed and never changes shape.
- `/users/rss/feed.xml` (a user literally named `rss`) still routes to the
  per-user feed.
- Permalink: a local post created with PUBLIC_URL set carries
  `<link>${publicUrl}/post/<id></link>` in both feeds; reply-to-local refs
  use that permalink.
- Push: a WebSub subscriber to the firehose topic receives a fat ping on
  local post creation (extend the existing federation-live pattern or the
  push unit tests, whichever is cheaper — decided at plan time).
- Post-deploy human check: validator.w3.org/feed on the live firehose.

## Sequencing

1. Local-post permalink url (service change + tests).
2. Firehose renderer in feed.ts (channel + items + injector sibling) +
   shape tests + round-trip test.
3. Route + push-out topic + push tests.
4. RUNNING.md: the firehose URL, what it carries, the divergence note.
