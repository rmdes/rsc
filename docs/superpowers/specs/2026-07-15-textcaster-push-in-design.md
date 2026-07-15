# Textcaster push-in — WebSub subscriber + rssCloud receiving

Date: 2026-07-15
Status: design approved (brainstorm); implementation not started
Author: Ricardo (rmdes) with Claude Code
Basis: design spec `docs/superpowers/specs/2026-07-15-textcaster-design.md`
(inter-instance real-time, subscribe side); milestone 1 complete at
`c1d372f` (+ hardening `fc5df56`), whose self-hosted hub is this
milestone's natural test peer.

## What this is

The receive side of cross-instance real-time: remote feeds that advertise
push get pushed to us instead of waiting for the next poll. WebSub
subscriber (discover `rel="hub"`, subscribe with a callback, receive
signature-verified fat pings, renew leases) and rssCloud receiving
(register with remote clouds, receive thin pings, re-register daily).
Polling remains the correctness backstop — push is the latency upgrade.

Decisions taken at design time:

- **Slow-poll backstop**: push-subscribed feeds still poll, at 10× the
  normal interval (every 10th poller tick, in-memory counter — a restart
  resets to "poll everything", the safe direction). Idempotent ingestion
  makes overlap harmless.
- **Auto-subscribe on discovery**: zero config; any polled feed that
  advertises a hub (or `http-post` cloud) gets a subscription attempt.
- **`TEXTCASTER_PUSH_IN=on` by default**, kill-switch `off`; effective
  only when `TEXTCASTER_PUBLIC_URL` is set (callbacks need a reachable
  address). Rationale vs push-out's off-default (H1): subscribe calls
  only contact hubs advertised by feeds the operator explicitly chose to
  follow — consent-adjacent to fetching the feed itself.
- **Approach A**: no new scheduler — the existing poller loop drives
  polls, discovery, subscribe attempts, and renewals. One new outbound
  table (migration 3), deliberately separate from M1's inbound
  `subscriptions`.

## 1. Discovery (runs during every normal poll)

From the poll's response:

- HTTP `Link` headers (`rel="hub"`, `rel="self"`) — NOT a fallback:
  W3C WebSub requires subscribers to support header discovery, and
  header-only publishers are common. Simple comma-split parse.
- Feed body via feedsmith's parsed metadata (probed, all formats —
  note the format discriminator is `parsed.format`): RSS
  `feed.atom.links` (`rel="self"`/`rel="hub"`) + `feed.cloud`; Atom
  `feed.links`; JSON Feed `feed.hubs` + `feed.feed_url`. Discovery
  metadata comes from the SAME parse that yields the items (§6) — the
  poll body is parsed once, not twice.
- Topic = advertised `rel="self"` when present, else the stored
  `feedUrl`.
- WebSub preferred when both WebSub and `<cloud>` are advertised;
  `<cloud>` honored only for `protocol="http-post"`.
- **Discovered hub/cloud endpoints are attacker-controlled content** (a
  malicious feed can advertise `hub=http://169.254.169.254/`): every
  endpoint passes the existing multi-record private-range guard
  (`checkCallbackUrl`) before any request, and every request to a hub or
  cloud carries `redirect: 'manual'`. Feed fetches themselves keep
  following redirects (feeds legitimately 301/302).

## 2. Config

- `TEXTCASTER_PUSH_IN` = `on` (default) | `off`. Other values fail fast
  (same style as the sibling enums).
- Effective only when `TEXTCASTER_PUBLIC_URL` is set. NOT fail-fast when
  it isn't: one startup notice (`push-in inactive: no public URL`) and
  the feature stays dormant; polling continues unaffected.

## 3. State — migration 3, `push_subscriptions`

Outbound subscriptions, deliberately separate from M1's inbound
`subscriptions` table:

```sql
CREATE TABLE push_subscriptions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  mode text NOT NULL,               -- 'websub' | 'rsscloud'
  endpoint text NOT NULL,           -- hub URL or cloud pleaseNotify URL
  topic text NOT NULL,              -- feed self URL (or feedUrl)
  callback_token text NOT NULL UNIQUE,  -- 32-hex random; our callback path secret
  secret text,                      -- our HMAC secret (websub: always set)
  state text NOT NULL,              -- 'pending' | 'active'
  expires_at text NOT NULL,         -- ISO lease/registration expiry
  created_at text NOT NULL
)
-- indexes: (user_id), (expires_at)
```

Repository methods (contract-pinned, adapter-neutral; the three
single-row lookups collapse into one filter-object finder — ponytail):

- `upsertPushSubscription(s: PushSubscription): Promise<void>` — keyed on
  `(user_id, mode)`: one outbound subscription per user per mode
  (explicit conflict target, DO UPDATE endpoint/topic/state/expires_at —
  **NOT token or secret**; see H4 below).
