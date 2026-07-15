# Spec review — feed output + WebSub/rssCloud (pre-implementation)

## Re-review of the revised spec: APPROVED for planning, with two stale-prose fixes

All eight holes (H1–H8) and every listed ambiguity are genuinely
incorporated: default `off` with fail-fast only on *explicitly* enabled push
(H1), all three structural hardening rules adopted — challenge-verify every
registration including no-domain rssCloud, private-range rejection at
registration, 20/host + 500/topic caps — with `callback_host` column,
`countActiveSubscriptions`, and both residuals ledgered (H2), the exact-
equality topic rule with a trailing-slash/case-variant rejection test (H3),
the never-rejects seam contract with `void` wiring and the coalescing
ceiling (H4), raw-string assertions beside the round-trip (H5), all three
feedsmith facts folded into §1 (H6), the lease_seconds subscribe/unsubscribe
asymmetry in both spec and tests (H7), and 302-not-301 rationale plus
null-feedUrl→404 (H8). The delivery-matrix table, DO-UPDATE upsert note,
challenge format, and once-per-topic fat-ping regeneration all landed too.

**Two stale remnants contradict the new H1 default — fix before planning so
the plan-writer doesn't regress it:**

1. The "What this is" intro (§0) still says "WebSub (**external hub by
   default**, self-hosted hub as an operator choice)".
2. The mode heading still reads "### Mode: external hub **(default)**".

Both are one-word edits; the normative sections (§2 config, decisions
bullet) are correct and unambiguous. With those two lines fixed, write the
plan.

---

Date: 2026-07-15
Target: `docs/superpowers/specs/2026-07-15-textcaster-feed-output-design.md`
Status of target: not implemented — holes to fix in the spec before planning.
Claims verified against the current code and the installed feedsmith 2.9.6
(generation API probed directly), plus W3C WebSub / rssCloud conventions.

**Verdict: not ready as-is — H1 must change first; H2's hardening rules must
be written in or explicitly ledgered. H3/H4/H7 are one-sentence pins; H6's
feedsmith facts must fold into §1 so the plan's code is written against
reality. The approach itself — feedsmith generate API, migration 2, the
shared-registry push design, round-trip + money test — is sound.**

## Holes

### H1 — DESIGN-BREAKING: the default config bricks every existing deployment

`TEXTCASTER_WEBSUB` defaults to the external hub (push ON by default) while
`TEXTCASTER_PUBLIC_URL` is "required, fail-fast, whenever any push mode is
enabled". Every existing `.env` has neither → **upgrading to this milestone
fails at boot with no code or data change**, undocumented. Compounding:
default-on external hub means every instance form-POSTs `websubhub.com` (a
third party) on every local post — activity disclosure by default plus a
hard dependency on one external service.

**Fix (one line):** default `TEXTCASTER_WEBSUB=off` — push is opt-in,
matching rssCloud's own default. Reserve fail-fast for *explicitly
configured* push without PUBLIC_URL.

### H2 — NEEDS-A-DECISION: SSRF round 2; the no-domain rssCloud path is the worst

