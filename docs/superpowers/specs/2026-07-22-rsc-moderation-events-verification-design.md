# RSC moderation, events, verification, and evidence review — Vertical 3 design

**Date:** 2026-07-22
**Status:** Draft; ready for repository review
**Revision:** 1 — initial draft against the revved V1 contracts (post-deferral)
and V2 spec rev 4 + review rev 1.
**Foundation:** `2026-07-20-rsc-source-governance-moderation-design.md` rev 3
**Roadmap:** `2026-07-20-rsc-source-governance-vertical-roadmap.md` rev 4, §Vertical 3
**V1 contracts:** `../plans/2026-07-20-rsc-source-control-plane.md` rev 4, as
amended by the deferral decision in
`../reviews/2026-07-22-v1-source-control-plane-review.md` — V1 no longer ships
the forward surface V3 was expected to consume; this spec (re)introduces each
deferred item whose first writer is V3.
**V2 contracts:** `2026-07-22-rsc-logical-items-ordinary-reads-design.md`
rev 4 + review rev 1 folded — journal `upsert | remove | reset` with
reset-generation recovery, `ReplyCountOverlay`, read-time projection authority,
and the refresh command conventions (body `commandId`, pinned fingerprints,
`jsonWrite` composition).
**Scope:** Vertical 3 only. No implementation planning is authorized by this
document.

## Purpose and boundary

Vertical 3 makes the v2 model durably moderatable. It delivers hidden
moderation, structural tombstones and placeholder continuity, resumable
generation-qualified policy fan-out, the v2 push subsystem with its
paused/blocked behavior, bounded origin verification with the `verified_origin`
evidence rung, purge and block tombstones, conflict exposure, paginated
evidence APIs, and the administrator review surfaces.

Everything remains behind startup-immutable `RSC_SOURCE_MODEL_V2=off` by
default. With v2 off, no V3 table, worker, route, or push registration is
active and legacy behavior — including legacy push — is unchanged. With v2 on,
V3 extends the V2 branch only; it adds no second projection, journal, or
command idiom. This is a single-user pre-release system in one Node process:
V3 adds no distributed locks, leases, shadow comparisons, rollout percentages,
or multi-version rollback machinery.

V3 extends the Vertical 2 journal; it introduces no new event kind and no new
client-invalidation mechanism. Every V3 effect is expressed as the existing
`upsert | remove | reset` records under V2 §5's rules.

Migration, the ops-token compatibility route, permanent legacy aliases, and
reviewed correction actions remain out of scope (see Out of scope).

## 1. Hidden moderation

### 1.1 State and commands

A logical item gains one reversible remote-item moderation state, `hidden`,
stored as a nullable `hidden_at` timestamp on the logical-item row. Hidden is
item-level: it overrides every delivery and survives polling, push
redelivery, versions, verification, reselection, restart, and replay. There
is no rejected state and no second moderation rung.

`hide` and `restore` are administrator commands against a stable logical-item
ID. Each requires an `AuditCategory` and accepts an optional note. Each is one
ledger-backed `BEGIN IMMEDIATE` transaction committing, atomically: the state
change, one immutable item-audit record, the item's recomputed
selection/classification hints, and the journal effect of Section 6.

- `hide` on a local-origin item returns `409
  {"model":"logical-v2","error":"local origin"}`; local moderation remains the
  existing deletion path.
- `hide` on an already-hidden item and `restore` on a non-hidden item are
  state conflicts (`409 {"model":"logical-v2","error":"not applicable"}`),
  distinct from the fixed idempotency-conflict body.
- Unknown items return the neutral `404
  {"model":"logical-v2","error":"item unavailable"}`.
- Restore clears `hidden_at` only. The item becomes ordinarily visible only
  if an eligible delivery currently exists (foundation invariant 7); restore
  never publishes previously ineligible evidence.

### 1.2 Item audit

