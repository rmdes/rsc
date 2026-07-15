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

- Feed body via feedsmith's parsed metadata (probed, all formats): RSS
  `feed.atom.links` (`rel="self"`/`rel="hub"`) + `feed.cloud`; Atom
  `feed.links`; JSON Feed `feed.hubs` + `feed.feed_url`.
- Plus an HTTP `Link` header fallback (`rel="hub"`, `rel="self"`) —
  header-only WebSub publishers are common; simple comma-split parse,
  nothing more.
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

Repository methods (contract-pinned, adapter-neutral):

- `upsertPushSubscription(s: PushSubscription): Promise<void>` — keyed on
  `(user_id, mode)`: one outbound subscription per user per mode
  (explicit conflict target, DO UPDATE endpoint/topic/token/secret/state/
  expires_at).
- `getPushSubscriptionByToken(token): Promise<PushSubscription | undefined>`
- `getActivePushSubscriptionForUser(userId, now):
  Promise<PushSubscription | undefined>` — active AND unexpired, either
  mode.
- `getPushSubscriptionByTopic(mode, topic, now):
  Promise<PushSubscription | undefined>` — the rssCloud thin-ping lookup.
- `listRenewablePushSubscriptions(before): Promise<PushSubscription[]>` —
  active rows with `expires_at < before`.
- `deletePushSubscription(id): Promise<void>`

## 4. Scheduler = the existing poller

Each `tick` (the current self-rescheduling loop in `server.ts`):

1. **Polls**: feeds WITHOUT an active unexpired push subscription poll
   every tick; feeds WITH one poll only every 10th tick (in-memory
   counter).
2. **Discovery → subscribe** for polled feeds with no pending/active
   subscription (when push-in is effective):
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
  - **Signature required**: we always request a secret, so a missing or
    invalid `X-Hub-Signature` (sha256 HMAC over the raw body,
    timing-safe compare) → 403, body discarded.
  - `parseFeed` the body; ingest via the shared item path (§6) for the
    subscription's user — same guid dedup, same backfill rule, live bus
    emits for a user with existing posts.
  - Ingest/parse failures never 5xx the hub: log + 202. Success → 202.
- `GET /rsscloud/notify` — remote cloud's registration challenge:
  respond 200 with a body containing `challenge` iff `url` equals one of
  our rssCloud subscription topics (pending or active); else 404.
- `POST /rsscloud/notify` — the thin ping: exact-match the `url` param
  against our rssCloud subscription topics
  (`getPushSubscriptionByTopic`); on match, immediately run the normal
  `ingestRemoteUser` for that user (re-fetch of OUR stored `feedUrl` —
  the ping's content is never fetched or trusted beyond the lookup key).
  Unknown topic → 200 and ignore (no subscription-list oracle).

## 6. One refactor: split `ingestRemoteUser`

Extract `ingestItems(repo, bus, user, items): Promise<number>` (the
insert/dedup/backfill/emit loop) from `ingestRemoteUser`, which becomes
fetch + parse + `ingestItems`. Fat pings call `parseFeed` +
`ingestItems` directly (no fetch); thin pings and polls use
`ingestRemoteUser` unchanged. Only touch to existing ingest code.

## 7. The money test — real-time federation, no polling

Two in-process instances: A runs its M1 self-hosted hub
(`TEXTCASTER_WEBSUB=self`); B follows A's user feed, discovers A's hub,
subscribes over a fetch bridge; A's hub challenge-verifies B's callback
through the bridge; then **A posts, and B's timeline gains the post via
the fat ping alone** — B performs no further poll in the test, and B's
bus emits the entry live. A sibling test tampers the fat-ping body and
asserts B's 403 (signature verification is real). An rssCloud variant
covers thin ping → re-fetch. M1's hub gets its first real subscriber:
us.

## Non-goals

- Unsubscribe flows (rows lapse or are deleted manually; no
  `hub.mode=unsubscribe` initiation from our side).
- Retry backoff, multi-hub failover (first valid hub wins), per-feed
  push opt-out, WebSub denial semantics beyond row deletion.
- `Link` header parsing beyond a simple `rel=hub/self` grab.
- Web-app changes of any kind.
- Connect-time DNS pinning (rebinding residual remains ledgered from M1).

## Testing approach

TDD throughout:

- Contract suite: the six `push_subscriptions` methods (upsert keyed on
  user+mode with DO UPDATE; token lookup; active-for-user with expiry;
  topic lookup; renewable listing; delete).
- Discovery: unit tests over parsed-feed fixtures (all three formats +
  Link header fallback + cloud http-post-only + self-vs-feedUrl topic
  choice); endpoint guard rejection (private hub advertised → no
  subscribe attempt, no row).
- Subscribe flow: pending row + correct hub form fields (bridge-stubbed
  fetch); rssCloud registration fields; renewal triggers at the
  thresholds; kill-switch and no-PUBLIC_URL dormancy.
- Callbacks: challenge echo flips pending→active with granted lease;
  topic mismatch → no echo; denied → row gone; fat ping happy path
  ingests + emits; bad/missing signature → 403 + nothing ingested;
  oversized body rejected; thin ping re-fetches stored feedUrl only;
  unknown thin-ping topic → 200 no-op.
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
