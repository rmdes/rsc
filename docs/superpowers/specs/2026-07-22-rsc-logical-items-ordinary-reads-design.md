# RSC logical items and ordinary reads — Vertical 2 design

**Date:** 2026-07-22
**Status:** Revision 4 ready for final whole-document review
**Revision:** 4 — binds the logical-v2 single-item envelope to its explicit
Core route after the Revision 3 comparator, DTO, and journal corrections.
**Foundation:** `2026-07-20-rsc-source-governance-moderation-design.md` rev 3
**Roadmap:** `2026-07-20-rsc-source-governance-vertical-roadmap.md` rev 4
**Timeline presentation:** `2026-07-22-root-only-timelines-design.md`
**Scope:** Vertical 2 only. No implementation planning is authorized by this document.

## Purpose and boundary

Vertical 2 is the first complete remote-item reader and writer for the source
model introduced by Vertical 1. It adds bounded polling acquisition, durable
delivery evidence and reconciliation, publishers and claims, logical items,
resolve-once threading, deterministic ordinary projection, unified feeds and
pages, and a durable replay journal.

The root-only timeline design is an explicit presentation dependency. Reply
storage, identity, ancestry, feeds, and conversations remain first-class;
river-style collections present conversation roots and unresolved replies,
while author activity views continue to include replies.

The work remains behind startup-immutable `RSC_SOURCE_MODEL_V2=off` by default.
There is no dual-write. When disabled, v1 remains unchanged. When enabled,
logical-v2 is the only remote acquisition and ordinary-read model and legacy
remote polling and inbound push are not started or routed.

Vertical 2 deliberately does not add v2 push subscriptions, origin
verification, hidden-item moderation, remote-source purge, durable remote
structural tombstones, policy fan-out, or the evidence-review system. Those
belong to Vertical 3. It stores the evidence those features will use but
exposes only bounded acquisition operations to administrators.

## 1. Acquisition boundary

### 1.1 Source state and acquisition reasons

Vertical 2 acquires remote deliveries through scheduled polling and
administrator-initiated manual refresh only. Both target an existing source by
stable source ID and use the same acquisition gate, parser, observation writer,
and durable reconciliation path.

| Source state | Scheduled polling | Administrator refresh | New evidence |
|---|---:|---:|---|
| enabled + allowed | with a scheduling reason | yes | ordinary-eligible |
| enabled + quarantined | with a scheduling reason | yes | administrator-only |
| paused | no | no | none |
| blocked | no | no | none |

Paused is operational only: existing retained deliveries remain eligible when
governance is allowed. Quarantine and block make that source's deliveries
ineligible, but an item may remain visible through another eligible allowed
source.

Scheduled acquisition requires an active source subscription or a pending or
approved federation relationship. Pending subscription intent, administrative
retention, and source existence alone do not schedule polling. Administrator
refresh is a one-shot reason and never makes a source subsequently schedulable.
Origin verification remains deferred.

### 1.2 Push boundary

Vertical 2 may persist bounded WebSub and rssCloud capability claims observed
in successfully parsed feeds. They are inert evidence: they convey neither
federation nor trust and cannot be contacted, treated as trusted URLs, or
converted to lease state. Vertical 3 must revalidate them against then-current
URL, SSRF, governance, and ownership rules.

Vertical 2 creates no leases, callback credentials, subscriptions, renewals,
unsubscriptions, or push ingestion. With v2 disabled, the unchanged v1 branch
continues legacy push. With v2 enabled, legacy polling and inbound push handlers
are not started or routed.

### 1.3 Durable scheduler

The scheduler has four acquisition slots and orders eligible work by
`(nextPollAt ASC, sourceId ASC)`. `baseInterval = RSC_POLL_SECONDS`. Startup
uses the same slots and ordering and has no separate overdue-source catch-up
launch.

Health state is durable: `nextPollAt`, last attempt/success/failure times, and
consecutive failures. Adding the first scheduling reason makes a source due
through the normal queue. Removing the last reason preserves health but makes
scheduled acquisition ineligible.

Success, `304`, successful item truncation, and committed domain conflicts reset
the failure count and calculate the next poll from completion. Operational
network, HTTP, timeout, body-limit, and feed-level parse failures use:

```text
failureDelay = min(
  baseInterval * 2^(consecutiveFailures - 1),
  max(baseInterval, 1 hour)
)
```

Cancellation, supersession, and policy rejection are not operational failures.
Manual success advances normal `nextPollAt`; manual operational failure updates
the same health and backoff state.

### 1.4 Acquisition claim and fencing

At most one fenced network acquisition may be active for a source. The active
claim covers fetching, parsing, and the acquisition-result transaction, not the
run's later reconciliation. A later command may start a new run after that
claim is released even while an older run has pending or retrying jobs.

Every claim has a monotonically changing fence. An expired claim is recovered
on the same run ID with a higher fence. Pause and block invalidate it
immediately. Acquisition commit verifies current run ID, fence, source policy,
and, for a scheduled run, a still-current scheduling reason. A manual command
association supplies its one-shot reason. A stale response commits nothing.

Different administrator commands may join only the currently active
acquisition claim. Their command-to-run associations are separate and commit
before the acquisition result. The same command always returns its original
run.

### 1.5 Network and evidence bounds

Acquisition uses a versioned bounds profile:

- one ten-second total deadline beginning before DNS/SSRF checks and covering
  DNS resolution, URL validation, requests, redirects, decompression, and body
  streaming;
- at most five followed redirects after the initial request;
- initial-URL and hop-by-hop credential, length, SSRF, governance, tombstone,
  alias-ownership, and URL checks;
- at most 5 MiB (`5 * 1024 * 1024`) of decoded response bytes, enforced while
  streaming;
- immediate rejection of an oversized declared `Content-Length`, while still
  counting actual decoded bytes;
- at most the first 1,000 candidate items in adapter wire order;
- at most 32 enclosure entries per item;
- operational strings no longer than 2,048 code points and 8,192 UTF-8 bytes;
- at most 1 MiB per item measured as UTF-8 bytes of the versioned canonical
  fingerprint/evidence representation.

RSS/Atom use document order, JSON Feed array order, and h-feed document order.
A zero-based ordinal is assigned before applying the 1,000-candidate cap. The
cap concerns candidates examined, not accepted items; skipped candidates do
not open capacity from the omitted tail. Omission is `completed_truncated`,
records known candidate/examined/omitted counts and `itemsTruncated: true`, and
does not automatically retry or create per-tail findings.

An oversized body is rejected without parsing and records
`bodyLimitExceeded`. Structural item violations—item evidence over 1 MiB,
excess enclosures, or an oversized required operational identifier—skip the
whole item. Optional oversized publisher/name claims may instead become inert
digest-backed evidence without skipping otherwise valid content.

Digest-backed evidence retains field kind, a bounded Unicode-safe prefix,
original UTF-8 byte length, optional code-point count, SHA-256, and
`truncated: true`. It can never become an identifier, link, alias, convergence
key, ancestry reference, publisher anchor, or displayed label. Raw publisher,
source, and name evidence has a 4,096-byte storage bound; public names have the
separate 200-code-point rule in Section 3. Diagnostics are redacted before
their 4,096-byte bound is applied.

