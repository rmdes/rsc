# RSC moderation, events, verification, and evidence review — Vertical 3 design

**Date:** 2026-07-22
**Status:** Reviewed; ready for the Vertical 3 implementation plan
**Revision:** 1 — folds the dual review
`../reviews/2026-07-22-v3-moderation-spec-review.md` (VP1–VP6 + VC1–VC4).
Headline: the entire v2 push subsystem is **deferred out of V3** (VP1 — the
one maintainer-vetoable scope call in this rev); Section 3 keeps only the
pause/block forward constraint plus the recorded facts the future push
vertical inherits. Origin verification now rides V2's reconciliation drain
(VP2); the admin subresource routes collapse into bounded inline sections
(VP3). All five flagged decisions were upheld by both reviewers (#2 and #5
travel with the push deferral). Draft (rev 0) was written against the revved
V1 contracts (post-deferral) and V2 spec rev 4 + review rev 1.
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
moderation, resumable generation-qualified policy fan-out, bounded origin
verification with the `verified_origin` evidence rung, purge, conflict
exposure, bounded evidence APIs, the administrator review surfaces, and
exactly two tombstone mechanisms: the source tombstone table
(`blocked_source_tombstones_v2`, whose terminal action is `block | purge`)
and the structural-tombstone terminal state on logical items. There is no
third mechanism — "purge tombstone" is not a kind of tombstone; purge writes
into the block-tombstone table (Section 5). The v2 push subsystem is deferred
out of this vertical (Section 3).

Everything remains behind startup-immutable `RSC_SOURCE_MODEL_V2=off` by
default. With v2 off, no V3 table, worker, or route is
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
item-level: it overrides every delivery and survives polling, redelivery,
versions, verification, reselection, restart, and replay. There
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
stays deferred to Vertical 4 with its first emitter. The V1 fold's decision
here is made, not hypothetical: the three unused `AuditCategory` values were
removed from V1 as removals — `source_audit_v2` ships a six-value SQL `CHECK`
and the TS enum was narrowed to match. This costs V3 nothing: `false_positive`
is emitted only into `item_audit_v2`, a new table V3 authors with its **own**
`CHECK`, which must include `false_positive` and must not blindly mirror the
narrowed six-value list (a mirrored `CHECK` would fail restore at runtime);
`remediated` is emitted only by tombstone unblock, whose durable audit record
is its command-ledger row (§5.5) — it lives in `result_json`, which carries no
`CHECK`. Nothing ever widens `source_audit_v2`, so no SQLite table rebuild
occurs. V3 re-adds the two TS enum members.

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
refetch anyway. This narrowing is decided, not pending: foundation §6 carries
a dated amendment note recording it (V3 review VC3).

Mechanics — one durable row per source in `policy_fanout_v2`
(source ID, generation, last-item cursor, state
`pending | running | done | superseded`, updated at):

- the transition transaction upserts the source's row with its new generation
  and a cleared cursor; a newer transition overwrites and supersedes older
  work by generation comparison alone;
- the V2 reconciliation drain (V2 §2.3) — this milestone's one serial
  in-process scheduling loop — processes fan-out rows after each transition
  commit and once at startup; there is no second drain
  (`ponytail: one drain in the one Core process; leases/fences only if work
  ever leaves the process`);
- each batch (100 items, ascending logical-item ID over items holding any
  delivery from the source) runs in one transaction that first rechecks the
  stored source generation: a mismatch marks the row `superseded` and stops —
  stale batches never write;
- batches recompute hints through the shared comparator only; visibility,
  journal, and audit are untouched;
- restart resumes from the durable cursor.

Bounded single-item mutations — hide, restore, verification success, purge
reselection — recompute their own item's hints inline and need no fan-out.

## 3. Push (deferred)

The v2 push subsystem — WebSub/rssCloud capability observation, registration,
renewal, callbacks, and push ingestion — is deferred out of Vertical 3 to
Vertical 4 or its own vertical (review VP1). Roadmap §V3's "paused/blocked
push behavior" survives here only as a forward constraint binding whatever
push eventually ships: paused and blocked sources are never subscribed or
renewed and send no unsubscribe request (leases lapse at expiry — the
foundation's "best-effort unsubscribe may defer to lease expiry", always
deferred); fat pings for them authenticate, return the neutral success the
caller expects, and are discarded unparsed and unstored; thin pings return
normally without triggering a fetch; valid known in-flight challenges
complete (avoiding retries and oracles) but cause no acquisition; blocked
sources otherwise get no network of any kind; resume performs one paced
catch-up poll before ordinary discovery and registration restart. On this
single-user instance V2 §1.3's poll loop is fully functional; push is pure
latency optimization behind a flag nobody enables before Vertical 4.

Recorded for the push vertical (so it inherits decided facts, not stale
drafts):