V3 adds `item_audit_v2`, mirroring the V1 `source_audit_v2` shape
(id, logical-item FK, command ID, actor ID, actor kind, action, category,
note, result JSON, created at) with actor kind restricted to
`administrator | system`. V3 emitters are `hide`, `restore`, and the
system-actor entries Section 4 and Section 5 name. Reads are cursor-paginated
exactly like V1 source audit.

V3 reintroduces the deferred audit categories `false_positive` and
`remediated` — their first emitters are restore and unblock. `migration_review`
stays deferred to Vertical 4 with its first emitter. (Coordination note: if
the folded V1 rev narrowed the `source_audit_v2` SQL `CHECK` to the six
V1-emitted categories, V3's migration must widen it, which in SQLite means a
table rebuild; if V1 kept the full nine-value `CHECK` and deferred only the
unused TS enum members, V3 adds two enum members and no DDL. The V1 fold
should choose the latter — flagged for the plan review.)

### 1.3 Surface policy

Hidden joins the single ordinary-visibility predicate in V2's central
projector; no surface implements its own check. Consequences follow without
new code paths:

- hidden items are absent from every river, publisher/source view, and
  RSS/Atom/JSON/comments feed;
- the single-item route (`GET /post/:id`, V2 §3.4) and the ordinary history
  route return the neutral ordinary `404`;
- a hidden node required to connect visible descendants becomes the existing
  neutral thread placeholder; a hidden leaf is `404`; branches with no visible
  node are pruned (V2 §4.3);
- SSE send-time projection already converts a now-hidden historical upsert to
  an effective remove (V2 §5.4).

`placeholderKind` remains exactly `'unavailable'`. No `hidden` or `tombstone`
kind is added: a distinguishing kind would leak the moderation reason the
foundation's placeholder contract forbids, and clients render all placeholder
causes identically.

Administrator representation requires both a verified administrator and an
explicitly administrative route; ordinary routes behave identically for
admins and non-admins.

## 2. Policy fan-out