Every run records parser adapter/version, bounds-profile version,
identifier-normalization version, and canonicalization/fingerprint version.
Every observation independently records its fingerprint version.

### 1.6 Redirect identity

Only an uninterrupted 301/308 chain beginning at the canonical URL or an
already-owned alias can prove a source alias. A 302, 303, or 307 breaks that
proof; later permanent hops remain evidence but establish no alias of the
original source.

```text
A ->301 B ->200 parsed feed       B may become an alias
A ->301 B ->302 C ->200           B may; C may not
A ->302 B ->301 C ->200           neither may
```

The last example assumes B is not already owned. If it is this source's alias,
it can begin a new permanent proof chain.

Only 301, 302, 303, 307, and 308 are followed. Normalized loops stop
immediately. Every followed or rejected hop retains bounded ordinal, status,
and normalized or digest-backed from/to evidence. Each qualifying permanent
target enters the shared canonical/alias/tombstone namespace only after a safe
fetch and successfully parsed feed. Redirecting to the same source's alias is
allowed without duplication.

An ownership collision commits the run outcome, redirect evidence, and
conflict, but no aliases, observations, jobs, validators, or conditional-fetch
changes. It is a domain outcome, not a scheduler failure. The fence guards the
whole result.

Polling always begins at the unchanged canonical URL. Validators are source
acquisition state indexed by the final effective URL that produced them.
Aliases have no validators, scheduler state, or acquisition reason of their
own. A `304` is valid only for a previously parsed representation at that
effective URL and establishes no new alias. Vertical 2 redirects establish
source aliases only, never publisher-feed aliases.

## 2. Evidence, identity, and reconciliation

### 2.1 Runs, observations, and counters

Every acquisition has a durable run ID. The acquisition-result transaction
atomically persists bounded observation versions, unique reconciliation jobs,
and their run association. After commit it wakes the shared worker. Correctness
never depends on immediate draining.

Acquisition counters are `candidates`, `seen`, `observed`, `unchanged`,
`skipped`, `omitted`, `itemsTruncated`, `bodyLimitExceeded`, and `notModified`.
A `304` has `notModified: true`, zero parsed candidates, and zero jobs.

Reconciliation counters are disjoint:

```text
reconciled | conflicted | pending | processing | retrying | failed
completed = reconciled + conflicted + failed
terminal = pending + processing + retrying = 0
failed = failedByCategory.operationalExhausted
       + failedByCategory.invariantOrDataFailure
```

Acquisition failures leave every reconciliation counter at zero. Terminal runs
and counters never reopen.

### 2.2 Delivery identity and observation versions

Same-source delivery identity uses this priority:

1. exact opaque RSS GUID, Atom ID, or JSON Feed ID;
2. otherwise normalized permalink;
3. otherwise deterministic synthesized fallback.

Opaque identifiers are exact strings and are never URL-normalized. A value
that independently qualifies as a permalink is normalized separately. The
synthesized fallback remains source-local; changing title, content, or date may
therefore create a new identity rather than an edit.

The exact delivery key is `(sourceId, keyKind, key)`. Observation versions use
a versioned canonical evidence representation and fixed SHA-256 fingerprint.
Raw claims and normalized semantic values are both retained. Body hashes are
diagnostic and never logical-item identity.

On a digest match, canonical material is compared. A true match is unchanged.
A mismatch records bounded `fingerprint_collision` acquisition evidence,
increments `skipped`, and creates no observation version, job, or
reconciliation counter change.

An unchanged refetch creates no version, run-association row, job, or journal
event. It updates bounded `lastSeenAt`, `lastSeenRunId`, and `seenCount` on both
the delivery identity and the exact matched historical observation version. It
may wake immediately eligible unfinished work but cannot change a retrying
job's next attempt, count, lease, or fence.

Distinct canonical versions under one delivery key are all persisted. If they
occur in one response, each retains its wire ordinal and gets its own job; the
acquisition records a conflict but skips neither version.

All versions have a durable total first-arrival key:

```text
(acquisitionCommittedAt, runId, wireOrdinal, observationVersionId)
```

Every rule depending on first or latest arrival uses this complete tuple.

### 2.3 Reconciliation worker

One worker executes one reconciliation job at a time. It may read a candidate
window of 16 ordered by `(nextAttemptAt ASC, jobId ASC)` but claims only the job
it is about to execute. Claims use a 60-second lease and monotonic fence.

The worker runs continuously, recovers expired claims at startup, wakes after
acquisition, and checks scheduled retries. Operational failures retry with:

```text
min(5 seconds * 2^(attempt - 1), 15 minutes)
```

Eight total operational failures exhaust a job; the longest scheduled delay
under that limit is 320 seconds. Deterministic invariant/data failures become
terminal immediately. Failure category is stored separately from redacted
diagnostic.

Lost-fence and policy-generation supersession consume no attempt or backoff;
current work is left or requeued. If a domain transaction rolls back because
of an operational failure, a separate small fenced transaction records the
attempt, next time, or terminal exhaustion and no logical, claim, selection, or
journal effects. Lost fence prevents even that bookkeeping.

Successful or conflicted reconciliation atomically verifies fence and current
policy, then writes all affected logical relationships, claims, conflicts,
presentation state, selection hints, journal effects, job state, and run
counters. Expected identity or attribution conflicts are successful
`conflicted` outcomes.

Jobs for one delivery finalize in first-arrival order. A later version waits
without consuming retry budget until earlier versions are terminal. Failed
versions remain evidence but are excluded from ordinary presentation. Initial
ancestry comes from the earliest version eligible under this same ordering.

### 2.4 Publishers and mode-neutral claims

A remote publisher is a neutral account, person, group, or publication
identity provisionally anchored by a canonical feed URL. It remains distinct
from the transport source even for a direct feed.

Reconciliation persists mode-neutral evidence: bound-publisher claims, valid
per-item publisher assertions, source-scoped fallback, conflicts, provisional
publishers, and bounded raw names. Reads can therefore derive either attribution
mode without writing. Approved federation transport does not verify a
third-party publisher claim.

Credential-bearing, malformed, or over-limit publisher URLs remain bounded
administrator evidence and cannot become identities or targets. Publisher-feed
aliases require direct-origin verification in Vertical 3.

### 2.5 Logical convergence

Logical-item convergence is permitted only by:

- an exact normalized permalink; or
- resolved publisher plus exact stable opaque GUID.

Names, titles, timestamps, body similarity, and body hashes never converge.
Permalink and publisher-plus-opaque candidates are evaluated independently.
No valid or owned permalink candidate permits publisher-plus-opaque resolution.
An ambiguous permalink stops resolution and never falls through. If both key
types resolve to different items, reconciliation records a conflict and merges
with neither.

Ambiguity or cross-key disagreement creates an isolated logical item for the
current delivery, records the conflict, and claims none of the disputed keys.
The delivery relation keeps its later versions attached. It can be ordinary
only through its own eligible delivery.

