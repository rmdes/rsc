# RSC source governance and durable remote moderation — design

**Date:** 2026-07-20
**Status:** Approved foundation design; ready for repository review
**Revision:** 2 — incorporates post-commit review of selection, structural
thread retention, subscription transitions, local-feed resolution, and
implementation sequencing.
**Scope:** Architectural foundation only. Implementation will be divided into vertical plans after review.

## Purpose

RSC currently uses one remote `users` row as an author, feed-fetching endpoint,
subscription target, and federation classification. That model cannot represent
an aggregate feed carrying many publishers, cannot distinguish federation trust
from detected feed capabilities, and cannot durably moderate a remote item
without deleting it and allowing the next poll to recreate it.

This design replaces that overload with first-class sources, publishers,
federation relationships, subscriptions, logical items, delivery evidence, and
moderation. It preserves RSC's RSS/Atom/JSON Feed and h-feed ingestion,
Textcasting threading, WebSub/rssCloud, SSRF, live-edit, SSE, sanitizer, and
no-JS invariants.

## 1. Entity boundaries

### Local account

An authentication-backed RSC participant. A local account is the selected
author of its local logical items and may follow local accounts or create source
subscriptions.

### Remote source

A transport endpoint RSC may fetch from or receive delivery through. It owns a
canonical feed URL, explicit attribution mode, discovered capabilities,
operational health, and push configuration. Poll scheduling and push
registration arise from subscriptions, federation relationships, or bounded
verification work; creating a source alone schedules nothing.

A source has three independent axes:

- operation: `enabled | paused`;
- governance: `allowed | quarantined | blocked`;
- federation: `none | pending | approved`, where `none` may be represented by
  no federation-relationship record.

Its attribution mode is `single_publisher | aggregate`. The creation path
establishes it explicitly. Feed metadata cannot change it; later change requires
an authorized action.

### Remote publisher

A neutral remote account, person, group, publisher, or publication identity,
provisionally anchored by a canonical feed URL. A publisher never owns polling
or push state. Source and publisher remain distinct even for a direct
one-source/one-publisher feed.

### Federation relationship

An explicit administrator-established interoperability relationship with a
source, including status and provenance. `source:markdown`, Textcasting
elements, WebSub, rssCloud, format, and URL shape are capabilities or
observations, never federation authority.

### Subscription

A local account's decision to follow a concrete remote source. Remote URL
subscription and OPML create source subscriptions, never publisher-wide
follows. A canonical feed URL belonging to this RSC instance instead creates
the separate local-account follow relation. Publisher-wide following is
reserved for a future explicit feature and will require a stable bound or
verified publisher.

### Logical item

The local content object used by timelines, conversations, moderation, and
stable local permalinks. Every item has exactly one selected author: a local
account for local items or a remote publisher for remote items. A remote item
also has a selected or preferred delivery used to derive its presentation.

### Delivery observation and version

One source's delivery of an item. It retains transport, exact wire identifiers,
raw and normalized permalink, raw attribution, delivered content, remote and
arrival timestamps, delivery mechanism, and evidence. Material changes under
the same source-local identity create retained delivery versions.

### Attribution claim

A provenance-bearing assertion that a delivery through source X attributed an
item to publisher Y. Confidence and conflicts live here, independently of
publisher identity, source governance, and federation approval.

### Moderation and audit

Logical items have one reversible remote-item state, `hidden`. Source and item
actions create immutable audit records with action, actor, timestamp, required
category where applicable, and optional note.

### Block tombstone

A minimal record preserved after purge. It prevents silent source recreation
and retains the canonical URL, necessary blocking aliases, and terminal block
and purge audit facts.

## 2. Load-bearing invariants

1. Source, publisher, and federation trust are separate concepts.
2. Publisher names are observations, never identity keys.
3. Every logical item always has one selected author. Conflicts never leave
   presentation authorship undefined. Remote selection remains stable unless
   stronger eligible evidence wins.
4. Threads reference logical items, not deliveries. Established ancestry is
   resolve-once.
5. Logical-item moderation applies across every delivery, edit, verification,
   and redelivery.
6. Source governance controls delivery eligibility. Source operation controls
   whether new network deliveries may be acquired.
7. A remote item is ordinarily visible when it is not hidden and has at least
   one retained delivery from an `allowed` source. The effective display
   delivery must be eligible.