`POST /hub` and `POST /rsscloud/pleaseNotify` are public, unauthenticated,
and make core GET (verify) and POST (deliver) to caller-supplied URLs — the
class the spine locked `POST /users` for (#7), except these endpoints can't
be authed (that's their protocol role), so mitigations must be structural.
The rssCloud no-domain path ("callback = requester IP, no challenge") is an
unauthenticated, daily-renewable make-this-server-POST-anywhere-on-my-IP
primitive.

**Minimum hardening to pin in the spec:** (1) challenge-verify EVERY
registration, including no-domain rssCloud (benign deviation, tolerated);
(2) at registration, reject callbacks whose host resolves to
loopback/link-local/private ranges (stdlib check, also protects delivery);
(3) cap stored subscriptions per callback host and per topic (a constant).
Anything dropped goes in the hardening ledger with a severity — and note
these three are not "rate limiting" (which stays a non-goal).

### H3 — pin the topic comparison rule

"Topic must be one of OUR feed URLs" is unpinned; implementers will guess
among URL-normalization/startsWith/equality, each failing differently
(trailing slash, percent-encoding, http-vs-https behind the proxy, handle
case). **Pin: exact string equality against the two minted URLs of an
existing local user** (`PUBLIC_URL + '/users/' + handle + '/feed.xml|json'`,
handle already normalized); everything else 4xx.

### H4 — the bus wiring site is where the process dies

`bus.onNewPost` callbacks run synchronously inside `EventEmitter.emit`;
`push.onLocalPost` is async; `server.ts` has no global rejection handler —
an unhandled rejection there is process-fatal. Pin the seam contract:
**`onLocalPost` never rejects** (top-level try/catch inside it) and wire as
`bus.onNewPost((e) => { void push.onLocalPost(e) })`. Also add the
`ponytail:` ceiling: N rapid posts = N regenerations × M subscribers, no
coalescing; debounce per topic when it matters.

### H5 — MINOR: round-trip test can't see feedsmith-shaped bugs

Same library generating and parsing validates the mapper, not the output.
Add a few raw-string assertions on the generated bodies
(`<guid isPermaLink="false">`, `<atom:link … rel="hub"`, `<cloud `,
`"version": "https://jsonfeed.org/version/1.1"`) alongside the round-trip.
The §4 money test stays as-is — it proves our loop, not interop.

### H6 — MINOR: three feedsmith facts §1 must absorb (probed, 2.9.6)

1. `generateRssFeed` **drops `registerProcedure` when empty-string** — the
   spec's literal `registerProcedure=""` is unproducible; say "attribute
   omitted" (harmless for http-post).
2. `generateJsonFeed` **returns an object, not a string** — the route (and
   round-trip test) must `JSON.stringify`.
3. Channel `description` is **required** (type-level) — the spec's
   "description when set" needs an unconditional fallback, e.g.
   `Posts by <displayName>`.

### H7 — MINOR: WebSub conformance nit

`hub.lease_seconds` in the verification GET is REQUIRED for subscribe and
**not sent** for unsubscribe. One clause.

### H8 — MINOR: remote-user 302 edges

Pin "remote user with null feedUrl → 404" (type allows it even if today's
data doesn't), and note 302-not-301 is deliberate because feedUrl is
mutable — before someone "optimizes" it into a cache-poisoning 301.

## Ambiguities to pin

- Subscription `id` is cosmetic (`randomUUID()`); lookups go by
  `(protocol, topic, callback)`. Upsert needs an explicit conflict target
  with `DO UPDATE` — the posts-table bare `doNothing()` pattern cannot be
  copied (the adapter's own comment warns about this).
- Delivery matrix: WebSub covers both feed URLs per event; `<cloud>`/thin
  ping is RSS-only. One small table in §3.
- `hub.challenge` = `randomBytes(16).toString('hex')` (or randomUUID) — pin.
- Fat ping body regenerated **once per topic per event**, same body to all
  subscribers (also makes the HMAC test deterministic).
- `TEXTCASTER_PUBLIC_URL` must parse as http(s) (same rule as feedUrl).
- Plaintext `secret` storage: accepted at this grade — one ledger line so
  it's a decision, not an omission.

## Verified sound (probed — don't re-check)

- Feedsmith 2.9.6 can express all of §1: `generateRssFeed`/`generateJsonFeed`
  exist; RSS `cloud` (five attrs), `guid.isPermaLink: false`, channel
  `atom.links` with rel self/hub (correct xmlns) all render; JSON Feed
  `feed_url` + `hubs` emit; title-less items are legal in both (content is
  NOT NULL, so RSS's title-or-description rule is always satisfied); ISO
  strings work as dates and render RFC-822.
- The migration runner applies 1→2 in place, transactionally; the upgrade
  test is implementable as-is.
- The poller loop ticks with zero remote users, so opportunistic purge works.
- X-Hub-Signature format, 202-then-verify, challenge echo, secret <200B,
  Link headers on delivery, rssCloud 25h/daily re-register/domain-challenge/
  http-post-only/thin-ping shape: all conform.
- `getPostsByAuthor` 50-post snapshot with the existing composite index is
  right; feeds are windows, not archives.

## What must change before planning

Flip H1's default to `off`. Write H2's three structural mitigations into §3
(or ledger each dropped one with severity). Pin H3's equality rule, H4's
never-rejects seam, H7's lease_seconds clause. Fold H6's three feedsmith
facts into §1. One line each for H5/H8 and the ambiguities. Then plan.