On uncontested resolution or creation, all uncontested valid identity keys are
claimed atomically for that logical item.

Before creating a remote identity, reconciliation checks canonical local posts,
including posts whose bridge row is not materialized. Local convergence uses a
unique canonical local permalink or alias. An opaque local GUID is valid only
when it independently has canonical-local-permalink semantics or when the
exact emitted GUID is resolved within the same local-account scope. Global
uniqueness alone is insufficient. No arbitrary post ID, handle, name, title,
timestamp, or content value is a local identifier namespace.

If an independently established remote item later collides with a local
permalink, reconciliation records a conflict and does not merge it.

### 2.6 Local-origin bridge and terminal deletion

`posts` and `post_revisions` remain the sole authority for local content,
revision history, and authorship. A local logical item has `logical_item.id =
post.id` and one unique restrictive local-origin reference. Logical metadata
does not duplicate mutable local content.

Ordinary reads may synthesize an untouched local projection without writing.
Materialization is race-safe and occurs only in a local mutation, threading
command, remote convergence, or explicit backfill. Local create, edit, reply,
post deletion, and account deletion atomically commit local storage, logical
metadata, thread effects, and journal effects.

A remote echo may attach evidence to a local item only through an exact unique
local identifier. It cannot change local content, author, ancestry, support,
visibility, timeline order, or Local/Public classification and never creates a
second ordinary item.

Local deletion is terminal. Deletion removes content and revisions and creates
a permanent `deleted_local` marker retaining only logical ID, canonical local
permalink and necessary aliases, deletion timestamp, and terminal state. It
retains its parent edge and required descendant connectivity only while
structurally necessary; roots remain derived and are never stored authority.
No content, author profile, source, or remote attribution remains.

Remote evidence attached or arriving later is administrator-only and cannot
support, display, reclassify, or resurrect the item. Reconciliation checks the
marker before creating or converging. Source purge can later remove remote
evidence but never the local marker. Account deletion applies the rule to all
affected posts in one transaction and uses one reset barrier; markers retain no
foreign-key dependency on the removed account.

## 3. Ordinary projection, authors, and lenses

### 3.1 Read-time authority

Persisted selected-delivery, selected-author, and classification fields are
optimization hints only. Every ordinary read, feed, history response, thread,
SSE projection, and reconciliation result derives effective delivery, author,
support, and classification from current policy in one consistent database
snapshot.

A pointer remains effective only if eligible and at the strongest current
evidence level. Otherwise the shared pure comparator selects deterministically.
Local origin and terminal local deletion override every remote candidate.

Eligibility and lens membership are applied before ordering and `LIMIT`. SQL
selects bounded candidates using current eligible-support existence; related
deliveries and claims are batch-loaded. Ordinary reads never repair stored
pointers.

`eligibleSourceIds` is sorted and duplicate-free.

### 3.2 Deterministic selection

The evidence levels, strongest first, are:

1. `verified_origin`;
2. `bound_single_publisher`;
3. `aggregate_assertion`;
4. `source_scoped_fallback`.

For display-delivery selection, first determine the strongest evidence level
that contains an ordinary-eligible delivery. Retain the persisted/current
delivery only when it remains ordinary-eligible at that strongest level.
Otherwise select the earliest delivery at that level by the complete durable
first-arrival tuple:

```text
(acquisitionCommittedAt, runId, wireOrdinal, observationVersionId)
```

Resolve any remaining tie by stable lexical delivery ID.

Selected-author resolution is independent. Determine the strongest level
containing an ordinary-eligible author claim. Retain the persisted/current
publisher only while a claim at that strongest level still supports it.
Otherwise select the earliest claim by the complete first-arrival tuple, then
stable lexical claim ID.

Vertical 2 defines `verified_origin` for forward compatibility but creates no
verified-origin evidence. Quarantined and blocked evidence remains retained for
administration but is not ordinary-eligible and participates in neither
ordinary comparator. Permalink convergence grants no authority to replace
content or author.

### 3.3 Chronology and pagination

Every logical item has immutable `timelineSortAt`, assigned only after initial
deterministic selection. Local items use authoritative local `published_at`.
Remote items use the initially selected delivery's normalized UTC publication
time only when it is no later than durable arrival; otherwise arrival time is
used and the raw claim remains evidence.

Projected `publishedAt` equals `timelineSortAt` forever. Edits expose separate
update metadata. Reselection, verification, author changes, redelivery,
moderation, and classification never reorder the item.

Timeline-like collections and feeds order by:

```text
(timelineSortAt DESC, logicalItemId DESC)
```

Thread siblings use the ascending tuple. Structural placeholders retain the
original sort key. Synthesized local rows already represented by materialized
logical rows are excluded.

Logical-v2 pagination cursors are opaque versioned encodings of the exact tuple.
Malformed, empty, v1, future/unknown-version, or invalid cursors return:

```http
400
{"error":"invalid cursor"}
```

Pagination is a stable ordering boundary, not snapshot isolation. Live upserts
are placed by immutable order rather than blindly prepended.

### 3.4 Logical item and selected author DTOs

```ts
type LogicalItemId = string;
type SourceId = string;

type SelectedAuthor =
  | {
      kind: 'local';
      id: string;
      handle: string;
      displayName: string;
    }
  | {
      kind: 'remote_publisher';
      id: string;
      displayName: string;
      canonicalFeedUrl: string | null;
      profileAvailable: boolean;
      attributionLevel:
        | 'verified_origin'
        | 'bound_single_publisher'
        | 'aggregate_assertion'
        | 'source_scoped_fallback';
    };

type ReplyContextDto = {
  kind: 'asserted_external';
  authorLabel: string | null;
  snippet: string | null;
  url: string | null;
};

type EnclosureDto = {
  url: string;
  mimeType: string | null;
  title: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
};

type LogicalItemDto = {
  kind: 'logical_item';
  id: LogicalItemId;
  origin: 'local' | 'remote';

  parentResolutionState: 'none' | 'missing' | 'ambiguous' | 'resolved';
  parentLogicalItemId: LogicalItemId | null;
  threadRootId: LogicalItemId | null;

  selectedAuthor: SelectedAuthor;

  title: string | null;
  content: string | null;
  contentMarkdown: string | null;
  permalink: string | null;
  sourceLink: string | null;
  replyContext: ReplyContextDto | null;
  enclosures: EnclosureDto[];

  publishedAt: string;
  updatedAt: string | null;
  updatedAtProvenance: 'explicit' | 'arrival' | null;

  directReplyCount: number;
  conversationReplyCount: number;

  eligibleSourceIds: SourceId[];
  classification: {
    federated: boolean;
  };
};

type LogicalSingleItemEnvelope = {
  model: 'logical-v2';
  item: LogicalItemDto;
  journalCursor: string;
};
```

The wire bounds and invariants are exact:

- logical-item, source, account, publisher, and claim IDs are non-empty opaque
  ASCII strings of at most 128 bytes;
- local handles are non-empty validated handles of at most 64 UTF-8 bytes;
- public display names and `ReplyContextDto.authorLabel` are normalized,
  HTML-escaped by Web, and at most 200 Unicode code points;
