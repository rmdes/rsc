# RSC migration and final cutover — Vertical 4 design

**Date:** 2026-07-22
**Status:** Draft for repository review
**Revision:** 0
**Foundation:** `2026-07-20-rsc-source-governance-moderation-design.md` rev 3,
including its two dated 2026-07-22 amendment blockquotes (§6 fan-out emits no
item events; §7 quarantined evidence in neither ordinary comparator). §12 is
this vertical's conversion charter — and only that: it is **not** a schema
authority for push (V3 §3 records that explicitly).
**Roadmap:** `2026-07-20-rsc-source-governance-vertical-roadmap.md` rev 4,
§Vertical 4, plus the 2026-07-22 scope note under §Vertical 3: the v2 push
subsystem deferred out of V3 lands here.
**V1 contracts:** `../plans/2026-07-20-rsc-source-control-plane.md` rev 4 as
amended by `../reviews/2026-07-22-v1-source-control-plane-review.md` — the
deferral removed the alias/tombstone stubs, `policy_generation`, the
always-null DTO fields, and the ops-token route. V4 is the ops-token route's
first consumer and (re)introduces it here (Section 6). Tombstones and
`policy_generation` were already reintroduced by V3/V2 respectively.
**V2 contracts:** `2026-07-22-rsc-logical-items-ordinary-reads-design.md`
rev 4 + review rev 1 — journal seq + reset generation, the capability wire
shape and C1's carve (fetch failure degrades to legacy; malformed v2 envelope
fails closed), activation barrier (§7.1), and the command conventions (body
`commandId`, pinned fingerprints, `jsonWrite` composition) reused verbatim.
**V3 contracts:** `2026-07-22-rsc-moderation-events-verification-design.md`
rev 1 — especially §3 Push (deferred): the recorded facts inherited here, and
the Open V1/V2 dependencies section, each item of which Section 10 lands or
closes.
**Scope:** Vertical 4 only — the LAST vertical. No implementation planning is
authorized by this document.

## Purpose and boundary

Vertical 4 finishes the milestone: it ships the v2 inbound push subsystem
(WebSub/rssCloud) that V3 deferred, the preflight command and versioned
manifest, the one atomic legacy-data conversion with exact push/follow
preservation, permanent legacy-handle reservation, the durable migration
report and cutover reset, the ops-token compatibility route, the cutover
sequencing on the live single-node instances, and the legacy retirement that
removes the v1 runtime branch. Migration is the final cutover, not an early
schema task: no conversion runs until every v2 reader and writer from
Verticals 1–3 is ready.

Everything remains behind startup-immutable `RSC_SOURCE_MODEL_V2=off` until
the operator flips it (Section 8). This is a single-user pre-release system in
one Node process on single-node Cloudron instances: V4 adds no distributed
locks, no shadow comparisons, no rollout percentages, and no multi-version
rollback machinery — the rollback posture is a backup-restore point plus
forward-only fixes, stated honestly in Section 5. The milestone keeps exactly
two scheduling loops — V2's poll loop and V2's reconciliation drain — and V4
adds no third: push renewal rides the poll loop pass exactly as v1's does
today (`runPollCycle` ends with `pushIn.renewDue()`,
`core/src/domain/push-in.ts:271`).

Outbound push for local feeds (`core/src/domain/push.ts` — the self-hub,
publisher pings, and the `subscriptions` table, migration 2 at
`core/src/storage/sqlite.ts:592-604`) is **not** part of this vertical and is
untouched in every phase: its topics are local feed URLs that never change,
`resolveLocalTopic` only resolves local users (`push.ts:49`), and V2 §7.4
already keeps it running under v2. Only inbound push — RSC as subscriber to
remote sources — is rebuilt here.

## 1. The v2 push subsystem

### 1.1 Capability capture

Push capability is captured **at parse time, per acquisition run** — the
forced fact recorded by V3 §3: V2 stores digests for oversized raw evidence,
so post-hoc re-parsing of stored feed bodies is unfulfillable. Each successful
parse records a bounded discovery claim on the run: the first advertised
WebSub hub with its `rel=self` topic, or the rssCloud `http-post` endpoint —
the same selection rule as `choosePushTarget` today
(`core/src/domain/push-in.ts:30-39`), reused as a pure function over v2
discovery data. Discovery claims are observations, never authority:
registration always revalidates the endpoint at use against current URL
rules, the existing `checkCallbackUrl` SSRF gate, source governance,
tombstones, and alias ownership. Registration acts only on the **latest
successful run's** claim; stale claims are inert evidence.