Governance, federation, and attribution-mode transitions already commit
atomically with one journal `reset` and a policy-generation advance (V2
§3.7). Reads are immediately correct from current policy. What remains stale
after a transition is only the materialized selection/classification hints,
and V3 adds the durable fan-out that converges them (V2 §3.7: "Vertical 3
adds generation-qualified durable fan-out only to converge materialized
hints").

Because the hints are optimizations and the transition's single `reset` is
already the client barrier, **fan-out appends no journal events**. This
deliberately narrows foundation §6's "applies selection, classification, and
item events in transactions" wording to the V2 read-time-authority model:
emitting per-item events after a reset would double-notify clients that must
refetch anyway.

Mechanics — one durable row per source in `policy_fanout_v2`
(source ID, generation, last-item cursor, state
`pending | running | done | superseded`, updated at):

- the transition transaction upserts the source's row with its new generation
  and a cleared cursor; a newer transition overwrites and supersedes older
  work by generation comparison alone;
- a single in-process serial drain (the V2 reconciliation-drain pattern —
  `ponytail: serial drain in the one Core process; leases/fences only if
  fan-out ever leaves the process`) processes rows after each transition
  commit and once at startup;
- each batch (100 items, ascending logical-item ID over items holding any
  delivery from the source) runs in one transaction that first rechecks the
  stored source generation: a mismatch marks the row `superseded` and stops —
  stale batches never write;
- batches recompute hints through the shared comparator only; visibility,
  journal, and audit are untouched;
- restart resumes from the durable cursor.

Bounded single-item mutations — hide, restore, verification success, purge
reselection — recompute their own item's hints inline and need no fan-out.

## 3. Push (v2)

Roadmap §V3 requires paused/blocked push behavior; that presupposes v2 push
existing, and V2 §1.2 explicitly leaves building the push subsystem to
Vertical 3. V3 therefore delivers v2 WebSub/rssCloud subscriptions end to
end, reusing the legacy push-in machinery's shapes rather than inventing new
ones.

### 3.1 Capability observation

Each successful v2 acquisition parse already flows through the existing
discovery shape (`FeedDiscovery { hubs, self, cloud }`,
`core/src/domain/ingest.ts:12`, produced by `parseFeedWithMeta` at
`ingest.ts:87` and merged with response headers at `ingest.ts:246`). V3
records that discovery, bounded, on the acquisition run. Registration always
acts on the **latest successful run's** claims, revalidated at use against
current URL, SSRF (`checkCallbackUrl`, `core/src/domain/push-guard.ts:39`),
governance, tombstone, and ownership rules.

V2 §1.2 says V3 "re-parses push capability from the stored raw feed
evidence"; V3 realizes this as capability captured at parse time on each run
instead of retro-parsing stored blobs — equivalent authority (none, until
revalidated) and fresher data, at the cost of push registration starting on a
source's first post-V3 successful poll rather than at activation.
`ponytail: capability from the next poll, not a backfill pass; the poll
interval bounds the delay.`

### 3.2 Registration lifecycle

V3 adds one push-state row per source, `source_push_v2`, with the exact field
set the foundation's migration section preserves: protocol, endpoint, topic,
callback token, secret, state `pending | active | expired | invalid`, expiry,
and creation time. Target selection reuses `choosePushTarget`
(`core/src/domain/push-in.ts:30`); lease and renewal cadence reuse the
existing constants (`push-in.ts:41-46`); fat-ping HMAC reuses
`verifySignature` (`push-in.ts:16`).

A source is push-registrable when it is `enabled`, governance `allowed` or
`quarantined`, currently schedulable (an active subscription or a
pending/approved federation relationship — V2 §1.1), and its latest
successful run observed a usable capability. Registration and renewal run
from the v2 poll loop pass (the pattern of `runPollCycle`,
`core/src/domain/push-in.ts:258`), never from ordinary reads.

Callback routes reuse the existing token-addressed endpoints
(`GET/POST /websub/callback/:token`, `core/src/api/app.ts:407` and `:415`
with the existing fat-ping body limit): with v2 enabled the token resolves a
`source_push_v2` row instead of a legacy row. Callback tokens and secrets
never appear in any list, detail, error, or audit body; administrative reads
expose only safe state and an endpoint fingerprint.

### 3.3 Paused and blocked behavior

| Source state | Renew/subscribe | Fat ping | Thin ping | In-flight challenge |
|---|---|---|---|---|
| enabled + allowed | yes | authenticate, parse, store | fetch | completes |
| enabled + quarantined | yes | authenticate, parse, store (admin-only) | fetch | completes |
| paused | no | authenticate, ack, discard | return normally, no fetch | completes, no acquisition |
| blocked | no | authenticate, ack, discard | return normally, no fetch | completes, no acquisition |

- Discarded pings return the neutral success the caller expects and are not
  parsed or stored.
- Pause and block stop renewals and send no unsubscribe request; leases lapse
  at expiry (the foundation's "best-effort unsubscribe may defer to lease
  expiry" — V3 always defers: `ponytail: no unsubscribe call; lease expiry is
  the unsubscribe`). Blocked additionally performs no network of any kind.
- Valid known in-flight WebSub challenges (subscribe or unsubscribe) complete
  to avoid retries and oracles, but cause no subsequent acquisition.
- Resume performs one paced catch-up poll and then restores discovery and
  registration on the normal pass.
- Unknown tokens and unknown thin-ping URLs keep their existing neutral
  responses.

### 3.4 Push ingestion

A fat ping is a push-delivered acquisition: same bounded parser, same
acquisition-result transaction, same commit-time policy recheck, same
reconciliation jobs (V2 §2). A thin ping schedules one immediate fetch of
that source through the ordinary acquisition path. Both appear as runs with
`reason: 'push'` — widening V2's `AdminAcquisitionRun.reason` enum by one
value (an intentional additive supersession, like V2's widening of V1's
capability shape). Quarantined sources continue acquiring; their evidence
stays administrator-only through ordinary eligibility, with no push-specific
branch.

## 4. Bounded origin verification

### 4.1 Scheduling

A valid publisher URL first seen in an aggregate claim schedules containment
verification. Checks are durable rows in `verification_checks_v2` keyed by
(logical item, publisher feed URL) — per item, not merely per publisher URL —
with state `pending | verified | unverified`, attempt count, and next-attempt
time.

Bounds (constants, plan-adjustable):

- at most 25 previously unseen publisher URLs create checks per aggregate
  response; the rest are dropped as bounded evidence;
- at most 50 pending checks per publisher URL and 200 per source;
- retries use the V2 job backoff (`min(5s * 2^(attempt-1), 15 min)`, 8 total
  operational attempts);
- one in-process serial verification drain shares the reconciliation-drain
  pattern; global concurrency is one
  (`ponytail: serial fetches; a scheduler with slots only if verification
  volume ever matters on a single-user instance`).

The drain deduplicates by key, batches all pending checks for one publisher
URL into one bounded fetch (the V2 §1.5 network/bounds profile applies:
deadline, redirect and body caps, SSRF and governance checks on every hop),
and evaluates every queued check for that publisher against the one parsed
response. A response fetched within the last 10 minutes serves newly queued
checks without refetching. Paused, blocked, and tombstoned targets are not
fetched.

### 4.2 Matching and outcomes

A check verifies containment only by the two convergence keys: exact
normalized permalink, or resolved publisher plus exact explicit opaque ID.

- **Match** → `verified`: persist a direct-origin delivery and its evidence
  under a find-or-created source with the foundation's verification defaults
  (`single_publisher + enabled + federation none`, governance inherited from
  the asserting source), recorded with a system-actor item-audit entry.
- **Successful fetch, no match** → `unverified`, terminal. Feed absence is
  inconclusive (old items fall out of feeds) and retrying cannot cure it;
  the claim remains asserted/unverified, never contradicted.
- **Operational failure** → retry with backoff; exhaustion → `unverified`.

Verification never changes governance or federation, creates no
subscription, clears no moderation, and reparents nothing. Blocked or
tombstoned publisher URLs are never verified.

### 4.3 The verified rung and publisher aliases

V3 prepends `verified_origin` as the new strongest evidence level. The
comparator order becomes:

1. `verified_origin`;
2. `bound_single_publisher`;
3. `aggregate_assertion`;
4. `source_scoped_fallback`.

Because V2's comparator is strongest-first, the addition is purely additive
(V2 §3.2 reserved exactly this). `SelectedAuthor.attributionLevel` gains the
value; V2's exact three-level enum and its ranking tests widen — an
intentional supersession, stated here so it is not read as drift.

Eligibility is uniform: a verified delivery participates in the ordinary
comparators only while its source is ordinary-eligible. Foundation §7's
"quarantined origin evidence may strengthen attribution but cannot supply
displayed content" is deliberately narrowed to V2 §3.2's single rule —
quarantined evidence participates in **neither** ordinary comparator and
remains administrator-visible only. One comparator, no per-axis exception;
flagged for maintainer review as a foundation deviation.

A verified direct-origin publisher redirect (the V2 §1.6 permanent-chain
proof, applied to the publisher's own feed) may establish a publisher-feed
alias in `publisher_feed_aliases_v2` (URL → publisher). An aggregate redirect
never merges publishers; an alias collision records a conflict and merges
nothing. Verification success may change the remote selected author through
the ordinary comparator; it updates that item's hints inline and appends the
item's journal effect per Section 6.

## 5. Purge, tombstones, and cleanup

### 5.1 Block tombstones

V3 introduces `blocked_source_tombstones_v2` — the table V1 deferred to its
first writer — reusing the V1 plan's DDL verbatim (plan L238-242: canonical
URL plus terminal block and purge action, category, actor, note, and
timestamps), appended as part of V3's migration. V3 adds tombstone alias rows
(URL → tombstone) because purge deletes the source row and its
`source_aliases_v2` rows cascade away, while resolution must keep honoring
every blocking alias.

Source resolution — subscribe, OPML, federation establishment, and every
redirect hop in acquisition and verification — checks tombstones and
tombstone aliases and returns the existing generic unavailable result. V1's
resolution branches that queried a permanently empty table become live here.

### 5.2 Purge

`purge` is an administrator command, valid only against a `blocked` source
(`409 {"model":"logical-v2","error":"source not blocked"}` otherwise). One
`BEGIN IMMEDIATE` transaction commits, atomically
(`ponytail: one transaction, no chunked purge; a single-user instance's
worst source fits comfortably in one SQLite write transaction`):

1. write the tombstone with canonical URL, alias rows, and terminal
   block+purge facts;
2. delete the source's deliveries, observation versions, claims belonging to
   those deliveries, push state, verification checks, redirect evidence,
   validators, runs/jobs, and fan-out rows;
3. delete the source row — aliases, subscriptions, federation relationship,
   and source-audit history cascade with it (the tombstone's terminal facts
   are what survives, per foundation §8);
4. for each logical item that lost evidence: recompute hints if other
   deliveries remain; delete the item if unsupported and unreferenced; convert
   it to a structural tombstone if a surviving descendant references it;
   delete publishers left fully unreferenced;
5. append one journal `reset` and the ledger result.

The single reset is deliberate: block already made this source's evidence
ineligible and appended its own reset, so purge changes no ordinary
visibility — the reset is the cheap, uniform barrier covering row deletion
for any client holding pre-block state, matching the foundation's required
"reset/remove effects" without per-item events.

### 5.3 Structural tombstones

A structural tombstone is a terminal state of the logical-item row retaining
only logical ID, parent/root edges, and the immutable sort key — no content,
author, source, publisher, moderation reason, or delivery evidence (the
remote sibling of V2's `deleted_local` marker). It serializes exclusively
through the ordinary placeholder contract (`placeholderKind: 'unavailable'`),
offers no reply/edit/feed/source action, is not a valid new reply or adoption
target, and is removed when the deletion of its last referencing descendant
finds no remaining child edge
(`ponytail: swept at descendant-deletion time only; no background reaper`).
Reconciliation treats an arriving delivery for a structural tombstone as
administrator-only evidence; it cannot resurrect the item.

### 5.4 Last-subscription cleanup

V3 extends V1's cleanup command with the item effects it could not have: when
an allowed self-service source is removed (no subscription, federation
relationship, retention reason), its deliveries and claims are removed with
it under the same step-4 rules as purge — shared items reselect, unsupported
items are deleted, descendant-referenced items become structural tombstones,
unreferenced publishers are deleted — but **no block tombstone** is written
and one `reset` is appended only when any ordinary item was affected.

V1's interim `provenance = 'origin_verification'` retention branch is
replaced by the real condition: a source whose deliveries are current
verification evidence for any logical item is never removed by subscription
cleanup. (Such sources have no subscriptions, so the unsubscribe path cannot
normally reach them; the condition is the guard, hand-seeded in tests.)

### 5.5 Tombstone unblock

`POST` unblock on a tombstone requires a category, deletes the tombstone and
its alias rows, and creates no source; the next resolution of that URL is an
ordinary fresh creation. Its durable audit record is its command-ledger entry
(action, category, note, and tombstone identity in the stored result) —
there is no source or item row left to anchor an audit table row, and the
ledger already stores actor, command, result, and time
(`ponytail: the ledger row is the audit; a standalone FK-less audit table
adds nothing`).

## 6. Journal effects

V3 appends only V2-shaped records; the table is exhaustive for V3:

| Mutation | Journal effect |
|---|---|
| hide (item was ordinarily visible) | that item's `remove` |
| hide (item already ordinarily absent) | none |
| restore (item becomes ordinarily visible) | that item's `upsert` |
| restore (still no eligible delivery) | none |
| verification success changing selection/author/classification | that item's `upsert` |
| verification success changing nothing ordinary | none |
| policy fan-out batches | none (the transition's own `reset` was the barrier) |
| purge | one `reset` |
| last-subscription cleanup affecting ordinary items | one `reset` |
| tombstone unblock | none |
| push-delivered acquisition | ordinary V2 reconciliation effects |

Hide/restore of a resolved reply is a bounded ordinary-visibility change, so
its frame carries the V2 `ReplyCountOverlay` (root ID plus authoritative
current conversation count, computed in the send-time projection snapshot) —
V2 §5.5 verbatim, no new mechanism. Event creation stays atomic with the
mutation; live publication after commit; the journal is authoritative if live
delivery fails.

## 7. Administrative APIs

### 7.1 Command conventions

Every V3 mutating route reuses the established idiom without deviation:

- composes the house `jsonWrite` body-limit guard positionally
  (`jsonWrite = bodyLimit({ maxSize: MAX_JSON_BYTES })`,
  `core/src/api/app.ts:65`, `MAX_JSON_BYTES` at `:63`);
- carries `commandId` as a JSON body field into the shared V1 command ledger;
- returns the fixed replay result for an identical retry and
  `409 {"model":"logical-v2","error":"idempotency conflict"}` for a reused ID
  with a mismatched fingerprint.

Pinned fingerprint inputs, per command:

| Command | Fingerprint |
|---|---|
| `hide` / `restore` | `[command, logicalItemId, actor, category]` |
| `purge` | `['purge', sourceId, actor, category]` |
| `tombstone-unblock` | `['tombstone-unblock', tombstoneId, actor, category]` |

Notes are excluded from fingerprints (free text; a changed note on a retried
command is not a different command). A changed category is.

### 7.2 Authorization

All V3 administrative routes use the house
`authed` + `requireAdmin()` composition. The test matrix per route is
`[unauthenticated, anonymous, registered, administrator]` →
`[401, 403, 403, 200]`. A request bearing only `Authorization: Bearer
<RSC_TOKEN>` has no better-auth session and receives **401** from
`sessionAuth` before any admin check
(`core/src/api/auth.ts:64-66`) — there are no ops-token columns and no
reachable 403 for token bearers. The `operator_token` actor kind does not
exist in V3 (see Out of scope).

Credential-redaction tests assert push secrets, callback tokens, and auth
material never appear in any list, detail, error, ledger-replay, or audit
body; push state exposes only `{mode, state, endpointFingerprint, expiresAt}`.

### 7.3 Routes

Mutations:

```text
POST /admin/items/:logicalItemId/hide      {category, note?, commandId}
POST /admin/items/:logicalItemId/restore   {category, note?, commandId}
POST /admin/sources/:sourceId/purge        {category, note?, commandId}
POST /admin/tombstones/:tombstoneId/unblock {category, note?, commandId}
```

Reads (all cursor-paginated with the V2 conventions — opaque versioned
cursors over immutable tuples, default limit 50, maximum 100, invalid cursor
`400 {"model":"logical-v2","error":"invalid cursor"}`):

```text
GET /admin/items/:logicalItemId                     item review detail
GET /admin/items/:logicalItemId/deliveries
GET /admin/deliveries/:deliveryId/versions
GET /admin/items/:logicalItemId/claims
GET /admin/items/:logicalItemId/conflicts
GET /admin/items/:logicalItemId/audit
GET /admin/sources/:sourceId/items                  review navigation
GET /admin/tombstones
```

Detail responses return summary counts plus paginated subresources, never
unbounded collections. Every envelope carries `model: 'logical-v2'`.

```ts
type AdminItemDetail = {
  model: 'logical-v2';
  logicalItemId: string;
  origin: 'local' | 'remote';
  state: 'ordinary' | 'hidden' | 'unsupported' | 'structural_tombstone'
       | 'deleted_local';
  hiddenAt: string | null;
  selected: {
    deliveryId: string | null;
    publisherId: string | null;
    attributionLevel: SelectedAuthor['attributionLevel'] | null;
  };
  parentLogicalItemId: string | null;
  threadRootId: string | null;
  counts: {
    deliveries: number; versions: number; claims: number;
    conflicts: number; audit: number;
  };
  verification: {
    state: 'none' | 'pending' | 'verified' | 'unverified';
    attempts: number;
    lastCheckedAt: string | null;
  };
};
```

Subresource rows expose bounded normalized fields plus raw evidence as
bounded escaped text (the V2 §1.5 digest-backed rules apply to anything
oversized); a delivery row shows source ID, governance-derived eligibility,
key kind/key, first-arrival tuple, and version count; a claim row shows level,
publisher, first-arrival tuple, and conflict linkage; a conflict row shows
kind, the disputed keys or references, and the involved IDs. Exact field
lists are plan-level; the boundary — no secrets, no unbounded blobs, no
rendered HTML from Core — is not.

V2's `AdminSourceAcquisitionSummary` gains
`push: {mode, state, endpointFingerprint, expiresAt} | null` (the V1-deferred
shape, first written here) and `conflictCount`. Source detail's blocked group
gains purge; `GET /admin/tombstones` supplies the blocked/tombstoned
navigation group V1's admin page reserved.

## 8. Web review surfaces

All pages are SSR/no-JS-capable, follow `design-system/rsc/MASTER.md`, and
generate server-side command IDs retained across ambiguous retry (the V2
admin-form convention). Core returns semantic text; the Web admin pages
escape raw evidence as text and render previews only through the existing
shared sanitizer (`web/src/lib/server/render.ts`) — no second pipeline.

- **Item review page** (`web/src/routes/admin/items/[id]/`): the
  `AdminItemDetail` summary; paginated deliveries/versions, claims,
  conflicts, and audit; hide and restore forms with required category select
  and optional note.
- **Source page additions** (extending V2's admin source page): safe push
  state, conflict count, an items link, and — for blocked sources — the purge
  form. Purge and unblock confirmations state their distinct consequences
  (purge: evidence permanently deleted, URL stays blocked by tombstone;
  tombstone unblock: URL becomes creatable again, nothing is restored).
- **Tombstone group**: list with canonical URL and terminal facts, unblock
  form.

No ordinary (non-admin) page changes. Hidden items simply stop appearing
through the existing projector-backed loads and stream handling; conversation
views already refetch on remove and render placeholders (V2 §5.7).

## 9. Schema and migration

One expand-only migration, appended strictly at the tail of the
`user_version`-indexed `MIGRATIONS` array
(`core/src/storage/sqlite.ts:566`; applied ascending at `:706-709` —
mid-array insertion would renumber applied migrations on populated
databases):

- `hidden_at` and the structural-tombstone terminal state on the
  logical-item table;
- `item_audit_v2`;
- `policy_fanout_v2`;
- `verification_checks_v2`;
- `source_push_v2`;
- `publisher_feed_aliases_v2`;
- `blocked_source_tombstones_v2` (V1 DDL) plus its alias rows;
- bounded per-run push-capability columns on the acquisition-run table;
- the two reintroduced audit-category values (DDL impact per §1.2's
  coordination note).

Exact DDL is plan-level. V2's table names are not yet frozen (its plan is
under review), so this spec binds columns and semantics, not identifiers.

## 10. Cross-model isolation

With v2 off: no V3 route exists, no fan-out/verification/push worker starts,
`source_push_v2` stays empty, the callback token namespace resolves legacy
rows only, and legacy push and moderation behavior are byte-identical to
today. With v2 on: legacy push handlers are not routed (V2 §7.4 stands; V3's
push replaces, never coexists per-source), and every V3 effect flows through
the V2 projector, journal, and ledger. The capability payload is unchanged —
V3 adds no new capability field; Web discovers nothing new because ordinary
contracts are unchanged.

## 11. Acceptance

Focused suites new to V3 (file names indicative, fixed at plan time):

- **Moderation** — the foundation's mandatory scenario: hide an item from an
  approved aggregate peer; verify absence from rivers, profiles, history,
  feeds, and live/replay state and the neutral thread placeholder; poll,
  push-redeliver, edit, restart, replay, and origin-verify it hidden; restore
  and verify eligible reselection. The shared-delivery variant: quarantine
  one approved source while an allowed source keeps the item public — it
  leaves Federated, reselects, and hint convergence follows.
- **Fan-out** — restart mid-fan-out resumes from the cursor; rapid
  `quarantined -> allowed -> blocked` leaves only current-generation writes
  (stale batches supersede, never write); fan-out appends no journal records.
- **Push** — the foundation's mandatory matrix: paused/blocked fat pings
  authenticate and return neutral success without parse/store; paused/blocked
  thin pings return normally without fetching; known in-flight challenges
  complete without acquisition; no renewal while paused/blocked; quarantined
  enabled sources keep storing admin-only deliveries; v2-off leaves legacy
  push untouched (extends the existing `core/test/push-in.test.ts` coverage
  pattern).
- **Verification** — per-response/per-publisher/per-source caps; one fetch
  serves batched checks; no-match is terminal `unverified`; operational
  retry/backoff/exhaustion; success creates the direct-origin source with
  inherited governance, the verified rung wins selection, quarantined
  verified evidence stays out of both ordinary comparators; verification
  changes no governance/federation/subscription/moderation/ancestry.
- **Purge** — the foundation's mandatory scenario: purge a blocked source
  sharing an item with another remote source and converged on a local item;
  local origin and other eligible deliveries survive; unsupported items are
  deleted; ancestors of visible descendants become structural tombstones
  preserving exact thread edges across restart; tombstone URL and aliases
  block direct subscription and every redirect hop; terminal audit facts and
  the reset survive restart. The same structural-tombstone assertions apply
  to last-subscription cleanup.
- **Commands** — every V3 command: identical retry returns the stored
  result; mismatched fingerprint (each pinned input varied) returns the fixed
  409; one mutation, audit, and journal effect per command; state-conflict
  bodies distinct from the idempotency body; the
  `[401, 403, 403, 200]` matrix and bearer-token 401 on every admin route;
  redaction over all bodies including push secrets and callback tokens.

Completion gate (unchanged from V2 §7.5): core Vitest, core
`tsc --noEmit`, web Vitest, `svelte-check`, production web build, plus the
off-flag regression and on-flag isolation suites. Passing does not authorize
enabling v2 by default or beginning Vertical 4.

## Out of scope (Vertical 4 or later)

- **Ops-token compatibility route** (`POST /ops/sources/federation`), the
  `operator_token` actor kind, and the RSC_TOKEN fingerprint identity — V1
  deferred them to their first consumer; nothing in V3 consumes them. Their
  first real need is legacy-surface retirement at cutover → Vertical 4.
- Migration preflight, manifest, conversion, `migration_review` category,
  permanent legacy handle aliases, and legacy push-state preservation.
- Reviewed authorship, ancestry, and historical-convergence corrections
  (foundation §10 assigns them beyond initial actions).
- Publisher-wide follows and publisher feeds.
- Removal of the v1 runtime branch, default-on, and dual-model anything.

## Open V1/V2 contract dependencies (for the plan review)

1. **`policy_generation` owner:** the V1 fold deferred the column "to the
   vertical that first reads it"; V2 rev 4 reads it (§2.3 commit-time
   verification, §3.7 advancement), so V3 assumes it exists. The V2 plan must
   actually add it; if it does not, V3's fan-out migration adds column and
   advancement together.
2. **Audit-category CHECK width** (§1.2): V1's fold should keep the nine-value
   SQL CHECK while deferring only the TS enum members, or V3 pays a
   table rebuild.
3. **V2 interim cleanup:** V1's plan said "Vertical 2 extends the cleanup
   command with shared-item/structural-tombstone handling"; V2's spec defers
   structural tombstones here. Until V3, unsubscribing the last subscriber of
   a source with retained v2 items has no defined item effect — the V2 plan
   should retain the source (no removal) whenever v2 items reference it, and
   V3's §5.4 then supplies the removal semantics.

## Result

Vertical 3 completes the governance story the foundation promised: one
reversible hidden state enforced by the one projector, hint convergence that
can never outrun policy, push that obeys pause and block to the byte,
verification that strengthens attribution without manufacturing trust, and a
purge that leaves nothing behind except the tombstone that stops it from
coming back. It adds no event kind, no second command idiom, and no machinery
for contention this single process cannot have. The next step after
repository review is the Vertical 3 implementation plan; nothing here
authorizes code.