8. If a persisted selection is ineligible, reads deterministically derive the
   strongest eligible delivery from current state. A durable fan-out later
   persists that selection. If none exists, the item is absent ordinarily but
   remains administrator-visible.
9. Quarantining one source does not hide an item independently supported by
   another allowed source.
10. Local origin wins. Remote delivery convergence cannot change a local item's
    author, content authority, ancestry, support, or Local/Public classification,
    and cannot place it in Federated.
11. Permalink convergence attaches evidence to a candidate logical item. It
    grants no authority to replace selected content, author, or ancestry.
12. Federation approval of a transport never verifies its third-party claims.

### Deterministic author and delivery selection

"Strongest eligible" uses one shared comparator in reconciliation, policy
reads, fan-out, and event projection. Remote evidence strength, strongest
first, is:

1. verified containment from the publisher's eligible direct-origin source;
2. an eligible delivery and bound-publisher claim from a direct
   `single_publisher` source;
3. an eligible aggregate delivery with a valid publisher-URL assertion;
4. an eligible source-scoped unattributed fallback.

For display delivery, choose the highest available evidence level. Keep the
current selected delivery when it remains eligible at that same highest level;
otherwise choose the earliest first-seen delivery at that level, then lexical
delivery ID as the final stable tie-breaker. The selected version within that
delivery follows the remote-update rules in Section 6.

Selected-author claims use the equivalent ordering. Keep the current publisher
when its claim remains at the strongest available level; otherwise choose the
earliest first-seen claim at that level, then lexical claim ID. Local origin is
outside this remote comparator and always wins for local items. If no eligible
delivery exists, the item has no ordinary display representation, while its
retained remote selected author remains stable for administrator inspection.

## 3. URL and identifier rules

URL canonicalization is deliberately narrow:

- normalize scheme and host and remove default ports;
- remove fragments;
- preserve path, query, trailing slash, and HTTP versus HTTPS.

A source or publisher identifier must use HTTP(S), contain no credentials, fit
the configured identifier-length bound, and parse successfully. Invalid raw
values may be retained only as bounded or explicitly truncated administrator
evidence. They cannot become identifiers, links, aliases, or verification
targets.

RSS GUIDs, Atom IDs, and JSON Feed IDs are opaque exact identifiers and are
never URL-normalized. When feed semantics independently establish that an ID
also qualifies as a permalink, RSC stores the unchanged ID and a separate
validated, normalized permalink.

Transport redirects may create source aliases only after a safely fetched,
successfully parsed feed response. Every hop passes SSRF checks and governance
resolution against blocked sources, aliases, and tombstones. Alias collision
cannot merge sources or change their axes; it becomes a conflict. Only verified
direct-origin publisher redirects may establish publisher-feed aliases. An
aggregate redirect cannot merge publishers.

## 4. Source creation, subscriptions, and retention

### Transactional find-or-resolve

All creation paths first recognize canonical feed URLs belonging to this RSC
instance. Such a URL creates or reuses the separate local-account follow and
never creates a remote source shadow. URL subscription and OPML use the same
local resolution rule.

All other valid URLs transactionally resolve the normalized canonical URL and
known aliases. A retained non-blocked source is reused without changing its
mode or axes. Blocked sources and tombstones return a generic unavailable
result. Concurrent creators converge without overwriting policy.

New defaults are:

- user URL or OPML: `single_publisher + enabled + allowed + federation none`;
- explicit admin federation creation: administrator-chosen mode,
  `enabled + allowed + approved`;
- ambiguous migrated instance: `aggregate + enabled + quarantined + pending`;
- origin verification: `single_publisher + enabled + federation none`, with
  governance inherited from the asserting source.

Existing publisher sources retain their axes. Blocked/tombstoned publisher
URLs cannot be verified.

### User subscription boundary

Only a `single_publisher` source without a federation relationship accepts a
new user source subscription. An existing aggregate or federation source
returns a neutral not-subscribable result. Existing subscriptions survive if a
source later gains federation status while remaining single-publisher.

An allowed source creates an active subscription. A quarantined source creates
a pending subscription, counts it toward the cap, exposes no content, allows
normal unsubscribe, and returns only:

```json
{"subscription":"pending","message":"This source is awaiting review."}
```