- `title`, `content`, `contentMarkdown`, reply-context text, and enclosure
  metadata remain inside the versioned 1 MiB combined item-evidence bound;
- `ReplyContextDto.snippet` has an additional 4,096 UTF-8-byte public bound;
- every exposed URL is credential-free HTTP(S), contains no fragment, and
  satisfies both the 2,048-code-point and 8,192-UTF-8-byte operational limits;
- `mimeType` is a normalized ASCII media type of at most 255 bytes;
- enclosure `title` is at most 1,024 Unicode code points; the array contains at
  most 32 entries in accepted presentation order;
- `sizeBytes` is a non-negative safe integer or null; `durationSeconds` is a
  finite non-negative number or null;
- `publishedAt` and non-null `updatedAt` are normalized UTC instants;
- `updatedAtProvenance` is null exactly when `updatedAt` is null;
- reply counts are non-negative safe integers;
- `eligibleSourceIds` contains every source currently supplying eligible
  ordinary support, sorted lexically and duplicate-free; its serialized bytes
  remain within the same 1 MiB ordinary-item envelope bound;
- `classification.federated` is true exactly when at least one ID in the
  current eligible support has a currently approved federation relationship.

At least one of `title`, `content`, or `contentMarkdown` is non-null. Core
returns semantic text only; Web derives sanitized HTML. `permalink` is the
ordinary navigation URL for the logical item. `sourceLink` is the selected
presentation's independently safe external item link and is null when no such
link is ordinary-safe. A resolved reply has a non-null
`parentLogicalItemId` and null `replyContext`; `missing` or `ambiguous` has a
null parent and may expose bounded asserted external context; `none` has neither
a parent nor reply context. A non-null `replyContext` contains at least one
non-null semantic field. Remote `profileAvailable` is true only for a
navigable feed-anchored publisher with an ordinary-safe canonical feed URL;
source-scoped fallback is always non-navigable with `profileAvailable: false`.

`directReplyCount` counts ordinary-visible direct children and supports nested
conversation controls. `conversationReplyCount` counts all ordinary-visible
resolved descendants in the conversation and supports the root-level
affordance. Neither field changes meaning by endpoint. Retained unavailable
evidence and neutral connective placeholders do not independently count.

The DTO contains exactly the ordinary classification needed by Web:
`origin` selects Local, `selectedAuthor` selects local-author or publisher,
`eligibleSourceIds` permits Personal reevaluation against active source
subscriptions, and `classification.federated` selects Federated. Public is the
ordinary-visible superset; parent fields reconstruct flat threads. No
administrator evidence, raw claims, conflicts, governance explanations,
credentials, secrets, unsafe URLs, or displaced delivery data appears.

Local-origin items always expose `eligibleSourceIds: []` and
`classification.federated: false`. Remote echo evidence cannot provide ordinary
support, Personal membership, or Federated classification for local origin.

Attribution level is item-specific, not publisher state. Fallback authors are
neutral, non-navigable, and normally expose no feed URL. Unknown or currently
unavailable single-item reads return the existing neutral ordinary `404`.
`LogicalSingleItemEnvelope.journalCursor` is captured from the same consistent
snapshot as `item`.

Core `GET /post/:id` is the deliberately new logical-v2 single-item JSON route.
When `sourceModelV2` is enabled, a currently ordinary-visible item returns
`200` with `LogicalSingleItemEnvelope`. An unknown or currently unavailable
item returns the existing neutral ordinary `404`.

This route is distinct from the existing surfaces:

- `GET /post/:id/thread` remains the bounded conversation route and returns
  `LogicalThreadEnvelope` in v2;
- `GET /posts/:id/revisions` remains the ordinary history route and returns
  `LogicalHistoryEnvelope` in v2.

When v2 is disabled, the new single-item representation is unavailable and the
current v1 route inventory and behavior remain unchanged. Web calls
`GET /post/:id` only after capability validation and verifies the returned
`model: 'logical-v2'` envelope before using it. A missing, malformed, or
mismatched envelope fails closed under Section 5.6 rather than being cast to a
v1 post.

### 3.5 Lenses

V2 timeline selectors are:

- none: Public;
- `origin=local`: Local;
- `followed_by=<local handle>`: Personal;
- `author=<local handle>`: local-account author;
- `publisher=<opaque stable ID>`: remote publisher;
- `federated=true`: Federated.

`before` and `limit` are pagination controls. Exactly zero or one lens selector
is accepted. Duplicate, empty, combined, unknown-value, legacy, or
branch-incompatible selectors return the same `400 {"error":"invalid lens"}`.
`federated=false`, `feed_type`, and `source=local` are invalid in v2. V1
explicitly rejects v2-only selectors. Unknown local accounts and non-public
publishers return neutral ordinary `404`.

```ts
type TimelineLens =
  | { kind: 'public' }
  | { kind: 'local' }
  | { kind: 'personal'; account: PublicLocalAccount }
  | { kind: 'local_author'; account: PublicLocalAccount }
  | { kind: 'publisher'; publisher: PublicPublisher }
  | { kind: 'federated' };
```

Every successful timeline response contains:

```ts
{
  model: 'logical-v2';
  lens: TimelineLens;
  timeline: LogicalItemDto[];
  nextCursor: string | null;
  journalCursor: string;
}
```

Personal includes the subject's local items, followed local accounts, and
remote items with at least one eligible delivery from an active subscribed
source. Pending and `pending_review` do not contribute. Membership comes from
the subscribed source; the strongest display may come from another transport.

Federated requires at least one eligible delivery from a currently approved
federation source. The selected display may come from another source. Local
items never enter Federated through remote echoes, and federation approval
alone never creates Personal membership.

Public, Local, Personal, Federated, and the following-management river are
conversation-entry views. They include:

- true roots whose `parentResolutionState` is `none`; and
- unresolved replies whose state is `missing` or `ambiguous`.

They exclude replies whose state is `resolved`. This predicate is applied with
visibility and lens membership before ordering, cursor evaluation, and
`LIMIT`; clients never filter a limited page after retrieval. An unresolved
reply remains discoverable with its ordinary-safe reply context because an
unavailable or ambiguous parent must not make otherwise valid content vanish.

The local-author and publisher lenses remain activity-oriented and include
ordinary-visible resolved replies. They answer what that author or publisher
posted rather than which conversation roots belong to a river. The lens
descriptor, not an endpoint-dependent count meaning, determines this
collection behavior.

### 3.6 Publisher pages and labels

Web adds `/p/:publisherId`; core reuses `/timeline?publisher=<stableId>`.
Publisher IDs are opaque and URL-encoded. `/u/:handle` remains local-account
only. No publisher follow or publisher feed is introduced; subscribing to the
safe external feed remains a source subscription.

A publisher page exists only for a feed-anchored publisher supported by
ordinary evidence. Unknown, administrator-only, source-scoped fallback, and
non-navigable publishers return the same ordinary `404`. The publisher lens
descriptor supplies ID, display name, safe canonical feed URL, and
`identityLevel: 'feed_anchored'` so an empty page still renders correctly.