- **Capability capture is at parse time, per acquisition run — this is
  forced, not a preference** (flagged decision #5, verified by review).
  V2 §1.2's "re-parse push capability from the stored raw feed evidence"
  wording is unfulfillable: V2 rev 1 stores digests for oversized evidence,
  not re-parseable channel discovery. The push vertical must record the
  discovery shape at parse time on each successful run and register from the
  latest successful run's claims, revalidated at use against current URL,
  SSRF, governance, tombstone, and ownership rules.
- **The legacy `PushSubscription` state is `pending | active` only**
  (`core/src/domain/types.ts:84`). Rev 0's `pending | active | expired |
  invalid` widened that shape while claiming reuse (review VC4); whoever
  ships push must define the expired/invalid lifecycle explicitly rather
  than presenting it as legacy reuse — and must not source the v2 push
  schema from foundation §12, an out-of-scope migration-preservation
  section, not a live schema authority.
- Flagged decision #2 (no unsubscribe call; lease expiry is the unsubscribe)
  was judged right-if-push and moves to the push vertical with everything
  else here.

## 4. Bounded origin verification

### 4.1 Scheduling

A valid publisher URL first seen in an aggregate claim schedules containment
verification as a new job **kind** on V2's reconciliation drain (V2 §2.3) —
not a separate loop. The drain's semantics apply unchanged and are not
re-specified here: one serial in-process loop, `(nextAttemptAt ASC, jobId
ASC)` ordering, the shared operational backoff and eight-attempt exhaustion,
startup pickup of pending/retrying work, and terminal-versus-operational
failure handling. The milestone runs exactly two loops: the poll loop and
the reconciliation drain.

`verification_checks_v2` slims accordingly: one row per
(logical item, publisher feed URL) — per item, not merely per publisher URL —
holding only the terminal state `pending | verified | unverified` and the
publisher batch key. Attempt counts and next-attempt times live on the
drain's job rows, nowhere else.

Bounds (constants, plan-adjustable):

- at most 25 previously unseen publisher URLs create checks per aggregate
  response; the rest are dropped as bounded evidence;
- at most 50 pending checks per publisher URL and 200 per source.

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
remains administrator-visible only. One comparator, no per-axis exception.
This narrowing was decided when V2 folded its review; foundation §7 carries
a dated amendment note recording it (V3 review VC3).

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
   those deliveries, verification checks, redirect evidence,
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
remote sibling of V2's `deleted_local` marker). It stays a **distinct**
terminal state rather than merging with `deleted_local` under an origin
discriminator because the retained-anchor asymmetry is load-bearing:
`deleted_local` permanently keeps the canonical local permalink and its
aliases as the anti-resurrection anchor reconciliation must check before
creating or converging a remote echo (V2 §2.6), and the marker is never
removed; a structural tombstone keeps no permalink or identity anchor at
all and lives only as long as a descendant references it. One is a permanent
identity claim, the other a sweepable connectivity edge — merging them would
force the sweep rule and the anchor columns onto both. It serializes exclusively
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

Credential-redaction tests assert auth material never appears in any list,
detail, error, ledger-replay, or audit body.

### 7.3 Routes

Mutations:

```text
POST /admin/items/:logicalItemId/hide      {category, note?, commandId}
POST /admin/items/:logicalItemId/restore   {category, note?, commandId}
POST /admin/sources/:sourceId/purge        {category, note?, commandId}
POST /admin/tombstones/:tombstoneId/unblock {category, note?, commandId}
```

Reads:

```text
GET /admin/items/:logicalItemId                     item review detail
GET /admin/items/:logicalItemId/audit
GET /admin/sources/:sourceId/items                  review navigation
GET /admin/tombstones
```

Only the audit list and source→items are cursor-paginated (the V2
conventions — opaque versioned cursors over immutable tuples, default limit
50, maximum 100, invalid cursor
`400 {"model":"logical-v2","error":"invalid cursor"}`). There are no
per-item subresource routes: deliveries (with their versions), claims, and
conflicts are bounded inline sections of `AdminItemDetail`, each capped at
100 rows newest-first with the true total in `counts`
(`ponytail: inline caps, no cursors; paginate a section only when a real
item ever exceeds 100`). Detail responses never return unbounded
collections. Every envelope carries `model: 'logical-v2'`.

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
  // bounded inline sections — cap 100 each, newest-first; counts above
  // carry the true totals (row field lists are plan-level)
  deliveries: AdminDeliveryRow[];   // versions inline per delivery row
  claims: AdminClaimRow[];
  conflicts: AdminConflictRow[];
  verification: {
    state: 'none' | 'pending' | 'verified' | 'unverified';
    attempts: number;
    lastCheckedAt: string | null;
  };
};
```

Inline section rows expose bounded normalized fields plus raw evidence as
bounded escaped text (the V2 §1.5 digest-backed rules apply to anything
oversized); a delivery row shows source ID, governance-derived eligibility,
key kind/key, first-arrival tuple, and its versions; a claim row shows level,
publisher, first-arrival tuple, and conflict linkage; a conflict row shows
kind, the disputed keys or references, and the involved IDs. Exact field
lists are plan-level; the boundary — no secrets, no unbounded blobs, no
rendered HTML from Core — is not.

V2's `AdminSourceAcquisitionSummary` gains `conflictCount`
(`SourceSummary.push` stays V1-deferred; the push vertical first writes it).
Source detail's blocked group
gains purge; `GET /admin/tombstones` supplies the blocked/tombstoned
navigation group V1's admin page reserved.

## 8. Web review surfaces

All pages are SSR/no-JS-capable, follow `design-system/rsc/MASTER.md`, and
generate server-side command IDs retained across ambiguous retry (the V2
admin-form convention). Core returns semantic text; the Web admin pages
escape raw evidence as text and render previews only through the existing
shared sanitizer (`web/src/lib/server/render.ts`) — no second pipeline.

- **Item review page** (`web/src/routes/admin/items/[id]/`): the
  `AdminItemDetail` summary; its bounded inline deliveries/versions, claims,
  and conflicts; paginated audit; hide and restore forms with required
  category select and optional note.
- **Source page additions** (extending V2's admin source page): conflict
  count, an items link, and — for blocked sources — the purge
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
- `item_audit_v2` (with its own category `CHECK` per §1.2 — `source_audit_v2`
  is untouched);
- `policy_fanout_v2`;
- `verification_checks_v2` (terminal state + batch key only; scheduling lives
  on V2's reconciliation-job rows, which gain the verification job kind);
- `publisher_feed_aliases_v2`;
- `blocked_source_tombstones_v2` (V1 DDL) plus its alias rows.

Exact DDL is plan-level. V2's table names are not yet frozen (its plan is
under review), so this spec binds columns and semantics, not identifiers.

## 10. Cross-model isolation

With v2 off: no V3 route exists, no fan-out or verification work is
scheduled, and legacy behavior — moderation and legacy push alike, neither of
which V3 touches — is byte-identical to today. With v2 on: every V3 effect
flows through the V2 projector, journal, and ledger; push under v2 remains
exactly where V2 §1.2 leaves it, deferred (Section 3). The capability payload
is unchanged — V3 adds no new capability field; Web discovers nothing new
because ordinary contracts are unchanged.

## 11. Acceptance

Focused suites new to V3 (file names indicative, fixed at plan time):

- **Moderation** — the foundation's mandatory scenario: hide an item from an
  approved aggregate peer; verify absence from rivers, profiles, history,
  feeds, and live/replay state and the neutral thread placeholder; poll,
  edit, restart, replay, and origin-verify it hidden; restore
  and verify eligible reselection. The shared-delivery variant: quarantine
  one approved source while an allowed source keeps the item public — it
  leaves Federated, reselects, and hint convergence follows.
- **Fan-out** — restart mid-fan-out resumes from the cursor; rapid
  `quarantined -> allowed -> blocked` leaves only current-generation writes
  (stale batches supersede, never write); fan-out appends no journal records.
- **Verification** — per-response/per-publisher/per-source caps; one fetch
  serves batched checks; no-match is terminal `unverified`; operational
  retry/backoff/exhaustion on the shared reconciliation drain; success
  creates the direct-origin source with
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
  redaction over all bodies.

Completion gate (unchanged from V2 §7.5): core Vitest, core
`tsc --noEmit`, web Vitest, `svelte-check`, production web build, plus the
off-flag regression and on-flag isolation suites. Passing does not authorize
enabling v2 by default or beginning Vertical 4.

## Out of scope (Vertical 4 or later)

- **The v2 push subsystem** — WebSub/rssCloud capability observation,
  registration, renewal, callbacks, and push ingestion — deferred to
  Vertical 4 (whose charter already includes push/follow preservation) or
  its own vertical; Section 3 records the constraints and decided facts it
  inherits.
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
2. **Audit-category CHECK width — resolved, no dependency remains** (§1.2):
   V1's fold decided a six-value `source_audit_v2` CHECK with the TS enum
   narrowed to match. V3 pays no rebuild: `item_audit_v2` defines its own
   CHECK (including `false_positive`) and `remediated` lives only in the
   command ledger's `result_json`. Kept here as a record, not an open item.
3. **V2 interim cleanup:** V1's plan said "Vertical 2 extends the cleanup
   command with shared-item/structural-tombstone handling"; V2's spec defers
   structural tombstones here. Until V3, unsubscribing the last subscriber of
   a source with retained v2 items has no defined item effect — the V2 plan
   should retain the source (no removal) whenever v2 items reference it, and
   V3's §5.4 then supplies the removal semantics.

## Result

Vertical 3 completes the governance story the foundation promised: one
reversible hidden state enforced by the one projector, hint convergence that
can never outrun policy,
verification that strengthens attribution without manufacturing trust, and a
purge that leaves nothing behind except the tombstone that stops it from
coming back. Push is deferred with its pause/block contract pre-written
(Section 3). It adds no event kind, no second command idiom, no second
scheduling loop, and no machinery for contention this single process cannot
have. The next step is the Vertical 3 implementation plan; nothing here
authorizes code.