### 1.2 Subscription lifecycle

One v2 push-subscription relation, one row per `(sourceId, protocol)` —
mirroring the legacy `UNIQUE(user_id, mode)` at
`core/src/storage/sqlite.ts:618` — holding protocol, endpoint, topic,
callback token, secret (WebSub only), state, expiry, and creation time.
Exact table/column identifiers are plan-level.

The legacy `PushSubscription` state is `pending | active` **only**
(`core/src/domain/types.ts:84`); V3 §3 assigned the wider lifecycle to this
vertical, and foundation §12 requires migrated `expired`/`invalid` rows to
exist as retained evidence. The v2 lifecycle is:

```text
state     meaning                                    counted "active push"?
pending   registration sent, awaiting verification   no
active    hub/publisher verified, lease unexpired    yes
expired   lease or pending TTL passed unrenewed      no
invalid   last attempt denied, or migration-flagged  no
```

Deliberate divergences from v1, both in the retain-evidence direction:

- v1 **deletes** a subscription on hub denial (`push-in.ts:200-202`); v2 marks
  it `invalid` and keeps the row.
- v1 **purges** expired rows every poll cycle
  (`repo.purgeExpiredSubscriptions`, `push-in.ts:272`); v2 flips them to
  `expired` and keeps them.

Neither state is terminal: the renewal pass (1.3) may re-attempt an
`expired` or `invalid` row whenever the source is currently
registration-eligible and the latest successful run still advertises the
capability — a migration-flagged invalid endpoint simply fails the
revalidation gate again and stays `invalid`. Re-attempts reuse the row's
token and secret: the stored token/secret are the subscription's identity,
generated only when no `(source, protocol)` row exists at all — the v1 R1
rule (`push-in.ts:79-83`) kept verbatim, and the property that makes exact
lease preservation across conversion work (Section 3.4). The v1
websub-over-rsscloud upgrade (a live hub retires the rsscloud fallback row,
`push-in.ts:208-210`) is kept.

Constants are reused verbatim from `core/src/domain/push-in.ts:41-46`:
pending TTL 10 min, WebSub lease request 10 days with 1-day renew horizon,
rssCloud TTL 25 h with 2-h renew horizon, hourly renewal-retry floor. The
operator knob is likewise reused: v2 inbound push is effective exactly when
`RSC_PUSH_IN=on` and `RSC_PUBLIC_URL` is set — the existing
`pushInEffective` rule (`push-in.ts:48-50`, `core/src/config.ts:60-62`). No
new environment variable.

### 1.3 Registration, renewal, and the poll loop

Registration eligibility composes three existing axes; no new state machine:

- **operation** must be `enabled` — pause stops new and renewed
  registrations (foundation §5);
- **governance** must not be `blocked` — quarantine does **not** stop push:
  acquisition continues under quarantine and its evidence is
  administrator-only (foundation §13's mandatory scenario; §12 lets migrated
  quarantined sources retain active leases);
- the source must currently be **schedulable** (active subscription or
  pending/approved federation, V2 §1.3) — a source nobody follows holds no
  lease.

After each successful acquisition commit for an eligible source, if no
unexpired `pending | active` row exists (or the rsscloud-fallback upgrade
applies), the poll loop registers from the run's discovery claim — the v1
`maybeSubscribe` shape (`push-in.ts:149-164`) rebuilt over sources. Each poll
pass ends with one renewal sweep over rows inside their renew horizon,
filtered by current eligibility. There is no separate push worker, timer, or
queue (`ponytail: renewal rides the poll pass like v1; a dedicated scheduler
only if lease counts ever make the sweep measurable`).

A source with an `active` unexpired subscription polls at a reduced cadence:
its skip-if-recent threshold becomes `10 * baseInterval` instead of
`baseInterval` — the durable equivalent of v1's in-memory
`tick % 10 !== 0 && hasActivePush` skip (`push-in.ts:264`), and it composes
with V2 §1.3's `lastPollAt` comparison instead of adding tick state.

**No unsubscribe request is ever sent** — V3's decision #2 lands here as
designed: pause, block, quarantine, unsubscribe-to-zero, and even purge send
nothing; leases lapse at expiry. Purge deletes the source's push rows with
the rest of its operational state (V3 §5.2 step 2 — push state is named
there); residual traffic then hits the unknown-token/topic paths below.

### 1.4 Callbacks and ingestion

