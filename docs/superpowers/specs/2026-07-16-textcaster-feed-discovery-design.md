# Textcaster — feed discovery (autodiscovery + h-feed)

Date: 2026-07-16
Status: design approved (brainstorm); implementation not started
Author: Ricardo (rmdes) with Claude Code
Basis: design spec `docs/superpowers/specs/2026-07-15-textcaster-design.md`
(microformats2 as an "alternate ingestion path"); surfaced by the following
milestone's bulk OPML import, where many outlines pointed at HTML pages
(`notiz.blog/`, `aaronparecki.com/all`) or homepages rather than feed URLs and
failed ingestion with "Unrecognized feed format".

## What this is

When a followed URL returns HTML instead of a parseable feed, ingestion today
fails. This milestone makes those URLs followable by **discovering** the feed:

1. **Autodiscovery** — an HTML page that advertises a feed via
   `<link rel="alternate" type="application/rss+xml|atom+xml|feed+json">`
   resolves to that feed, which is then fetched and parsed normally.
2. **h-feed (microformats2)** — an IndieWeb page with no feed at all, but with
   `h-entry` microformats, is parsed directly: the HTML page *is* the feed.

Polling remains the driver; discovery is a fallback that runs only when the
primary feed parse fails. A prerequisite fix already landed
(`1490d59`): feed fetches now send a descriptive `User-Agent` + feed `Accept`
header, so Cloudflare/WAF-protected feeds return the real feed instead of an
HTML challenge. Discovery handles the genuinely-HTML cases that remain.

Decisions taken at design time:

- **One hop only.** Discovery resolves at most ONE additional URL (the
  discovered feed). It never recurses into the discovered feed's own links.
- **Autodiscovery rewrites the stored `feedUrl`** to the discovered feed
  (self-healing): the bad URL is fixed once, and every later poll hits the
  real feed directly. h-feed-only pages keep the HTML page as their
  `feedUrl` (the page is re-parsed each poll).
- **One dependency, one parse.** `microformats-parser` yields both the
  `rel-urls` (autodiscovery links, with their `type`) and the h-feed `items`
  from a single parse of the HTML — so autodiscovery and h-feed share it.
- **Discovery runs at poll/ingest time, never at OPML-import time** — import
  stays fetch-free by design (SSRF posture + backfill rules).
- **Autodiscovery persistence is a one-way ratchet, accepted.** Once we
  rewrite P→F and F later dies while the site reverts to serving only the
  h-feed at P, `feedUrl` is stuck on the dead F. Low probability; accepted as
  a `ponytail:` ceiling ("re-discover after N consecutive fetch failures if
  it ever bites") rather than built now (review H2).
- **The discovery gate is a cheap `<`-sniff.** Discovery is attempted only
  when the feed parse fails AND the body's first non-whitespace char is `<`
  (HTML/XML-ish), so a large non-HTML blob is never handed to the mf2 parser.
  `mf2()` on non-markup is harmless (empty `items`/`rel-urls`) — the sniff is
  purely to avoid parsing garbage (review, ponytail).

## 1. The discovery ladder (`ingestRemoteUser`)

After fetching `feedUrl` and reading the body, `ingestRemoteUser` tries the
normal `parseFeedWithMeta`. On success, nothing changes. On failure **and**
when the body looks like HTML (first non-whitespace char `<`, or an
HTML-ish content-type), it enters discovery on the HTML already in hand:

1. **Autodiscovery.** `discoverFeed(html, pageUrl)` returns the first
   feed-typed `<link rel="alternate">` URL in document order (main feed
   precedes comments feed in WordPress output), resolved absolute against
   `pageUrl`.
   - If a feed URL is found and it differs from the one just fetched:
     - **SSRF guard**: `checkCallbackUrl(discoveredUrl)` — the URL is
       attacker-influenced content; reject loopback/private ranges before any
       request (same guard push-in uses).
     - **Loop guard first:** if the discovered URL equals the URL just
       fetched, do NOT re-fetch — fall through to h-feed (guard sits before
       the SSRF check and fetch).
     - Fetch it via a shared `fetchFeedBody(url, fetchFn)` helper (H3) —
       extracted from the primary fetch so the feed `User-Agent`/`Accept`
       headers, the 10s `AbortSignal` timeout, and the `MAX_FEED_BYTES`
       pre/post-read cap are one implementation used by both fetches, not
       copy-pasted. Parse via `parseFeedWithMeta`. On success: ingest its
       items, and **persist** the discovered URL with
       `repo.updateFeedUrl(user.id, discoveredUrl)` — **but only if no OTHER
       user already holds `discoveredUrl` as their `feedUrl`** (R1). `feed_url`
       has no UNIQUE constraint, so an unconditional rewrite could converge two
       users (one added for the HTML page, one for the direct feed) onto one
       `feedUrl` string — silently breaking import case-1's feedUrl-keyed Map
       and double-ingesting. Check via `listRemoteUsers()` (collision is rare —
       only on autodiscovery success); on collision, skip the rewrite and keep
       the page URL (this user keeps re-discovering through the page each poll —
       wasteful but correct; user-level merge stays out of scope). Items from
       this poll are ingested either way.
     - **Hub/discovery metadata (H4):** in the autodiscovery branch the
       merged `FeedDiscovery` (`rel="hub"` from the `Link` header + feed body)
       is taken from the **discovered feed's** response, not the HTML page's
       response.
2. **h-feed.** If no feed link, `discoverFeed`'s `hentries` (parsed from the
   same HTML) are ingested directly. The `feedUrl` is left unchanged — the
   page is the feed and is re-parsed on each poll. `hasPostsByAuthor`
   backfill rules and guid dedup apply exactly as for feeds.