Public publisher names are presentation evidence, never identity. Normalization
is versioned: Unicode NFC; remove C0/C1 and explicit bidi override/isolation
controls; trim and collapse Unicode whitespace; cap at 200 Unicode code points;
empty is invalid. Other format characters are retained to avoid damaging emoji.
Web HTML-escapes the result.

Only reconciled observations from currently ordinary-eligible sources
participate. The current asserting-source hint is retained when it remains
eligible, supplies a valid name, and remains at the strongest evidence level.
Otherwise order by evidence level descending, first valid assertion full
arrival tuple ascending, source ID, and claim ID. Within the selected source,
the latest valid full arrival tuple supplies the name. Invalid or omitted later
names do not erase a prior valid name.

Fallback is normalized ASCII hostname from the safe canonical feed URL, then
`Remote publisher`. Source-scoped fallback authors use the source hostname or
neutral fallback and remain non-navigable.

Acquisition stores raw evidence only. Reconciliation makes a name assertion
effective. A normalized public-label change and one reset commit atomically.
No reset is needed when the effective normalized label is unchanged. A source
policy transition's reset subsumes naming invalidation.

### 3.7 Policy transitions and resets

Governance, federation approval/revocation, and attribution-mode changes advance
source policy generation and append one reset. Pause/resume preserve Vertical
1 generation and audit behavior but append no reset because retained delivery
eligibility is unchanged.

Active source-subscription creation/removal/activation and local-account
follow/unfollow append a Personal-membership reset without independently
advancing source generation. Inactive-to-inactive subscription changes require
none. Local handle or display-name changes append one reset. A command producing
several effects commits only one. No-op transitions and command-ledger replay
change neither generation nor journal.

Vertical 2 performs no source-wide item fan-out. Reads are immediately correct
from current policy; Vertical 3 adds generation-qualified durable fan-out only
to converge materialized hints.

## 4. Threading, presentation history, and feeds

### 4.1 Authoritative ancestry

Logical ancestry stores one restrictive nullable `parentLogicalItemId` and:

```ts
type ParentResolutionState = 'none' | 'missing' | 'ambiguous' | 'resolved';
```

It also retains the initial selected delivery version's exact raw reference,
normalized reference, reference kind, identifier scope, and observation version
ID. Later conflicting references remain evidence and never automatically
reparent. Even stronger evidence requires a reviewed correction in a later
vertical. Remote delivery never changes local ancestry. Roots are derived and
never authoritative stored state.

Live v2 resolution uses only a uniquely owned canonical HTTP(S) permalink or an
exact opaque identifier within a defined source or publisher scope. Unscoped
opaque references are ambiguous; live ingestion has no global-uniqueness
fallback. Synthesized fallback identifiers never resolve across sources.
Vertical 4 may preserve already-resolved legacy edges without recreating this
fallback.

Self-parenting and cycles are conflicts. Parent deletion cannot cascade or
silently null edges: deletion must retain a structural marker or first prove no
child edge remains.

### 4.2 Local replies and late adoption

A local reply may target an ordinary-visible local or remote logical item. Its
local post, logical edge, metadata, and upsert commit atomically. Legacy reply
fields may remain compatibility data, but the logical parent is authority.
Terminal local-deletion markers are not valid new reply or adoption targets.

Only `missing` references may be adopted automatically. A new resolvable alias
atomically schedules durable orphan work with a stable candidate high-water
mark. Work examines that finite candidate set in bounded batches and rechecks
uniqueness, scope, cycle safety, and depth in every write transaction.

If multiple candidates, invalid scope, a cycle, or an unprovable/deep subtree
is found, the item atomically transitions `missing -> ambiguous` and records a
conflict. It cannot later adopt automatically after deletion or policy change.
Successful batches change only direct parent edges, append one reset, and mark
work complete only after all candidates through the captured high-water mark
have been examined.

Root depth is zero. No new edge may place an item more than 64 edges from its
root. Adoption requires:

```text
candidateParentDepth + 1 + orphanSubtreeMaximumDepth <= 64
```

The subtree proof itself has an explicit 500-node structural bound. A cycle,
bound overrun, or inability to prove the maximum makes the reference ambiguous.

### 4.3 Thread projection

Thread projection first walks upward from the requested item to its derived
root, then loads the bounded descendant graph before applying visibility. It
reserves the complete safe root-to-requested path, deduplicates it, and fills
the remaining 500-node budget breadth-first by depth and
`(timelineSortAt ASC, logicalItemId ASC)`. The path counts toward the total. A
501st sentinel establishes node truncation without returning it.

If no root is safely reached, the response retains the bounded ancestor path,
sets `rootId: null`, and invents no partial root. Recursive reads enforce depth,
node, and cycle bounds themselves.

```ts
type LogicalThreadEnvelope = {
  model: 'logical-v2';
  requestedLogicalItemId: string;
  rootId: string | null;
  nodes: Array<
    | { kind: 'item'; item: LogicalItemDto }
    | {
        kind: 'placeholder';
        logicalItemId: string;
        parentLogicalItemId: string | null;
        timelineSortAt: string;
        placeholderKind: 'unavailable';
      }
  >;
  truncated: {
    depth: boolean;
    nodes: boolean;
    cycle: boolean;
  };
  journalCursor: string;
};
```

Exactly depth 64 or 500 returned nodes is not alone truncation. Structural
bounds apply before policy projection. Projection then prunes branches with no
ordinary-visible node and replaces unavailable connective nodes with neutral
placeholders. A placeholder exposes only logical ID, parent ID, immutable sort
key, and neutral kind—no deletion reason, author, source, content, or action.

An unavailable requested item returns a thread only when its placeholder is
required to connect ordinary-visible descendants. An unavailable leaf returns
ordinary `404` even when it has visible ancestors. If projection leaves no
ordinary-visible item, return `404`. `journalCursor` comes from the same
snapshot as graph loading and projection.

### 4.4 Accepted presentation chains

Every delivery owns an independent accepted presentation chain. Its canonical
presentation fingerprint contains only ordinary rendering material: title,
content, Markdown, ordinary-safe permalink/source link, enclosure metadata and
order, and displayed reply-context fields. It excludes attribution, ancestry,
publication/update claims, parser diagnostics, and acquisition metadata.

Only versions whose own jobs ended `reconciled` or `conflicted`, plus the
version in the current transaction, can participate. Pending, retrying, and
failed versions cannot become ordinary through another job's recomputation.
Chains are processed in durable first-arrival order.

The baseline is presentation sequence zero with no ordinary `updatedAt`. A
baseline explicit update claim initializes the watermark only when it is valid
normalized UTC and no later than durable arrival. Invalid, malformed, or future
claims remain raw evidence and do not initialize it.

For each later distinct version:

- unchanged presentation material creates no entry or watermark change;
- changed material with a valid explicit timestamp no later than arrival and
  strictly above the watermark is accepted with `explicit` provenance and
  advances the watermark;
- an older or equal explicit timestamp is retained as rollback/conflict
  evidence and is not accepted;
- changed material with absent, malformed, or future timestamp is accepted at
  durable arrival with `arrival` provenance and leaves the explicit watermark;