The public callback routes are the existing paths, unchanged:
`GET /websub/callback/:token`, `POST /websub/callback/:token`, and
`GET|POST /rsscloud/notify` — already the only-core-paths-public set with
feeds (Caddyfile invariant), and the path stability is what keeps migrated
leases live (Section 3.4). Under v2 the handlers resolve tokens/topics
against the v2 push relation; the v1 handlers are not routed (V2 §7.4).

Behavior, per the V3 §3 pause/block matrix (binding) plus v1's hardening
rules (kept):

- **WebSub verification GET**: state-agnostic token+topic match (renewals
  re-verify while active, `push-in.ts:196-211`); `denied` marks the row
  `invalid`; success activates with the granted lease. A valid known
  in-flight challenge completes even when the source is paused or blocked —
  avoiding hub retries and state oracles — but causes no acquisition and no
  renewal scheduling.
- **Fat ping**: resolve token; verify HMAC against the stored secret with
  the hub-chosen algorithm (`verifySignature`, `push-in.ts:16-26`, reused);
  verification failures stay silent — 202, discard, log, never 4xx (v1 H2,
  `push-in.ts:218-221`). For an eligible source the body enters the **same
  V2 acquisition path as a poll**: the §1.5 bounds profile, observation
  writer, reconciliation jobs, and commit-time policy recheck, with delivery
  mechanism recorded as push. Paused or blocked: authenticate, return the
  neutral 202, discard unparsed and unstored. Quarantined + enabled: ingest
  normally; governance already makes the evidence administrator-only — no
  push-specific branch.
- **Thin ping**: unknown topic returns the neutral 200 no-op (no
  subscription-list oracle) and the 30-second per-topic floor is kept
  (`push-in.ts:238-241`). A known eligible topic triggers one acquisition
  run through the ordinary gate (a one-shot reason, like administrator
  refresh). Paused or blocked: return 200 without fetching.
- **rssCloud challenge**: known topic confirms; unknown 404s (`push-in.ts:231-234`).

Resume from pause performs one paced catch-up poll before discovery and
registration restart — V2 §1.3's ordinary next-pass poll is that catch-up;
nothing extra is built.

### 1.5 Administrative surface

`SourceSummary.push` — declared by V1
(`../plans/2026-07-20-rsc-source-control-plane.md` L127) and deferred to "the
vertical that first writes it" — is first written here, with the V1 shape
verbatim: `{ mode: PushProtocol | null; state: 'pending' | 'active' |
'expired' | 'invalid' | null; endpointFingerprint: string | null }`. V1's
declared state union already matches the 1.2 lifecycle exactly. The endpoint
fingerprint is a stable non-secret digest; callback tokens and secrets never
appear in any list, detail, error, or audit body (the standing redaction
tests extend to push rows). The admin source page shows push mode, state,
and expiry beside the V2 acquisition health block. No ordinary (non-admin)
surface changes.

## 2. Preflight and manifest

### 2.1 The preflight command

Preflight is one read-only check module with two entry points: a documented
standalone command (run via `cloudron exec` on a live instance; exact npm
script name is plan-level) and the same checks executed in-process
immediately before conversion (Section 4.1). It validates, without writing:

- every remote `users.feed_url` normalizes under the narrow canonicalization
  (scheme/host/default port, strip fragment, preserve path/query/trailing
  slash/HTTP-vs-HTTPS); missing, malformed, credential-bearing, oversized,
  non-HTTP(S), or normalized-colliding URLs are aborting findings;
- the manifest, when configured, validates completely (2.2);
- every legacy remote handle is reservable (collision with an existing
  reservation is an aborting finding).

Aborting problems print as startup/CLI diagnostics — never a transactional
report, because nothing commits. The supported correction procedure is
foundation §12's, verbatim: back up the database, run preflight, correct the
identified legacy rows, rerun preflight, then restart migration.

### 2.2 The versioned manifest

The manifest is an optional JSON file named by an environment variable
(exact name plan-level), restricted to legacy `feed_type = 'instance'` rows
(`feed_type` from migration 11, `core/src/storage/sqlite.ts:682-688`). Each
entry is keyed by **exact legacy source ID plus exact legacy feed URL** and
specifies approval, attribution mode, and an operator/provenance note. A
schema version field gates parsing. Unknown, duplicate, mismatched, invalid,
or contradictory entries abort preflight. No manifest means every instance
row takes the unconfirmed default (3.1).

## 3. Conversion

Conversion is one atomic transformation of legacy rows into the v2 model,
executed inside the pre-listen activation transaction (4.1). It sends **no
network requests** — no subscribe, unsubscribe, verify, or fetch. An empty
legacy set converts trivially; a fresh dev database and a live instance take
the identical path (`ponytail: zero-row conversion is the same code path,
not a special case`).