3. **Neither.** No feed link and no h-entries → the original parse failure
   stands; `pollAll`'s per-user catch logs it (e.g. "no feed found").

`ingestRemoteUser`'s return shape (`{ inserted, discovery }`) is unchanged;
the WebSub/rssCloud `discovery` metadata is still taken from a successfully
parsed feed (autodiscovered or direct). h-feed ingestion returns
`NO_DISCOVERY` (an HTML page advertises push via its own `<link rel="hub">`,
out of scope here).

## 2. `discoverFeed` (pure, no I/O)

New module `core/src/domain/discovery.ts`:

```ts
export interface Discovered {
  feedUrl: string | null          // first alternate feed link, absolute
  hentries: ParsedItem[]          // h-feed items (empty if none)
}
export function discoverFeed(html: string, pageUrl: string): Discovered
```

- Parses `html` once with `microformats-parser` (`mf2(html, { baseUrl: pageUrl })`),
  yielding both `rel-urls` (autodiscovery) and `items` (h-feed) — one parse,
  both halves.
- **feedUrl**: from `rel-urls`, the first entry (document order) whose `rels`
  include `alternate` and whose `type` is one of `application/rss+xml`,
  `application/atom+xml`, `application/feed+json`. **Bare `application/json`
  is excluded** — too many non-feed links carry it (review). Absolute (the
  parser resolves against `baseUrl`).