- marker-only changes create no presentation entry or post-baseline watermark
  change.

Each entry stores presentation sequence, observation version ID, effective
update time, `explicit | arrival` provenance, and material fingerprint.
Switching display delivery is an upsert, not an edit; its baseline may have
`updatedAt: null`.

### 4.5 History envelope

The logical-v2 revisions route returns policy-projected semantic content:

```ts
type LogicalHistoryEnvelope = {
  model: 'logical-v2';
  logicalItemId: string;
  origin: 'local' | 'remote';
  entries: Array<{
    sequence: number;
    title: string | null;
    content: string | null;
    markdown: string | null;
    permalink: string | null;
    enclosures: EnclosureDto[];
    updatedAt: string | null;
    updatedAtProvenance: 'explicit' | 'arrival' | null;
    current: boolean;
  }>;
  currentSequence: number;
  journalCursor: string;
};
```

Local history derives from authoritative local revisions. Remote history shows
only the accepted chain of the current effective display delivery, ordered by
presentation sequence. Reselection changes the visible chain. Unavailable
items return `404`; displaced deliveries, rollback versions, raw claims, and
conflicts remain administrator-only.

Core returns semantic material, never rendered HTML. Web renders every version
through the existing shared sanitizer path.

### 4.6 Feed mappings

All public feeds use the central projector and exclude unsupported evidence.
Existing URLs remain stable:

- the all-users firehose uses `origin=local` without the river root-only
  predicate and continues transporting local replies;
- local-account feeds use the activity-oriented local-author lens and continue
  transporting replies;
- `/post/:id/comments.xml` uses the bounded thread projector for policy and
  safety but serializes ordinary-visible direct replies only;
- nested replies continue through their own comments-feed links;
- Vertical 2 creates no publisher feed;
- feeds never serialize placeholders.

## 5. Journal, SSE, and route cutover

### 5.1 Durable journal

Each journal record contains monotonic internal sequence, `upsert | remove |
reset`, nullable logical-item ID, bounded change mask, and creation time. It
stores no DTO, content, arbitrary JSON, governance explanation, or
administrator evidence. Domain mutation and journal effect commit in the same
transaction; live notification occurs after commit and contains sequence hints
only.

The journal retains the newest 10,000 records. Metadata stores persistent epoch,
high-water sequence, and `replayFloorSeq`, the greatest pruned sequence. Within
an epoch sequences strictly increase and are never reused. Rows above the floor
remain available; a cursor equal to the floor is replayable, below it is not.
Pruning and floor advancement are atomic and do not append reset or change
epoch. Explicit reconstruction changes epoch and creates its initial reset
atomically. Ordinary policy barriers append reset without changing epoch.

### 5.2 Snapshot and replay cursors

An opaque journal cursor encodes model, cursor version, epoch, and sequence.
Clients never parse the numeric sequence. Journal cursors are distinct from
pagination cursors.

Every hydrated ordinary JSON view—including timeline, publisher, single item,
thread, and history—includes a journal cursor captured in the same consistent
snapshot as its content. After reset, Web refetches SSR and reconnects from that
cursor.

Malformed, empty, v1, unsupported-version, wrong-epoch, future, or below-floor
cursors are invalid for v2.

### 5.3 SSE transport and reset

Web initially opens `/stream?last=<snapshot journalCursor>` and forwards the
value as Core's `Last-Event-ID`. On browser automatic reconnect, the browser's
`Last-Event-ID` header takes precedence. Core accepts the opaque cursor only
through that header. Missing or empty is invalid and resets; Core never silently
starts at current high water.

SSE `id:` is the encoded epoch-qualified cursor, not numeric sequence.

```ts
type LogicalV2StreamEvent =
  | { model: 'logical-v2'; kind: 'upsert'; logicalItemId: string;
      item: LogicalItemDto }
  | { model: 'logical-v2'; kind: 'remove'; logicalItemId: string }
  | { model: 'logical-v2'; kind: 'reset' };
```

A stored reset uses that row's encoded cursor. A synthesized recovery reset has
no invented ID. A stored reset, invalid/expired cursor, unreconstructable event,
or mid-stream retention overrun emits exactly one reset, stops replay, and
closes the connection. The client closes its EventSource, refetches SSR, and
creates a new connection. It never applies later events from that attempt.

### 5.4 Ordered streaming

The stream registers a listener before replay and maintains a bounded,
coalesced highest-sequence hint. It reads floor, high water, and replay rows in
one snapshot, replays ascending, and queries committed rows after the last sent
sequence. Before every batch it rechecks the replay floor; falling below it
resets and closes. Heartbeats are SSE comments and also trigger database
catch-up.

The in-memory bus is never event-content authority. A historical upsert is
projected under current policy: current visible item becomes current upsert,
unavailable becomes remove, and unsafe reconstruction becomes reset. Stored
remove remains remove. Placeholders are never streamed as timeline entries;
conversation clients refetch their thread.

### 5.5 Durable reply-count invalidation

Logical-v2 does not adopt v1's transient `rootReplyCount` SSE enrichment. Reply
counts are ordinary projection fields derived from current logical ancestry and
visibility. Their live correctness comes from durable journal effects.

A bounded mutation affecting a resolved reply appends deduplicated durable
journal effects for every affected ordinary projection:

- the reply's own required `upsert` or `remove`;
- an `upsert` for its immediate logical parent because that parent's
  `directReplyCount` changed;
- an `upsert` for the derived conversation root because its
  `conversationReplyCount` changed.

If parent and root are the same logical item, only one upsert is appended for
that ID. All effects commit atomically with the domain mutation. Send-time
projection supplies authoritative counts and may convert an unavailable target
to an effective remove. Clients never increment or decrement optimistically;
replay and duplicate delivery are idempotent.

This rule applies to bounded resolved-reply creation, terminal deletion, and
bounded ordinary visibility gain or loss. A content-only reply edit that
changes neither ancestry nor ordinary visibility emits no parent/root count
invalidation.

Section 4.2's reset remains authoritative for orphan-adoption batches. A
`missing -> resolved` adoption can move a subtree, alter river membership, and
change several counts, so it does not append the ordinary parent/root upsert
set. Existing source-policy, account-deletion, and other reset-producing
transactions likewise use their single reset without redundant count upserts.

If every affected parent and root cannot be identified safely within the
bounded transaction, append one reset rather than partial upserts.

### 5.6 Capability and cutover

```ts
type Capabilities =
  | { sourceModelV2: false }
  | {
      sourceModelV2: true;
      model: 'logical-v2';
      journalCursorVersion: number;
      streamProtocolVersion: number;
    };
```

`sourceModelV2` is startup-immutable. Capability reports v2 only after schema,
projector, journal, activation reconciliation, scheduler, reconciliation
worker, and orphan-resolution worker are ready. Configured-v2 initialization
failure fails startup/readiness rather than serving v1.

Existing ordinary route paths remain stable and branch internally;
`GET /post/:id` is the deliberate new v2-only single-item route defined in
Section 3.4. Every v2 JSON envelope identifies `model: 'logical-v2'`; Web
validates each envelope and stream event instead of trusting capability alone.
Capability failure, representation mismatch, or malformed event fails closed:
discard, close, revalidate capability and SSR, and never fall back or cast to
v1.