- `findPushSubscription(filter: { token?: string; userId?: string;
  mode?: PushProtocol; topic?: string }, opts?: { unexpiredAt?: string;
  state?: 'pending' | 'active' }): Promise<PushSubscription | undefined>`
  — covers token lookup (callback routes), active-for-user (slow-poll
  gate), and mode+topic (thin-ping lookup).
- `listRenewablePushSubscriptions(before): Promise<PushSubscription[]>` —
  active rows with `expires_at < before`.
- `deletePushSubscription(id): Promise<void>`

**Token/secret stability (H4)**: WebSub subscription identity is
`(topic, callback)` — a renewal that rotated the callback token would
leave the hub holding two subscriptions, with the old one's pings
404ing against our DB. `callback_token` and `secret` are generated ONCE
per `(user, mode)` and reused across renewals and re-subscribes; the
upsert never overwrites them.

**Pending expiry (H3)**: `pending` rows carry `expires_at = now + 10
minutes`. Discovery's "no pending/active subscription" gate reads "no
UNEXPIRED pending/active row" — a hub that never delivers its
verification GET cannot block retries forever.

## 4. Scheduler = the existing poller

Each `tick` (the current self-rescheduling loop in `server.ts`):

1. **Polls**: feeds WITHOUT an active unexpired push subscription poll
   every tick; feeds WITH one poll only every 10th tick (in-memory
   counter).
2. **Discovery → subscribe** for polled feeds with no UNEXPIRED
   pending/active subscription (when push-in is effective; H3):
   - WebSub: generate token (32 hex) + secret (32 hex); upsert `pending`
     row; form-POST the hub: `hub.mode=subscribe`, `hub.topic=<topic>`,
     `hub.callback=<PUBLIC_URL>/websub/callback/<token>`,
     `hub.lease_seconds=864000`, `hub.secret=<secret>`. Row flips to
     `active` only when the hub's verification GET arrives (§5).
   - rssCloud: form-POST the cloud endpoint (`pleaseNotify`):
     `notifyProcedure=`, `port=<our public port>`,
     `path=/rsscloud/notify`, `protocol=http-post`, `url1=<topic>`,
     `domain=<our public host>`. On 2xx → mark `active`, expiry now+25h
     (their optional challenge GET is answered by our §5 endpoint).
3. **Renewals**: WebSub re-subscribes when < 1 day of lease remains;
   rssCloud re-registers when < 2 hours remain (25h registrations,
   re-registered daily in practice).
4. Failures leave the row `pending`/lapsing; the next tick retries.
   `ponytail:` no backoff machinery — the poll cadence IS the backoff;
   add real backoff if hub outages ever make this noisy.

## 5. Callback surface (new public routes)

- `GET /websub/callback/:token` — token must match a known subscription
  AND `hub.topic` must equal its topic. `hub.mode=subscribe`: echo
  `hub.challenge` (200, body = challenge), flip `pending → active`,
  store expiry from the hub's granted `hub.lease_seconds`.
  `hub.mode=denied`: delete the row, 200. Unknown token/topic mismatch →
  404 / no echo.