The response does not reveal why the source is quarantined. Blocked and
tombstoned sources create nothing and remain generically unavailable.

Public following, counts, and OPML expose active subscriptions only.
Owner-authenticated management/export may include active and pending URLs with
neutral status. Administrator surfaces may show full governance context.

An ordinary `pending` subscription becomes active automatically when its
source becomes allowed, provided the source remains `single_publisher`.
`pending_review` never activates automatically. Quarantined or blocked source
subscriptions are excluded from Personal, public following/counts, and public
OPML regardless of retained user intent.

Personal membership is determined by an eligible delivery from a source the
viewer subscribed to. Presentation still uses the logical item's strongest
eligible representation, possibly from another transport.

Changing `single_publisher` to `aggregate` atomically moves every active and
ordinary pending user subscription to `pending_review`, records audit, and
appends a reset event. They require explicit reviewed activation or may be
removed normally. This prevents later allow from silently expanding Personal.
Federation approval alone does not deactivate existing subscriptions while
mode remains `single_publisher`.

Cap checking and subscription insertion happen in one serialized write
transaction. Migrated over-cap users are grandfathered but cannot add another
subscription until below the cap.

### Last-subscription cleanup

An allowed self-service source with no subscription, federation relationship,
verification-evidence role, or administrative retention reason is removed
without a tombstone. Shared logical items survive and reselect; unsupported
remote items are deleted. When a surviving descendant references such an item,
replace it with the content-free structural tombstone defined in Section 8 so
the thread edge remains reconstructable. Local items always survive.
Unreferenced publishers are deleted. Quarantined and blocked sources remain
administrator-retained.

## 5. Source lifecycle

### Paused operation

Pause is operational only. It stops scheduled polling, manual refresh,
verification fetches through the source, and new or renewed WebSub/rssCloud
subscriptions. Existing deliveries remain eligible when governance is
`allowed`; subscriptions and federation relationships remain intact; approved
items remain Federated.

Known WebSub fat pings are authenticated, acknowledged, and discarded without
parsing or storage. rssCloud thin pings return normally without fetching.
Valid known in-flight WebSub challenges complete to avoid retries and oracles,
but cause no subsequent acquisition. Best-effort unsubscribe may defer to lease
expiry. Resume performs a paced catch-up poll and then restores discovery and
push registration.

Pause/resume record actor, action, optional note, and timestamp; no moderation
category is required.

### Quarantine

Quarantine makes that source's deliveries ordinary-ineligible immediately but
does not change operation. When enabled, acquisition continues and new
deliveries remain administrator-only. Other allowed deliveries can keep a
shared item visible. Quarantine retains all evidence and does not alter
federation status.

### Block

Block makes deliveries ineligible and stops all acquisition regardless of
operation. Residual push traffic follows authenticated acknowledge-and-discard
behavior. The source, items, deliveries, claims, subscriptions, federation
provenance, conflicts, and history remain inspectable and administratively
actionable.

The only source-governance exits are explicit unblock or purge. Inspection,
item moderation, and federation rejection/revocation remain permitted. Unblock
returns a retained source to quarantine, not direct visibility.

### Federation transitions

- `pending -> approved` requires a non-blocked source; a quarantined candidate
  becomes allowed.
- A blocked pending candidate must be unblocked first.
- `pending -> none` rejects candidacy without blocking or changing subscriptions.
- `approved -> none` revokes interoperability without changing governance or
  subscriptions and immediately removes that source's Federated justification.
- Rejection/revocation may occur while blocked.

All are audited. Federated membership requires an eligible delivery from an
approved source, even if the displayed delivery comes from stronger eligible
evidence elsewhere.

### Audit categories

Hide, restore, quarantine, allow, federation approval/rejection/revocation,
block, unblock, and purge require a category. Initial categories are:

`spam`, `abuse`, `illegal_content`, `compromised_source`, `migration_review`,
`operator_policy`, `false_positive`, `remediated`, and `other`.

Actors may be administrators or the system. The system actor is limited to
specified migration and automated transitions.

## 6. Ingestion and reconciliation

Ingestion orders work as follows:

1. parse a bounded feed response into bounded item observations;
2. transactionally persist each raw delivery and a durable reconciliation job;
3. resolve or create the provisional publisher;
4. converge on or create the logical item;
5. attach claims and conflicts;
6. select author and preferred/display delivery;
7. resolve initial ancestry;
8. apply visibility and classification;
9. append journal effects atomically;
10. publish live only after commit.

A crash after parsing but before persistence loses no committed evidence. A
crash after delivery insertion cannot lose reconciliation work. Successful
reconciliation atomically commits logical relationships, claims, conflicts,
selections, and journal records. No partial ordinary item is visible.

### Source-local identity and versions

Identity priority is exact explicit opaque wire ID, otherwise normalized
permalink, otherwise deterministic synthesized fallback. Fallback identity is
source-local only. Since the current fallback hashes title, content, and date,
changing one produces a new identity and potentially a new logical item, not a
version. This conservative limitation follows the ban on heuristic matching.

Changed material under the same source-local identity creates a retained
version. A selected eligible delivery may update from its own newer version.
Explicit update timestamps must increase monotonically; older/equal values are
evidence but cannot roll presentation backward. Changed content without an
update marker is accepted as an arrival-timestamped version, preserving current
behavior. Another transport's copy is not an edit.

### Publisher resolution

For `single_publisher`, the bound publisher is selected; different item-level
attribution is a conflicting claim. For `aggregate`, a valid `<source url>`
resolves a provisional publisher; missing/invalid attribution uses a
source-scoped unattributed publisher. Names never deduplicate identities.

### Logical-item convergence

Automatic convergence uses only:

1. exact normalized permalink; otherwise
2. the same resolved publisher plus the same exact explicit opaque ID.

Multiple candidates are ambiguous and remain separate. Synthesized IDs do not
converge across sources. Names, titles, times, bodies, similarity, and reply
position never merge items.

### Resolve-once ancestry

A new logical item resolves its parent from its initially selected delivery.
Later conflicting references become evidence and never automatically reparent,
even when origin evidence is stronger. Reviewed correction with audit is
required. Remote delivery never changes local ancestry. Unambiguous orphan
adoption resolves a previously unresolved edge and is not reparenting.

### Policy generations and fan-out

Every source has a monotonic policy generation. A source-wide fan-out job
carries the generation that created it. Each batch stops and recomputes when
the stored source generation differs, preventing stale quarantine/allow/block
batches from writing selections or events after a later transition.

The source transition and reset barrier commit atomically. Fan-out is durable,
bounded, resumable, and applies selection, classification, and item events in
transactions. Reads always derive effective eligibility from current source
state, independent of batch progress.

## 7. Bounded origin verification

A valid publisher URL first seen in an aggregate claim schedules containment
verification. Checks are cached per logical item/item key, not merely publisher
URL. Pending checks for one publisher batch into one bounded fetch.

The scheduler deduplicates queued/in-flight work, caps unseen publisher URLs per
aggregate response, limits per-publisher and per-source pending work, limits
global concurrency and rolling attempts, and applies exponential backoff.
Recently fetched responses serve all queued checks for that publisher.

Matches require exact normalized permalink or resolved publisher plus exact
explicit opaque ID. Success persists a direct-origin delivery and evidence,
may establish a publisher alias, and may change remote selected author. It may
be displayed only when its source is eligible. Quarantined origin evidence may
strengthen attribution but cannot supply displayed content.

Feed absence is inconclusive because old items fall out of feeds. Exhausted
retries leave `asserted/unverified`, never contradictory. Verification never
changes governance/federation, creates a subscription, clears moderation, or
reparents an item.

SSRF, governance checks on redirects, redirect caps, timeouts, body caps, and
safe headers apply to verification. Paused, blocked, and tombstoned targets are
not fetched.

## 8. Visibility and moderation

Core owns one policy projector for ordinary reads, feeds, event send/replay,
and administrative reads. Web never decides whether raw remote content is
allowed. Administrator representation requires both an authenticated admin and
an explicitly administrative endpoint; ordinary routes behave identically for
admins and non-admins.

Core returns policy-projected semantic content and Markdown, never rendered
HTML or hidden raw fields. Web creates `contentHtml` for SSR and SSE through its
single server renderer. Admin raw evidence is escaped text; previews use the
sanitizer. Secrets, callback tokens, auth material, and equivalent credentials
never appear in list, detail, error, or audit responses; expose safe state or a
fingerprint only.