### 3.1 Sources, publishers, federation

- Local account IDs and handles are preserved exactly; local accounts remain
  local authors.
- Each legacy remote `users` row becomes one source with **the same ID** and
  its normalized feed URL as canonical URL, provenance `migration`.
- Each source gets a **new** publisher ID (foundation §12: publishers are
  new identities, never recycled user IDs).
- `feed_type` `person`/`webfeed` → `single_publisher + enabled + allowed +
  federation none`.
- Manifest-approved instances → manifest-specified mode, `allowed +
  approved`, with the manifest note as provenance.
- Every unconfirmed instance → `aggregate + enabled + quarantined + pending`.

Conversion writes one system-actor source-audit row, category
`migration_review` (first emitter — re-added to the TS enum here), for each
source whose outcome is not the plain allowed default: the quarantined
instances and the manifest approvals. Default person/webfeed conversions are
recorded in the migration report only, not audit
(`ponytail: audit the governance-bearing outcomes; the report carries the
bulk`). Section 10 records the SQL CHECK consequence.

### 3.2 Items, deliveries, ancestry

Each legacy remote post (`posts` with `source='remote'`, migration 1 DDL at
`core/src/storage/sqlite.ts:576-587`) becomes one logical item **with the
same post ID**, carrying one delivery identity, one observation version, one
claim, the selected publisher, and a retained preferred delivery. Preserved
exactly: GUID (the `UNIQUE(author_id, guid)` key at `sqlite.ts:586` maps to
the v2 delivery key), permalink, content, `content_markdown`, publication
and arrival dates, reply context, and resolve-once ancestry. V2 §4.1
explicitly permits preserving already-resolved legacy edges without
recreating the retired global-uniqueness fallback — conversion copies each
resolved `in_reply_to_post_id` edge as a resolved logical parent edge
as-is. A local parent needed as an edge endpoint has its local bridge row
materialized (V2 §2.6 names explicit backfill as a legitimate
materialization site). Unresolved legacy references convert to `missing`
with their bounded asserted context.

For migrated single-publisher sources the bound publisher is selected;
differing per-item attribution (`source_name`/`source_feed_url`) becomes a
conflicting claim. For aggregates, valid per-item attribution resolves a
provisional publisher; missing/invalid attribution uses the source-scoped
unattributed publisher. Quarantined deliveries convert as retained
administrator evidence, ordinarily ineligible from the first read.

Historical posts are never merged automatically; a permalink or
publisher+GUID collision between converted items becomes a non-aborting
migration conflict in the report.

Legacy revisions (`post_revisions`, `sqlite.ts:667-675`) convert into the
delivery's accepted presentation chain preserving order and timestamps, with
timestamp provenance **`legacy_unknown`** — a third provenance value that
never initializes or advances the explicit-update watermark. The wire enum
`updatedAtProvenance: 'explicit' | 'arrival' | null` (V2 §3.4) widens to
include `'legacy_unknown'`; like V3's `attributionLevel` widening, this is
an intentional supersession of V2's exact enum, stated here so it is not
read as drift.

Converted remote `posts` and `post_revisions` rows are **left in place,
inert**: no v2 reader touches remote-authored legacy rows, `posts` remains
the sole authority for local content, and deleting them buys nothing while
the backup is the only undo (`ponytail: inert legacy remote rows retained;
a cleanup batch can delete them after the retirement release has soaked`).

### 3.3 Follows and subscriptions

Legacy `follows` (`sqlite.ts:623-628`) split by target kind:

- local → local follows are preserved unchanged;
- every valid local → remote follow becomes a source subscription on the
  converted source: `active` for person/webfeed (allowed sources),
  **`pending_review` for every legacy instance follow regardless of source
  approval** — counts toward the cap, exposes no Personal content, remains
  removable, requires explicit reviewed activation (foundation §12).

The cap is the same `max_subs_per_user` instance setting (default 500,
seeded by migration 11 at `sqlite.ts:690`). Migrated over-cap users are
grandfathered: existing subscriptions all convert, but no new subscription
is accepted until the user is below the cap.

### 3.4 Exact push preservation

Every legacy `push_subscriptions` row (`sqlite.ts:607-620`) converts to a v2
push row on the same-ID source, preserving **exactly**: protocol, endpoint,
topic, callback token, secret, state, expiry, and creation time. State maps
`pending → pending` and `active → active` when unexpired; an expired row
becomes `expired` (inactive evidence); a row failing revalidation (malformed
endpoint, SSRF-failing host, bad URL) becomes `invalid` and a report
finding — reported, never discarded. Quarantined sources retain their active
leases; their ingestion is admin-only by governance alone.