- `POST /websub/callback/:token` — the fat ping:
  - Body cap 5MB (reuse `MAX_FEED_BYTES` semantics: content-length
    pre-check + post-read check).
  - **Signature required, hub picks the algorithm (H1)**: we always
    request a secret, and `X-Hub-Signature` arrives as
    `<algo>=<hex>` where the HUB chooses the algorithm — the biggest
    real hubs (Google's pubsubhubbub, Superfeedr) sign with `sha1=`.
    Accept all four W3C algorithms (`sha1`, `sha256`, `sha384`,
    `sha512`), HMAC over the raw body with our secret, timing-safe
    compare.
  - **Verification failure is silent per the W3C spec (H2)**: a missing
    or invalid signature → **202, body discarded, logged** — never a
    4xx. Non-2xx responses invite the hub to drop the subscription, and
    a 403 doubles as a signature-validity oracle.
  - On a valid signature: `parseFeed` the body; ingest via the shared
    item path (§6) for the subscription's user — same guid dedup, same
    backfill rule, live bus emits for a user with existing posts.
  - Ingest/parse failures never 5xx the hub: log + 202. Success → 202.
  - Consequence, accepted: a non-signing (spec-violating) hub has all
    its pings discarded; the slow-poll backstop keeps the feed working
    at 10× latency.
- `GET /rsscloud/notify` — remote cloud's registration challenge:
  respond 200 with a body containing `challenge` iff `url` equals one of
  our rssCloud subscription topics (pending or active); else 404.
- `POST /rsscloud/notify` — the thin ping: exact-match the `url` param
  against our rssCloud subscription topics (`findPushSubscription`); on
  match, immediately run the normal `ingestRemoteUser` for that user
  (re-fetch of OUR stored `feedUrl` — the ping's content is never
  fetched or trusted beyond the lookup key). Unknown topic → 200 and
  ignore (no subscription-list oracle). **Amplification floor (H5)**: an
  in-memory `Map<topic, lastFetchAt>` enforces a 30-second minimum
  between ping-triggered re-fetches per topic — a ping storm costs the
  attacker requests and us nothing; the poll backstop covers anything
  coalesced away.

## 6. One refactor: split `ingestRemoteUser`, one parse per body

Extract `ingestItems(repo, bus, user, items): Promise<number>` (the
insert/dedup/backfill/emit loop) from `ingestRemoteUser`. The parse step
becomes `parseFeedWithMeta(body): { items: ParsedItem[]; discovery: {
hubs: string[]; self: string | null; cloud: { domain; port; path;
protocol } | null } }` — ONE parse yields both the items and the
discovery metadata (`parseFeed` remains as a thin `.items` wrapper for
existing callers/tests). `ingestRemoteUser` returns the discovery
metadata alongside its insert count so the poller's subscribe engine
consumes it without re-parsing. Fat pings call `parseFeedWithMeta` +
`ingestItems` directly (no fetch); thin pings and polls use
`ingestRemoteUser` unchanged.

## 7. The money test — real-time federation, no polling

Two in-process instances: A runs its M1 self-hosted hub
(`TEXTCASTER_WEBSUB=self`); B follows A's user feed, discovers A's hub,
subscribes over a fetch bridge; A's hub challenge-verifies B's callback
through the bridge (**A's hub must be built with an injected `lookupFn`
resolving B's bridge host to a public address — otherwise A's own SSRF
guard rejects B's callback before verification; the seam exists in M1's
code**); then **A posts, and B's timeline gains the post via the fat
ping alone** — B performs no further poll in the test, and B's bus
emits the entry live. A sibling test tampers the fat-ping body and
asserts B discards it silently (202, nothing ingested — H2 semantics).
An rssCloud variant covers thin ping → re-fetch. M1's hub gets its
first real subscriber: us.

## Non-goals

- Unsubscribe flows (rows lapse or are deleted manually; no
  `hub.mode=unsubscribe` initiation from our side).
- rssCloud receiving stays in scope but is the NAMED DEFER CANDIDATE if
  the batch needs slimming mid-run; re-add signal: a followed feed
  actually advertising `<cloud>`.
- Retry backoff, multi-hub failover (first valid hub wins), per-feed
  push opt-out, WebSub denial semantics beyond row deletion.
- `Link` header parsing beyond a simple `rel=hub/self` grab.
- Web-app changes of any kind.
- Connect-time DNS pinning (rebinding residual remains ledgered from M1).

## Testing approach

TDD throughout:

- Contract suite: the four `push_subscriptions` methods (upsert keyed on
  user+mode with DO UPDATE that preserves token/secret — H4 pinned;
  `findPushSubscription` across all filter shapes and expiry/state
  opts; renewable listing; delete).
- Discovery: unit tests over parsed-feed fixtures (all three formats +
  Link header fallback + cloud http-post-only + self-vs-feedUrl topic
  choice); endpoint guard rejection (private hub advertised → no
  subscribe attempt, no row).
- Subscribe flow: pending row + correct hub form fields (bridge-stubbed
  fetch); rssCloud registration fields; renewal triggers at the
  thresholds; kill-switch and no-PUBLIC_URL dormancy.
- Callbacks: challenge echo flips pending→active with granted lease;
  topic mismatch → no echo; denied → row gone; fat ping happy path
  ingests + emits; signatures verify for ALL FOUR algorithms (sha1 case
  pinned — real hubs use it); bad/missing signature → 202 + nothing
  ingested + logged (H2); oversized body rejected; thin ping re-fetches
  stored feedUrl only; unknown thin-ping topic → 200 no-op; thin-ping
  30s floor coalesces a ping storm (H5).
- Poller: slow-poll cadence (subscribed feed skipped on non-10th ticks);
  discovery only fires for feeds without pending/active rows.
- End-to-end: the two-instance real-time loop (§7) + tampered-signature
  sibling + rssCloud variant.

## Sequencing

1. Config (`TEXTCASTER_PUSH_IN`) + dormancy notice.
2. Migration 3 + `PushSubscription` repo methods + contract pins (+ 2→3
   upgrade test).
3. Ingest split (`ingestItems`) — pure refactor, suite stays green.
4. Discovery module (parse metadata + Link header + guard).
5. Subscribe/renewal engine in the poller tick + slow-poll cadence.
6. WebSub callback routes (GET verify / POST fat ping).
7. rssCloud notify routes (GET challenge / POST thin ping).
8. The two-instance real-time loop tests + RUNNING.md + gates.