### Surface policy

- Hidden or unsupported remote items are absent from rivers, publisher/source
  views, search/future discovery, and all RSS/Atom/JSON/comment feeds.
- The all-users firehose remains local-only.
- Hidden or unsupported nodes required to connect visible descendants become
  neutral conversation placeholders.
- Full retained evidence is available only through explicit admin surfaces.
- Hidden or unsupported items have no ordinary history route.
- Ordinary history contains only permitted selected-presentation history.
  Displaced deliveries, ineligible versions, and conflicts remain admin-only;
  restore does not publish previously ineligible evidence.

A placeholder contains only logical ID, parent/root IDs, placeholder kind, and
neutral text. It exposes no content, author claim, title, URL, preview, feed,
revision, reason, note, category, or delivery metadata. Branches without any
visible item are pruned. A wholly unavailable conversation is ordinary
not-found/empty. Placeholders offer no reply/edit/feed/source action.

### Hidden moderation

Hide/restore atomically update current state, audit, selection/classification,
and journal. Hidden overrides every delivery and survives polling, push,
versions, verification, restart, and replay. Restore becomes visible only when
an eligible delivery exists. There is no rejected state.

### Purge

Purge is allowed only from blocked. It deletes the source's deliveries, every
claim belonging to those deliveries, versions, push and health state, and
operational records. Shared logical items survive and reselect. A remote item
whose last retained delivery disappears is deleted unless a surviving
descendant references it. In that case it becomes a content-free structural
tombstone retaining only logical ID, parent/root IDs, placeholder kind, and
neutral text. It retains no source, publisher, content, moderation reason, or
delivery evidence. Structural tombstones remain only while needed by surviving
descendants and serialize through the ordinary placeholder contract. Local
items always survive. Publishers referenced elsewhere survive; fully
unreferenced publishers are deleted.

The tombstone always survives with canonical URL, necessary aliases, and
terminal block/purge action, category, actor, optional note, and timestamp.
Direct subscription and every redirect hop honor it. Explicit tombstone unblock
removes the prohibition but creates no source.

## 9. Durable logical-item events

The event journal has `upsert | remove | reset` records. Each has a unique
monotonic sequence used as SSE `id`; item events separately carry
`logicalItemId`. Replay is strictly after the supplied sequence. A cursor older
than retained history receives `reset` and SSR reconciliation.

`upsert` records visibility gain, selected content/delivery/author change, or
lens classification change. `remove` means global ordinary visibility loss.
`reset` has no logical item and forms an immediate barrier for source-wide
policy changes and migration.

Every event is projected through current policy when sent or replayed. Stored
historical content is never blindly transmitted. A historical upsert that is
now hidden becomes an effective remove or is superseded by reset.

Event creation is atomic with the mutation. Live publication occurs after
commit; the journal is authoritative if live delivery fails.

Payload classification supports Local, Public, Federated, Personal, author,
and thread lenses: origin, selected author, eligible source IDs, approved-source
support, visibility, and thread identity. Selected-author and classification
changes emit upsert. Timeline clients insert, replace, move, or remove after
reevaluating their lens. Conversation clients refetch moderated thread state;
remove never forces unconditional deletion where a placeholder is required.

The web SSE proxy understands and sanitizes the new contract rather than only
transforming legacy `post` events.

## 10. API and administrative experience

Raw URLs are accepted only by source resolution/creation endpoints. After
resolution, mutations use stable IDs. Legacy author-shaped `POST /users` and
handle deletion retire in favor of explicit `/admin/sources` and stable-ID
transition endpoints. Any retained ops-token compatibility surface invokes the
same domain transitions and is narrowly scoped.

Ordinary responses return projected logical items or tagged placeholders.
Administrative source summaries show canonical URL/aliases, explicit mode,
three axes, provenance, active/pending subscriber counts, item/delivery counts,
last fetch/success/failure, safe push state, capabilities, and conflict counts.

Administrative navigation separates approved federation, quarantine/pending,
allowed user sources, and blocked/tombstoned sources. Source detail provides
pause/resume, quarantine/allow, federation transitions, block/unblock, purge,
authorized mode change, item review, provenance, verification, and audit.