- **hentries**: convert the parsed `h-feed`/`h-entry` items to **JF2** with
  `@paulrobertlloyd/mf2tojf2`, then map each JF2 `entry` → `ParsedItem`. JF2
  flattens mf2's nested property arrays into `{ type, name?, content?,
  published?, url?, uid? }`, which is both cleaner to map and the idiomatic
  IndieWeb intermediate representation:
  - `guid` = `uid` ?? `url` ?? deterministic fallback (see below).
  - `url` = JF2 `url` or null.
  - `title` = JF2 `name` **only when JF2 retains a distinct name** — JF2
    conversion / post-type-discovery drops the *implied* `p-name` that mf2
    derives from an untitled note's own text, so a note does not get a bogus
    title (this is the H1 fix). **Plan-time probe:** confirm mf2tojf2 drops
    implied names; if it does not, apply the fallback heuristic — treat
    `name` as a title only when it is NOT a prefix of the whitespace-
    normalized content (the IndieWeb implied-name test), never mere `!==`.
  - `content` = JF2 `content.text` (or `content` when a string), else
    `summary`. If content is empty and only `name` exists, content = `name`
    and `title` = null (never title === content).
  - `publishedAt`/guid: route the mapped fields through the **exported**
    `toParsedItem(...)` from `ingest.ts` so h-entries inherit the exact
    determinism the feed path already fixed — the fallback guid hashes the
    **raw** `published` string (or `''` when absent), never the defaulted
    `now`, and future dates clamp to now (review H5).
- Exported as a pure function, unit-testable without network.

`discovery.ts` reuses the existing `ParsedItem` type and the `toParsedItem`
helper (both promoted to exports from `ingest.ts` — no logic change), so the
h-feed path and the feed path share one item-construction discipline.

## 3. Data model — `updateFeedUrl`

No migration (the `feed_url` column exists). One new repository method,
contract-pinned and adapter-neutral:

```ts
updateFeedUrl(userId: string, feedUrl: string): Promise<void>
```

- SQLite: `UPDATE users SET feed_url = ? WHERE id = ?`.
- Contract pins: after `updateFeedUrl`, `getUser` reflects the new URL;
  updating a non-existent id is a silent no-op (consistent with the other
  idempotent writes).

Only autodiscovery calls it (h-feed leaves `feedUrl` as the page URL).

## 4. Dependencies

Two IndieWeb-standard packages, both justified per the project's dependency
rule (propose it; say why stdlib/existing won't do):

- **`microformats-parser`** — the reference mf2 parser for JS. mf2 is a real
  specification (nested microformats, the value-class date pattern, implied
  properties) not worth hand-rolling; feedsmith parses feeds only (no
  HTML/mf2/`rel` autodiscovery); and one parse yields both the autodiscovery
  `rel-urls` and the h-feed `items`, so it does double duty.
- **`@paulrobertlloyd/mf2tojf2`** (v3) — converts mf2's nested-array items to
  **JF2**, the flat IndieWeb rendering representation. It earns its place two
  ways: the h-entry → `ParsedItem` mapping becomes a handful of flat property
  reads instead of `properties.x[0]`-style spelunking, and — critically — JF2
  conversion / post-type-discovery is the principled place the *implied*
  `p-name` gets dropped, which is the H1 note-vs-article fix. This is the
  idiomatic pairing (both from the Indiekit lineage).

**Confirmed at review** (against `microformats-parser@2.0.6` type defs, so the
one-parse-yields-both claim is not assumed): `mf2(html, { baseUrl })` returns
`{ rels, "rel-urls": Record<url, { rels: string[]; type?: string; … }>, items }`
— `type` IS exposed per rel-url, `baseUrl` is required and resolves relative
hrefs, `items` carry `type: string[]` + `properties` + `children`, and
`content` is `{ html, value }`. `mf2` is a named export.

**Plan-time probes** (before embedding code, as done for feedsmith/kysely):
(1) `@paulrobertlloyd/mf2tojf2`'s exact JF2 output shape and its named export;
(2) whether it drops implied `p-name` (if not, the §2 prefix-heuristic
fallback applies); (3) ESM interop under Node native type-stripping — the repo
is `"type": "module"` with no bundler, so confirm both packages expose an ESM
entry in their `exports` map (review H6).

## 5. The money test (end to end)

An in-process instance adds a remote user whose `feedUrl` is an HTML page. A
staged `fetchFn` returns: (1) the HTML page (with a `<link rel="alternate"
type="application/rss+xml" href="/feed.xml">`) for the page URL, and (2) a
valid RSS body for the resolved feed URL. After `ingestRemoteUser`:

- the feed's items are ingested as the user's posts, AND
- `getUser(id).feedUrl` has been rewritten to the discovered feed URL
  (so a second poll fetches the feed directly — asserted by the fetch stub
  seeing only the feed URL on the second call).

A sibling test: an HTML page with h-entries and NO feed link → the h-entries
are ingested, and `feedUrl` is unchanged.

## 6. Security

- The discovered feed URL comes from attacker-influenced page content, so it
  passes `checkCallbackUrl` (loopback/link-local/RFC-1918/ULA rejection)
  before any fetch — the same guard the push-in callbacks use. That guard also
  enforces **http(s)-only**, so it doubles as the scheme gate: a
  `<link rel="alternate" href="file:…">` or `itpc:` garbage link is rejected
  for free. The DNS-rebind residual ledgered in milestone 1 applies equally
  and is not re-litigated.
- **Redirect posture (R2 — UPGRADED during implementation).** The spec
  originally accepted following redirects with a documented residual (a public
  redirector could point the post-guard fetch at a private address). An
  automated security review flagged this HIGH, and the operator chose to close
  it on **both** fetch paths rather than accept the residual. Implemented:
  `fetchFeedBody` uses `redirect: 'manual'` and re-validates **every** hop's
  resolved `Location` through `checkCallbackUrl` before following (capped at 5
  hops), so legitimate feed 301/302s still work while a redirect to a private
  address is refused. And the **primary `user.feedUrl` fetch is now guarded
  too** (it was previously unguarded — a member could point `feedUrl` straight
  at an internal address); both fetches route through the one guarded
  `fetchFeedBody`, so no fetch path bypasses the SSRF check. The only residual
  is DNS-rebinding (TOCTOU between resolve and connect), which stays ledgered
  from milestone 1. (This exposed and fixed a real prod gap: push-in's
  `runPollCycle`/`handleThinPing` were dropping `lookupFn` before
  `ingestRemoteUser`.)
- One-hop limit bounds amplification: a malicious page cannot chain us
  through many fetches; discovery issues at most one extra request.
- The 10s fetch timeout and `MAX_FEED_BYTES` cap apply to the discovered
  fetch exactly as to the primary feed fetch.

## 7. Testing

- `discoverFeed` unit tests (no network): `<link rel=alternate>` for rss /
  atom / json returns the absolute URL; relative href resolved against the
  page URL; multiple alternates → first feed-typed in document order;
  h-feed HTML → mapped `ParsedItem`s (guid from uid/url; raw-date guid
  determinism); **an untitled note h-entry → `title === null`, content intact
  (the H1 implied-name case), and a genuinely-titled article h-entry → title
  retained**; page with neither → `{ feedUrl: null, hentries: [] }`; a
  Cloudflare-challenge HTML → nulls.
- Contract suite: `updateFeedUrl` reflects in `getUser`; no-op on unknown id.
- `ingestRemoteUser` integration (staged fake fetch): HTML→autodiscover→feed
  ingests + persists the new `feedUrl`; discovered URL == failed URL does not
  loop; SSRF-rejected discovered URL → no second fetch, failure logged;
  h-feed-only page ingests h-entries and leaves `feedUrl` unchanged;
  **collision (R1): when another user already holds the discovered URL, the
  rewrite is skipped (page-user keeps the page URL) but the items still
  ingest**; **redirect (R2): a discovered feed served via a 301 still ingests
  (redirects are followed).**
- Money test (§5) + the h-feed sibling.

## Non-goals

- OPML-time discovery (import stays fetch-free; discovery is a poll-time
  fallback).
- Recursively discovering the discovered feed's own `rel` links (one hop).
- WebSub/hub discovery from HTML pages (push-in already discovers hubs from
  feeds and Link headers; an HTML `<link rel="hub">` is out of scope here).
- Multiple feeds per site / letting the operator choose among discovered
  feeds (first feed-typed alternate wins).
- Writing h-feed OUT (this is ingestion only).
- User-level dedup/merge: two users that resolve to the same feed content will
  both ingest it (double posts under two authors). R1 only prevents them
  sharing an identical stored `feedUrl` string; merging the users themselves is
  a separate concern, deferred.

## Sequencing

1. `updateFeedUrl` repository method + contract pin.
2. `microformats-parser` + `@paulrobertlloyd/mf2tojf2` dependencies +
   `discoverFeed` module (autodiscovery links + JF2 h-feed mapping) with unit
   tests; promote `ParsedItem`/`toParsedItem` to exports from `ingest.ts`.
3. Wire discovery into `ingestRemoteUser` (the ladder, SSRF guard, persist)
   with staged-fetch integration tests.
4. Money test + h-feed sibling + RUNNING.md note (feeds behind HTML pages and
   IndieWeb h-feed sites are now followable).