Core returns semantic content. Web enriches only upserts through the existing
server renderer and sanitizer and passes remove/reset unchanged. Current policy
is applied in Core before streaming; client lens filtering is never the
visibility boundary.

### 5.7 Client reconciliation

Upsert reevaluates the active lens, removes an item that no longer belongs, or
inserts/replaces it at immutable timeline order. Remove deletes from timeline
and river surfaces; conversation views refetch to obtain pruning or placeholder
state. Reset discards event-derived assumptions, refetches SSR, and reconnects
from its snapshot cursor.

For river lenses, a resolved-reply upsert never inserts that reply as a card.
The durable parent and root upserts replace authoritative direct and
conversation counts when those items are loaded. Author and publisher activity
lenses may insert the reply itself according to immutable timeline order. An
off-page parent or root is not materialized merely because one of its replies
arrived.

Administrative retained content requires both authenticated administrator and
an explicitly administrative route. Ordinary routes never reveal hidden or
retained evidence merely because the viewer is an administrator.

## 6. Administrative acquisition operations

### 6.1 Scope

Vertical 2 exposes administrator refresh, run status, source run history,
bounded reconciliation-job summaries, and source acquisition health. It stores
but does not expose complete delivery, redirect, finding, claim, conflict,
version, or presentation collections; raw evidence, previews, review actions,
and their Web UI belong to Vertical 3.

All v2 administrative envelopes include `model: 'logical-v2'`. Routes require
a verified administrator; operator tokens cannot access them.

### 6.2 Refresh and command ledger

```http
POST /admin/sources/:sourceId/refresh
Idempotency-Key: <command-id>
{}
```

The route accepts only stable source ID. A valid command against paused,
blocked, removed, tombstoned, or unknown source is ledgered and returns exactly:

```http
404
{"model":"logical-v2","error":"source unavailable"}
```

Replay returns that refusal even after source state changes. A reused command ID
with mismatched fingerprint returns:

```http
409
{"model":"logical-v2","error":"idempotency conflict"}
```

The ledger stores actor/scope, command ID, request fingerprint, stable refusal
or run association, and initial `created | joined` relationship. It does not
freeze mutable run counters. Matching replay returns the same run with
`disposition: 'replayed'` and current status.

```ts
type AdminRunProjection = {
  model: 'logical-v2';
  runId: string;
  sourceId: string;
  status: 'terminal' | 'processing';
  statusLocation: string;
  fetch: AdminFetchProjection;
  acquisition: AdminAcquisitionCounters;
  reconciliation: AdminReconciliationCounters;
};

type AdminRefreshResult = AdminRunProjection & {
  disposition: 'created' | 'joined' | 'replayed';
};

type AdminAcquisitionRun = AdminRunProjection & {
  reason: 'scheduled' | 'administrator_refresh';
  startedAt: string;
  acquisitionCommittedAt: string | null;
  completedAt: string | null;
  versions: AdminAcquisitionVersions;
};

type AdminFetchProjection = {
  outcome:
    | 'pending'
    | 'not_modified'
    | 'parsed'
    | 'completed_truncated'
    | 'redirect_conflict'
    | 'operational_failure'
    | 'cancelled'
    | 'superseded'
    | 'policy_rejected';
  effectiveUrl: string | null;
  httpStatus: number | null;
  failureCategory:
    | 'network'
    | 'timeout'
    | 'http'
    | 'body_limit'
    | 'feed_parse'
    | 'policy'
    | 'superseded'
    | null;
  diagnostic: string | null;
};

type AdminAcquisitionCounters = {
  candidates: number;
  seen: number;
  observed: number;
  unchanged: number;
  skipped: number;
  omitted: number;
  itemsTruncated: boolean;
  bodyLimitExceeded: boolean;
  notModified: boolean;
};

type AdminReconciliationCounters = {
  reconciled: number;
  conflicted: number;
  pending: number;
  processing: number;
  retrying: number;
  failed: number;
  failedByCategory: {
    operationalExhausted: number;
    invariantOrDataFailure: number;
  };
};

type AdminAcquisitionVersions = {
  parserAdapter: string | null;
  parserVersion: string | null;
  boundsProfileVersion: string;
  identifierNormalizationVersion: string;
  fingerprintVersion: string;
};
```

Fetch outcome distinguishes pending, not modified, parsed, completed truncated,
redirect conflict, operational failure, cancelled, superseded, and policy
rejected. Acquisition failure category and redacted diagnostic live under
`fetch`. Reconciliation failure categories belong to jobs and appear in the run
only as bounded counts.

`200` means terminal, not successful. After a successful acquisition result
that created jobs, refresh waits five seconds for terminal status; otherwise it
returns `202` with stable `Location`. A successful zero-job commit—`304`, all
unchanged/skipped, redirect conflict, or another zero-job result—is immediately
terminal. `acquisitionCommittedAt` is its commit time. It is null for precommit
operational failure, cancellation, supersession, or policy rejection.

### 6.3 Operational reads

Vertical 2 exposes:

```text
GET /admin/acquisition-runs/:runId
GET /admin/sources/:sourceId/runs
GET /admin/acquisition-runs/:runId/jobs
```

Pages include model, items, and opaque next cursor. Source runs order by
`(startedAt DESC, runId DESC)`; jobs by `(createdAt ASC, jobId ASC)`. Default
limit is 50 and maximum 100. Cursors encode route version and exact immutable
tuple; mutable status, retry, and lease fields never order pagination. Invalid
cursors return `400 {"model":"logical-v2","error":"invalid cursor"}`.

Job summaries expose status, attempts, next attempt, lease expiry, stable
failure category, and redacted diagnostic, but never fence. Waiting for an
earlier version is pending and consumes no attempt. Vertical 2 cannot reopen a
terminal run or retry a terminal job.

```ts
type AdminReconciliationJobSummary = {
  jobId: string;
  createdAt: string;
  status:
    | 'pending'
    | 'processing'
    | 'retrying'
    | 'reconciled'
    | 'conflicted'
    | 'failed';
  attempts: number;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  failureCategory:
    | 'operational_exhausted'
    | 'invariant_or_data_failure'
    | null;
  diagnostic: string | null;
};
```

Source detail adds scheduling reasons, current acquisition claim, durable
health, latest run, inert observed capability summary, retained evidence counts
without links, and:

```ts
nonterminalRuns: {
  count: number;
  oldestRunId: string | null;
  oldestStartedAt: string | null;
};
```

`activeAcquisition` describes only an unexpired fenced fetch/acquisition claim,
not older reconciliation work.