Item detail is logical-item-first and exposes paginated deliveries/versions,
claims/conflicts, verification, and audit. Hide and restore are initial actions.
Reviewed authorship, ancestry, and historical convergence corrections are
foundation contracts assignable to later vertical plans unless required by
migration operations.

Sources/items, deliveries/versions, claims/conflicts, audit/moderation,
subscribers, and migration findings all use stable cursor pagination. Detail
responses return summary counts and paginated subresources, never unbounded
collections.

Forms are SSR/no-JS capable. Required moderation categories and optional notes
are explicit. Block, purge, and unblock confirmations state their distinct
consequences.

## 11. Command idempotency and authorization

Every state-changing request carries a durable command/idempotency ID. No-JS
forms receive a server-generated hidden command ID. Repeating an ID returns the
original result and creates no second mutation, audit entry, journal event, or
reset. Reusing an ID for a different command is rejected.

Administrative route tests cover unauthenticated, anonymous, registered
non-admin, verified administrator, valid ops token, and invalid ops token.
The ops token may access only explicitly scoped compatibility operations—not
moderation, purge, retained evidence, subscriber intent, migration findings, or
audit APIs.

Credential-redaction tests assert secrets and callback tokens never appear in
list/detail/error/audit output.

## 12. Migration

The redesign migration is one atomic schema version. Preflight completes before
conversion; any failure leaves the old schema intact.

### Manifest and preflight

An optional versioned manifest is restricted to legacy `feed_type=instance`
rows and keyed by exact legacy source ID plus exact legacy feed URL. Each entry
specifies approval, mode, and operator/provenance note. Unknown, duplicate,
mismatched, invalid, or contradictory entries abort.

Preflight narrowly normalizes all remote URLs. Missing, malformed,
credential-bearing, oversized, non-HTTP(S), or normalized-colliding URLs abort;
migration never fabricates or silently merges. Aborting problems appear as
external startup diagnostics, not in a transactional report because nothing
commits.

The supported correction procedure is: back up the database, run the documented
preflight command, correct identified legacy rows, rerun preflight, then restart
migration.

### Conversion

- Preserve local account IDs/handles exactly; local accounts are local authors.
- Preserve remote user IDs exactly as source IDs.
- Give new remote publishers new IDs.
- Permanently reserve every legacy remote handle alias through removal/purge.
- Convert `person/webfeed` to `single_publisher + enabled + allowed + none`.
- Convert manifest-approved instances using manifest mode to allowed/approved.
- Convert every unconfirmed instance to `aggregate + enabled + quarantined + pending`.

For migrated single-publisher sources, the bound publisher remains selected;
different per-item attribution is a conflicting claim. For aggregate sources,
valid per-item attribution selects the provisional publisher and invalid/missing
attribution uses a source-scoped unattributed publisher. Quarantined deliveries
remain admin evidence but cannot be effective ordinary display.

Each legacy remote post initially remains one logical item with the same post
ID, one delivery/version, claim, selected publisher, and retained preferred
delivery. Preserve GUID, permalink, content, Markdown, dates, reply context,
and resolve-once ancestry. Do not merge historical posts automatically;
collisions become non-aborting migration conflicts.

Preserve legacy revision order/timestamps but mark timestamp provenance
`legacy_unknown`; it cannot act as an authoritative explicit-update marker.

Every valid local-to-remote follow becomes a source subscription. Every legacy
instance follow becomes `pending_review` regardless of source approval, counts
toward the cap, exposes no Personal content, remains removable, and requires an
explicit reviewed activation.

Valid push state preserves protocol, endpoint, topic, callback token, secret,
state, expiry, and creation time exactly. Expired rows remain inactive evidence.
Invalid rows become inactive administrator evidence and are reported rather
than discarded. Quarantined sources may retain active leases with admin-only
ingestion. Migration sends no subscribe/unsubscribe network requests.

The durable report contains only non-aborting conversion findings. The report
and cutover reset commit inside the migration transaction. After commit, paced
acquisition resumes for enabled allowed and enabled quarantined sources;
paused/blocked sources remain inactive.

## 13. Reliability and acceptance tests

### Atomicity and fault injection

Tests crash after parsing, after delivery/job insertion, during reconciliation,
and before journal append. They prove that evidence and reconciliation work are
atomic, reconciliation commits all relationships/claims/conflicts/selections/
events together, and no partial ordinary item appears.