Because the callback token, secret, topic, and route paths are all
preserved (1.4), a hub's in-flight lease keeps delivering across cutover
with no re-subscription: the next fat ping authenticates against the
converted row. Conversion sends no subscribe/unsubscribe requests; the first
post-cutover renewal happens on the ordinary poll-pass sweep when a lease
enters its horizon.

### 3.5 Permanent handle reservation

Every legacy **remote** handle is permanently reserved: a small reservation
relation maps handle → converted source/publisher ID, checked by local
account creation (a reserved handle can never be registered — the
impersonation guard) and surviving source removal and purge (foundation
§12: "through removal/purge"). Web's `/u/:handle` for a reserved handle
redirects permanently to `/p/:publisherId` while the publisher remains
ordinarily navigable, and returns the neutral ordinary 404 after purge —
the reservation outlives the redirect target. Remote logical items keep
their post IDs (3.2), so every existing `/post/:id` permalink survives
cutover unchanged; legacy remote users never had local feed URLs to alias
(`resolveLocalTopic` rejects non-local users, `core/src/domain/push.ts:49`).

### 3.6 Report and cutover reset

The durable migration report contains **only non-aborting findings**:
conversion conflicts, invalid push rows, over-cap grandfathering, collision
records, and per-kind counts. The report rows and one journal `reset` — the
cutover barrier for any connected client — commit inside the migration
transaction. Administrators read it at `GET /admin/migration/report`
(summary counts plus cursor-paginated findings under the V2 pagination
conventions). It is evidence, not a to-do list; `migration_review` items
surface through the ordinary V1/V3 admin navigation (the quarantine group).

After commit, paced acquisition resumes for enabled allowed and enabled
quarantined sources through the ordinary poll loop; paused and blocked
sources stay inactive.

## 4. Cutover sequencing

### 4.1 Composition with V2 activation

Conversion extends V2 §7.1's pre-listen activation transaction rather than
adding a second barrier. A configured-v2 process, before listening:

1. applies pending schema migrations (tail-appended entries only, Section 9);
2. if the activation marker shows v2 never activated **and** conversion has
   not been recorded: runs the in-process preflight checks — any aborting
   finding fails startup with diagnostics and **commits nothing**, leaving
   the old schema and data fully intact;
3. inside the single pre-listen write transaction: conversion (Section 3),
   the migration report, journal initialization with its first reset
   generation, the cutover reset, the durable conversion marker, activation
   timestamps, and the transition to `active`
   (`ponytail: one transaction — a single-user instance's whole legacy
   dataset fits in one SQLite write transaction, same argument as V3's
   unchunked purge`);
4. starts the readiness components: V2's list (schema, projector, journal,
   poll loop, reconciliation drain, orphan worker) plus the push callback
   handlers; renewal needs no component of its own (1.3).

Capability reports v2 only after all of this commits (V2 §5.6). A crash
anywhere before commit leaves a legacy-intact database that simply retries
on next start. Re-activation and continuous-restart behavior are V2 §7.1's,
unchanged; conversion runs at most once, guarded by its marker.

### 4.2 The flip is core-only

Web needs no coordinated deploy at flip time: it discovers v2 through
`/capabilities` per request, memoizes only successful readings, degrades to
legacy on capability-fetch failure, and fails closed on malformed v2
envelopes (V2 §5.6, C1/C5). Flipping `RSC_SOURCE_MODEL_V2=on` on core
restarts core, and the already-deployed web follows on its next capability
read. The enabled capability shape is V2's
`{sourceModelV2: true, model, journalCursorVersion, streamProtocolVersion}`;
V4, like V3, adds no capability field.

### 4.3 The post-conversion guard

After the conversion marker is committed, starting the process with
`RSC_SOURCE_MODEL_V2=off` is a **startup error** naming the backup-restore
procedure — the same fail-loud pattern as the existing
`database is newer than this build` guard
(`core/src/storage/sqlite.ts:696-697`). Running the v1 branch against a
converted database would resume legacy polling and legacy push writes beside
live v2 state — a dual-model corruption the roadmap's no-dual-write rule
exists to prevent. This one guard is the entire flip-back surface: before
conversion commits, `off` is always safe; after, the only way back is the
backup (Section 5).

## 5. Rollback posture

The roadmap forbids rollback machinery, so V4 does not pretend to have any.
The honest alternative, in full:

- **The restore point is the pre-flip backup.** The operator takes a Cloudron
  app backup immediately before setting the flag (Section 8). Restoring it
  returns the instance to the exact pre-conversion state — schema, data,
  leases, sessions. Anything written after the flip is lost with it;
  acceptable and stated for a single-user pre-release instance.
- **An aborted conversion needs no rollback.** Preflight failures and any
  pre-commit crash leave the old schema intact by construction (4.1);
  restart with the flag off and correct the data.
- **Post-cutover problems are fixed forward.** Migrations are strictly
  append-only; the moderation, quarantine, hide, purge, and manifest tools
  from V1–V3 exist precisely so that a bad conversion outcome is correctable
  in place (re-review a quarantined instance, hide an item, purge a source)
  without schema surgery.
- **There is no downgrade path** — no reverse migration, no v1
  re-materialization from v2 state, no version matrix. The 4.3 guard makes
  that explicit at startup instead of letting it be discovered as
  corruption.

## 6. The ops-token compatibility route

V4 is the first consumer of the ops-token route the V1 review deferred. The
reason it lands now: cutover retires the token's one remaining legacy job —
`POST /users` with `Authorization: Bearer $RSC_TOKEN`
(`docs/superpowers/documentation/RUNNING.md`, curl cheat sheet: "its one
remaining job"). Operator scripts that provisioned peers by token need the
compatibility operation the moment the legacy route stops being routed.

The contract is V1 plan Task 7 Step 3, adopted verbatim:

```http
POST /ops/sources/federation
Authorization: Bearer <RSC_TOKEN>
{"url":"https://example.test/feed","attributionMode":"aggregate",
 "category":"operator_policy","note":"configured peer","commandId":"<uuid>"}
```

- It invokes `establishFederation` only — the identical domain transition the
  admin route uses; no second code path.
- Audit actor kind `operator_token`, actor ID
  `ops:<first 16 hex chars of SHA-256(RSC_TOKEN)>` — a stable non-secret
  fingerprint; the raw token is never stored or returned
  (`RSC_TOKEN` is required config, `core/src/config.ts:44-45`).
- It composes its own `bodyLimit` like every externally reachable POST
  (house `jsonWrite`, `core/src/api/app.ts:65`, `MAX_JSON_BYTES` at `:63`),
  carries `commandId` in the body, and uses the shared command ledger with
  the V1-pinned fingerprint `["federation", normalizedUrl, attributionMode]`.
- Authorization boundary per the V1 review's Finding 3: the token reaches
  **only** this route. On every `/admin/*` route a bearer-only request has
  no better-auth session and receives 401 from `sessionAuth`
  (`core/src/api/auth.ts:64-66`) before any admin check — the ops columns of
  the admin matrix are 401, not 403. The token grants no read, moderation,
  purge, evidence, subscriber, or migration-report access.
- The route exists only under v2 (it creates v2 sources); it is not part of
  the public Caddy exposure set — operators call core internally, exactly as
  they call `POST /users` today.

This reintroduces the `operator_token` audit actor kind and the `ops` ledger
scope. Section 10 records the SQL CHECK consequence for the cross-vertical
review.

## 7. Legacy retirement

Retirement is a **separate release after cutover has soaked on all
instances**, not part of the flip:

- delete the v1 runtime branch: legacy remote polling and v1 push-in wiring
  (`createPushIn`/`runPollCycle` v1 paths, `core/src/server.ts:24-25,63`),
  legacy remote-author routes (`POST /users`, `DELETE /users/:handle`), the
  legacy timeline/feed branches, and web's v1 loader/action branches;
- flip the config default: `RSC_SOURCE_MODEL_V2` defaults `on`; the variable
  remains recognized for one release (with `off` rejected on a converted
  database per 4.3, and meaningless on a fresh one), then retires entirely;
- `/capabilities` remains permanently — web still validates envelopes and
  the route is the versioning surface for `journalCursorVersion` and
  `streamProtocolVersion`;
- legacy tables are **not dropped**: `users`, `posts`, `post_revisions`,
  `follows`, `subscriptions`, and `instance_settings` all have live v2 or
  shared roles; the legacy `push_subscriptions` table and inert remote
  `posts` rows stay in place per 3.2/3.4
  (`ponytail: dropping storage is a later cleanup batch with zero feature
  value now; the migration array only ever appends`).

Nothing in retirement changes wire contracts: it deletes the branch that the
flag has kept dark, and the off-flag regression suites retire with it.

## 8. Operator runbook

The deploy reality: three independent single-node Cloudron instances
(textcaster.app, alice, bob), one shared image, per-instance env flags,
forward-only migrations on live SQLite databases. The runbook is
per-instance and deliberately boring; stagger it (alice → bob → main) so the
production instance flips last.

1. **Gate.** Full completion gate green on main (Section 11), including the
   final cross-vertical contract review (Section 10). Build and publish the
   image.
2. **Deploy dark.** Update all three instances to the V4 image with
   `RSC_SOURCE_MODEL_V2` unset/off. Verify: app healthy, `/capabilities`
   reports `{sourceModelV2:false}`, legacy behavior byte-identical (the
   off-flag suites promise this; spot-check timeline + a feed).
3. **Preflight.** `cloudron exec` into the instance; run the preflight
   command against the live database (read-only). Fix findings via the
   documented correction procedure; rerun until clean. Stage the manifest
   file if instance rows need approval decisions.
4. **Backup.** Take the Cloudron app backup. This is the restore point;
   do not skip it — it is the entire rollback story (Section 5).
5. **Flip.** Set `RSC_SOURCE_MODEL_V2=on` for the app and restart. Startup
   runs preflight again, then conversion + activation pre-listen. A startup
   failure here committed nothing: unset the flag, restart (back on legacy),
   investigate with the diagnostics.
6. **Verify.** `/capabilities` reports the enabled v2 shape; SSR timeline
   renders converted items; a pre-cutover `/post/:id` permalink resolves; a
   reserved `/u/:handle` redirects to its publisher page; admin migration
   report is readable and its findings are sane; admin source page shows
   preserved push state; post locally and see it live over SSE; if a peer
   hub holds a lease, confirm the next fat ping ingests (or trigger a peer
   post).
7. **Repeat** steps 3–6 per instance.
8. **Retire.** After all three have soaked, ship the retirement release
   (Section 7) as an ordinary image update.

## 9. Schema and migration entries

All V4 schema lands as expand-only entries appended strictly at the tail of
the `user_version`-indexed `MIGRATIONS` array
(`core/src/storage/sqlite.ts:566`, applied ascending at `:706-709`;
mid-array insertion would renumber applied migrations on populated
databases):

- the v2 push-subscription relation (1.2);
- the handle-reservation relation (3.5);
- the migration-report findings relation and the conversion marker (3.6,
  4.1 — the marker may extend V2's activation metadata rather than add a
  table; plan-level);
- run-level push-capability claim storage (1.1), if V2's run tables did not
  already leave room.

Exact DDL is plan-level. V2's and V3's table names are still unfrozen (their
plans are pre-execution), so this spec binds columns and semantics, not
identifiers — the same stance V3 §9 took. Conversion itself (Section 3) is
**not** a migration entry: it is flag-triggered and marker-guarded (4.1),
because migrations run unconditionally at startup and conversion must not.

## 10. Cross-vertical contract closures

The roadmap requires a final cross-vertical contract review before any
implementation. V4 is where unresolved cross-vertical items land; the
review's checklist is:

1. **SQL CHECK vocabulary must be pinned at V1 authoring time — escalated.**
   SQLite cannot widen a CHECK without a table rebuild. Three V4 writers hit
   CHECKs authored by V1's plan: conversion writes source-audit rows with
   category `migration_review` (3.1) into a CHECK the V1 fold narrowed to
   six values; the ops route writes audit actor kind `operator_token` and
   ledger scope `ops` (6). Because **no vertical is implemented yet**, the
   fix is free: the cross-vertical review must direct V1's plan to keep the
   full foundation vocabulary in the SQL CHECKs (`source_audit_v2.category`
   all nine values; `actor_kind` including `operator_token`;
   `command_ledger_v2.actor_scope` including `ops`) while TS enums stay
   narrowed per vertical — V3 §1.2 already proved enum-narrower-than-CHECK
   is the workable pattern in the other direction. If the review instead
   keeps the narrow CHECKs, V4's migration must rebuild `source_audit_v2`;
   this spec assumes the pin.
2. **`policy_generation` owner (V3 open item 1) — closed upstream.** V2's
   plan adds it (V2 §2.3/§3.7 read it); the fallback (V3's fan-out migration
   adds it) still holds. V4 only requires that it exists; conversion sets
   generation 0 on every converted source and relies on the single cutover
   reset, not per-source transitions.
3. **V2 interim cleanup (V3 open item 3) — closed by V3 §5.4.** Nothing
   lands in V4.
4. **V3 §3 recorded push facts — all consumed here:** parse-time capability
   capture (1.1), the explicit expired/invalid lifecycle replacing the
   two-state legacy shape (1.2, `core/src/domain/types.ts:84`), the
   pause/block matrix (1.4), no-unsubscribe/lease-expiry (1.3), and
   foundation §12 treated as preservation charter, never push schema
   authority (1.2, 3.4).
5. **`SourceSummary.push` (V1-deferred, V3 §7.3 pointer) — first written
   here** with V1's declared shape verbatim (1.5).
6. **`updatedAtProvenance` widens with `legacy_unknown` (3.2)** — an
   intentional supersession of V2 §3.4's exact enum; V2's plan tests must
   expect widening, mirroring how V3 widened `attributionLevel`.
7. **Capability contract (V2 C5) — no change.** V4 adds no field; cutover is
   a value flip on the shape V2 froze, and the flip is core-only (4.2).
8. **Ops-token authorization matrix (V1 review Finding 3) — adopted:** admin
   routes 401 bearer-only requests; the token's whole surface is the one
   compatibility route (6).

## 11. Acceptance

Focused suites new to V4 (file names fixed at plan time), kept to the
matrix the foundation already mandates plus the cutover seams:

- **Migration (foundation §13, verbatim):** every legacy `feed_type`,
  manifest validation (each abort class), exact ID preservation (source =
  legacy user ID, item = legacy post ID), invalid-URL and
  normalized-collision aborts leaving the old schema intact, legacy-instance
  follows → `pending_review`, over-cap grandfathering, push
  preservation with byte-exact column assertions plus invalid-row evidence,
  `legacy_unknown` provenance never acting as an explicit watermark,
  permanent handle reservation surviving purge, atomic report + cutover
  reset, and full abort rollback.
- **Push (foundation §13's mandatory scenarios, now V4's):** paused/blocked
  fat pings authenticate, return neutral success, and are neither parsed nor
  stored; paused/blocked thin pings return normally without fetching; known
  in-flight challenges complete without acquisition; no renewal while paused
  or blocked; quarantined enabled sources keep storing admin-only push
  deliveries. Plus: lifecycle transitions (deny → `invalid`, lapse →
  `expired`, re-attempt reuses token/secret), the rsscloud→websub upgrade,
  the 10× poll cadence for active-push sources, and redaction over push
  rows.
- **Cutover seams:** conversion marker + flag-off startup error (4.3);
  capability flip observed by an already-deployed web (memoized-success
  path); a pre-conversion callback token authenticating a post-conversion
  fat ping (lease continuity); resumed paced acquisition after commit.
- **Ops route:** the V1 Task 7 matrix restricted to this route — bearer
  succeeds here and 401s on every admin route; invalid token 403/401 per
  the pinned contract; ledger replay and mismatched-fingerprint 409; the
  fingerprint actor ID in audit; no raw token in any body.
- **Off-flag regression:** the V4 image with the flag off is byte-identical
  legacy behavior, including v1 push-in (nothing V4 adds may load).

Completion gate (unchanged from V2 §7.5 / V3 §11): core Vitest, core
`tsc --noEmit`, web Vitest, `svelte-check`, production web build, plus the
off-flag regression and on-flag isolation suites. Vertical 4's gate
additionally requires the Section 10 cross-vertical contract review to be
folded into all four plans before any vertical's implementation begins, per
the roadmap's execution rule.

## Out of scope

- Publisher-wide follows, publisher feeds, and reviewed
  authorship/ancestry/convergence corrections (foundation backlog).
- Dropping legacy tables or deleting inert remote `posts`/`post_revisions`
  rows (a post-retirement cleanup batch, if ever).
- Push delivery *sending* changes — outbound push is untouched (Purpose).
- Any multi-instance coordination: each Cloudron instance converts
  independently on its own flip; there is no fleet orchestration to design.
- New better-auth surface, new dependencies, new scheduling loops.

## Result

Vertical 4 ends the milestone the way the roadmap demanded: the v2 model
gains its last subsystem (inbound push, rebuilt on sources with v1's
hardening rules and constants), the legacy data crosses over in one
preflight-guarded, marker-guarded, pre-listen transaction that preserves
every ID, permalink, follow, and push lease exactly, and the flag flip is a
per-instance restart with a backup as the whole rollback story. The ops
token keeps its one job through a single compatibility route, handles are
reserved forever, and the v1 branch is deleted only after the cutover has
soaked. No new loops, no new command idiom, no machinery for contention one
process cannot have. The next step is the Vertical 4 implementation plan
after this spec's repository review and the final cross-vertical contract
review; nothing here authorizes code.