```ts
type AdminSourceAcquisitionSummary = {
  model: 'logical-v2';
  schedulable: boolean;
  schedulingReasons: {
    activeSubscription: boolean;
    federation: 'none' | 'pending' | 'approved';
  };
  activeAcquisition: {
    runId: string;
    claimedAt: string;
    leaseExpiresAt: string;
  } | null;
  health: {
    nextPollAt: string | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
  };
  lastRun: {
    runId: string;
    outcome: AdminFetchProjection['outcome'];
    status: 'terminal' | 'processing';
    completedAt: string | null;
  } | null;
  nonterminalRuns: {
    count: number;
    oldestRunId: string | null;
    oldestStartedAt: string | null;
  };
  observedCapabilities: {
    websub: boolean;
    rssCloud: boolean;
  };
  retainedCounts: {
    deliveries: number;
    conflicts: number;
    findings: number;
  };
};
```

The Web source page adds refresh, health, current/latest run, nonterminal count,
run history, and job summaries. Its no-JS form uses a server-generated command
ID retained across ambiguous retry. It provides no evidence-review navigation
and never describes parsing or terminal completion as trust or federation.

## 7. Rollout, recovery, and acceptance

### 7.1 Additive schema and durable activation

Vertical 2 adds transactional schema for publishers and names; logical items,
local bridges, and deleted-local markers; delivery identities, versions, and
presentation chains; claims, conflicts, keys, parent edges, and orphan work;
runs, command associations, fenced claims, health, and validators; jobs; source
redirect evidence and aliases; and journal metadata/records. It does not bulk
convert legacy remote content. Final migration remains Vertical 4.

Activation metadata is independent of journal identity:

```ts
type SourceModelV2Activation = {
  schemaVersion: 1;
  state: 'never_activated' | 'active' | 'reconciliation_required';
  lastActivatedAt: string | null;
  lastReconciledAt: string | null;
};
```

A disabled process, before accepting traffic, marks
`reconciliation_required` when v2 was previously active. A configured-v2
process evaluates the marker before listening or starting workers.

For first activation or reactivation, the local-state read, reconciliation
effects, journal initialization if needed, one reset, timestamps, and transition
to `active` all occur inside one pre-listen SQLite write transaction. No
supported application mutation can intervene. First activation creates epoch
and first reset in that transaction. Reactivation preserves epoch and appends
one reset.

A continuous-v2 restart seeing `active` preserves epoch and activation
timestamps and appends no reset. Failure leaves state non-active and fails
startup/readiness.

Required readiness components are schema, projector, journal, scheduler,
reconciliation worker, orphan-resolution worker, and completed activation
barrier.

### 7.2 Crash boundaries

Acquisition has two transactions. Before network access, the claim transaction
commits run creation/reuse, active claim, higher fence, command association, and
initial state. A crash may legitimately leave that visible; expiry recovers the
same run with a higher fence.

The result transaction verifies current fence/policy/reason and atomically
commits aliases, redirect evidence, validators, observations, jobs, counters,
outcome, scheduler state, and claim release. Fenced operational-failure
bookkeeping atomically commits run outcome, claim release, scheduler health,
and backoff. Lost fence commits none.

Reconciliation domain effects, job terminal/retry state, run counters, and
journal effects commit atomically. After rollback, only the separate fenced
failure-bookkeeping transaction may commit.

Fault injection also covers local create/edit/reply/delete and account deletion;
orphan adoption; source, subscription, federation, follow, and profile reset
transitions; publisher-label changes; journal initialization, reconstruction,
and pruning; and refresh association/ledger replay. Each multi-table mutation
commits domain, audit/ledger, and journal effects together or none.

### 7.3 Required acceptance coverage

The implementation plan must preserve the detailed contracts above and include:

- source-state acquisition matrix and scheduler/backoff/restart tests;
- network deadline, streaming body limit, SSRF, redirects, alias collision, and
  effective-URL validator tests;
- every item/evidence bound and adapter wire-order boundary;
- observation deduplication, collision, seen metadata, and multi-version tests;
- acquisition/reconciliation fencing, crash, ordering, retry, and concurrent
  convergence tests;
- local bridge, terminal deletion, ancestry, orphan adoption, depth-64,
  node-500, truncation, placeholder, and unavailable-leaf tests;
- evidence-level delivery/author ranking, current strongest-level stability,
  full arrival/lexical ties, and deterministic reselection tests;
- publisher naming rank, source stability, rename, hostname fallback,
  normalization/bound, and exact reset tests;
- Public, Local, Personal, local-author, publisher, and Federated semantics,
  including any eligible approved support and local-echo exclusion;
- root/unresolved-only filtering before pagination for Public, Local, Personal,
  Federated, and following management, while author and publisher activity
  lenses retain replies;
- stable `directReplyCount` and `conversationReplyCount` semantics across
  endpoints, with ordinary visibility applied before counting;
- atomic deduplicated reply, parent, and root journal effects for bounded
  reply-count changes, with reset barriers for adoption and unsafe or unbounded
  invalidation and no transient v1 count metadata;
- `GET /post/:id` enabled-v2 success and neutral `404`, disabled-v2 isolation,
  snapshot-consistent single-item `journalCursor`, and Web fail-closed handling
  for malformed or mismatched envelopes;
- presentation watermark, rollback, arrival fallback, job-order, history, and
  direct-comments-feed tests;
- journal atomicity, epoch/floor/pruning, opaque cursor, reset-close,
  listener-before-replay, retention overrun, heartbeat catch-up, and malformed
  event tests;
- administrator authorization, ledgered refusal, idempotency, disposition,
  zero-job completion, counters, pagination, redaction, and nonterminal-run
  tests.

Every ordinary projector test uses deliberately stale materialized selection
hints. Reads, reconciliation, feeds, history, and SSE must choose identically.

### 7.4 Cross-model isolation

With v2 disabled, v2 tables influence no reads, feeds, polling, push, DTOs, or
SSE; no v2 worker starts. Legacy behavior remains unchanged.

With v2 enabled, legacy remote posts are not dual-read, legacy polling is not
started, inbound push is not installed or routed, and v1 selectors, DTOs, and
cursors are never interpreted as v2. Every ordinary route and public feed uses
its v2 branch. Capability remains unavailable until activation commits.

Logical-v2 journal and SSE never treat the legacy bus or v1 remote-post events
as authoritative input. V2 local mutations append their journal records
atomically. Their after-commit notifications may still drive journal wake-up
hints and outbound push for local feeds.

### 7.5 Completion gate

Vertical 2 is complete only when:

- Core tests pass;
- Core `tsc --noEmit` passes;
- Web tests pass;
- `svelte-check` passes;
- the Web production build passes;
- committed-diff whitespace validation passes;
- disabled-v2 regression and enabled-v2 cross-model isolation tests pass;
- activation, crash, fencing, policy-race, deterministic projection, replay,
  and credential-redaction suites pass.

Passing this gate does not authorize enabling v2 by default, deleting v1,
migrating legacy remote items, or beginning Vertical 3 functionality.

## Result

Vertical 2 supplies one crash-safe remote acquisition and logical projection
path behind a disabled-by-default switch. It unifies local and remote identity,
threads, chronology, pages, feeds, and SSE without duplicating local content or
manufacturing trust. Current policy—not stale pointers, stored stream payloads,
or client filtering—remains the visibility authority. The next step after this
spec's repository review is a genuinely end-to-end vertical implementation
plan; no plan or implementation begins from this draft alone.