Source policy-generation tests cover restart and rapid
`quarantined -> allowed -> blocked`, proving stale fan-out cannot overwrite
current state or emit stale events.

Idempotency tests retry every governance/moderation command and assert one
mutation, audit, and journal effect. Concurrent final-slot subscription tests
prove serialized cap enforcement.

Selection tests give the same item multiple eligible deliveries and publisher
claims at every evidence level, including equal-level ties, and prove that
reconciliation, policy reads, fan-out, restart, and replay choose the same
winner. Subscription-transition tests prove ordinary pending activation on
allow, permanent non-automatic `pending_review`, aggregate-mode demotion of
active and pending subscriptions, and exclusion under quarantine/block. URL
and OPML tests prove canonical local feeds create local-account follows without
remote source shadows.

### Mandatory moderation scenario

Hide one item from an approved aggregate peer; verify removal from rivers,
profiles, histories, feeds, and live/replay state and a neutral conversation
placeholder. Poll, push-redeliver, edit, restart, replay, and origin-verify it;
it remains hidden. Restore it and verify eligible selection/classification.

A shared-delivery variant quarantines one approved source while an allowed
ordinary source keeps the item public. It leaves Federated, reselects safely,
and emits classification reconciliation.

### Mandatory push scenarios

- Paused/blocked WebSub deliveries authenticate and return neutral success but
  are not parsed or stored.
- Paused/blocked rssCloud thin pings return normally without fetching.
- Known in-flight challenges complete without further acquisition.
- No renewal occurs while paused or blocked.
- Quarantined enabled sources continue storing admin-only deliveries.

### Mandatory purge scenario

Purge a blocked source containing an item shared with another remote source and
a delivery converged on a local item. Prove local origin and other eligible
deliveries survive, unsupported remote items are deleted, and unsupported
ancestors of visible descendants become content-free structural tombstones
that preserve their exact thread edges across restart. Prove tombstone
URL/aliases block resurrection by direct subscription and redirect, and
terminal audit plus required reset/remove effects survive restart. Apply the
same structural-tombstone assertion to last-subscription cleanup.

### Migration tests

Cover every legacy type, manifest validation, exact ID preservation, invalid URL
and normalized-collision aborts, pending legacy-instance subscriptions,
over-cap grandfathering, push preservation/invalid evidence, `legacy_unknown`
timestamps, permanent handle reservation, atomic report/reset, and full rollback.

### Protocol and web regression

Continue RSS/Atom/JSON/h-feed, Textcasting/RFC threading, WebSub/rssCloud,
SSRF/redirect, live-edit, local-only firehose, moderated comments feeds, SSE,
sanitizer drift-canary, SSR, and no-JS coverage. Web tests cover full versus
placeholder threads, audience boundaries, admin two-gate access, pagination,
escaped evidence/sanitized previews, all event kinds, lens entry/departure,
author changes, and reset reconciliation.

### Completion gate

Every implementation vertical must finish with the relevant focused tests. The
foundation completion gate requires fresh successful runs of:

- core Vitest suite;
- core `tsc --noEmit` (`npm run typecheck`);
- web Vitest suite;
- `svelte-check` (`npm run check`);
- production web build (`npm run build`).

## 14. Implementation sequencing after review

This document deliberately specifies one foundation but not one monolithic
implementation plan. The following are dependency areas, not implementation
slices:

1. schema, migration preflight, and entity repositories;
2. source resolution, subscriptions, operation/governance/federation lifecycle;
3. delivery reconciliation, publishers, logical items, verification;
4. visibility projector, moderation, journal/SSE, and conversation placeholders;
5. administrative APIs and no-JS web surfaces;
6. migration execution, compatibility retirement, and full acceptance hardening.

Implementation planning must instead define true end-to-end vertical slices.
Each slice includes the storage, central visibility policy, domain behavior,
API, web behavior, migration compatibility where applicable, and tests needed
to leave both old and new paths safe. The visibility boundary lands with the
first new remote reader/writer; it cannot wait until remote reconciliation is
otherwise complete. New readers and writers must be ready before migration
conversion, which remains the final cutover slice.

The exact slices are decided only after this amended spec's external review.
No implementation plan or code change is authorized by this document alone.
