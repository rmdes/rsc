# V2 seam sweep — "what else?" (2026-07-25)

Trigger: eight dogfooding-found defects in two days, all one class — seams
between individually-correct layers that no spec, plan, per-task review,
whole-vertical review, or integration test ever crossed, because no artifact
enumerated **user journeys under flag-on**. Four parallel read-only auditors
swept the class on four axes, trained on the eight known finds. This document
is the consolidated, de-duplicated result. Line refs verified spot-wise by the
orchestrating session where marked ✓.

Already fixed before this sweep (the training set): publisher naming
(`5c13943`), cold-pod crash loop (`625d7b0`), edit-page 500 (`efa4495`),
admin governance sections (`1065197`), byline individualization (`fcf5835`),
orphan-adoption producer (`7d2946e`), enclosure rendering (`64aa3db`),
reply-to-remote target (`50bc390`).

Fixed WITH this sweep: **W1/W2** below (`getFollowing` late-catch — the
cold-pod fix's incomplete sibling sweep).

## CRITICAL — pre-flip blockers

- **O1 ✓ Outbound threading is dead under v2.** `logicalToFeedEntry`
  hardcodes `inReplyTo: null` (`core/src/domain/feed.ts:27`) AND the v2
  create writes `posts.in_reply_to` as literal NULL
  (`core/src/logical/local.ts:168`), where v1 wrote the parent's
  permalink (`service.ts:75`). Every local reply leaves the instance as a
  parentless top-level item; cross-instance conversations never reassemble.
  The v1 money test (`federation-threading.test.ts:60`) has no v2 twin.
- **O2 ✓ Same line flattens the pre-cutover archive**: legacy replies keep
  `posts.in_reply_to`, but the v2 feed path never reads it — after the
  flip, historical feeds re-serialize threadless.
- **O3 ✓ The comment above feed.ts:27 documents O1 as deliberate "v1
  parity" on a FALSE premise** (v1 does emit it). Kill the comment with the
  fix or it resurrects the bug.
  - Fix note (orchestrator): not a hotfix — v2 local permalinks are stored
    RELATIVE (`local.ts:28 permalinkFor`), so the fix needs one deliberate
    decision on absolutization at the feed boundary (emission-time publicUrl
    resolution vs v1's storage-time absolutes), then persist→project→emit +
    a v2 twin of the money test covering local AND remote parents.
- **D14 History page crash (local posts).** Every non-current local revision
  projects `updatedAt: null` (`projector.ts:730`); the page keys its each
  block on `seenAt` → two revisions = duplicate key `''` = Svelte runtime
  error, page dead (`history/+page.server.ts:26`, `history/+page.svelte:13`).
- **D11 Placeholder thread nodes are dropped by the web** ( `logical-api.ts:93`
  keeps `kind==='item'` only): entire reply subtrees ship to the browser and
  never render; a placeholder ROOT makes the page claim "No such
  conversation." over live replies.
- **W1/W2 ✓ FIXED in this commit** — `getFollowing` promises at
  `+page.server.ts` (home) and `u/[handle]/following/+page.server.ts`
  attached no discard handler before intervening awaits: the cold-pod
  unhandledRejection crash, two more instances.

## IMPORTANT

- **D1** Remote `selectedAuthor` has `handle: ''` → non-profile bylines render
  `<a href="/u/">@</a>` and FeedIcon links `/u//feed.xml`.
- **D2/D3** Live tabs filter on fields v2 never populates: federated lens
  needs `feedType==='instance'` (always null under v2), personal lens needs
  `followIds` (local follows only) — every v2 live upsert is dropped
  client-side; tabs fill on reload only. `classification.federated/.personal`
  exist on the DTO precisely for this and are dropped by `logicalToEntry`.
- **D4** `replyContext.authorLabel/.snippet` hardcoded null core-side
  (`projector.ts:576`; acquisition never captures what v1's ingest did at
  `ingest.ts:79-80`) — the "In reply to Dave: '…'" line is gone under v2;
  web side already renders it when present.
- **O4** comments.xml emits our internal UUID as a REMOTE reply's `<guid>`
  (`feed.ts:21` guid: dto.id) — the origin instance can't dedupe its own
  item back. Origin guid is recoverable (delivery key).
- **O5** WebSub fat-ping body counts replies from `posts` only
  (`push.ts:235`, `sqlite.ts:542`) — a post with only-remote replies pushes
  `source:comments` absent while the pull body has it; push and pull bodies
  for one topic disagree.
- **W3** `/peers` panel: pure v1-table query (`sqlite.ts:290`) — empty
  forever on a v2 instance, masked by `.catch(() => [])`.
- **W4** `/admin/overview` counts (`sqlite.ts:666`) omit the entire v2
  corpus (sources aren't `users`, remote items aren't `posts`).
- **W5** OPML import after a core blip: the load's catch omits `commandIds`
  → the action falls to the legacy branch → v2 core 400s `commandId
  invalid` (`following/+page.server.ts:78/:132`, `app.ts:325`).
- **D15/D16** History page drops per-version `enclosures` and `title` —
  an audio-swap or title-only edit renders as identical rows (same class as
  the fixed enclosure bug, one route over).

## MINOR / hygiene

- **O6** Empty-feed channel title falls back to raw handle, not displayName
  (`logical-routes.ts:461`). **W6** coreDown thread page mounts the v1
  LiveTimeline on a v2 instance (shape-mixed frames). **W7** a transient
  blip on the reserved-handle probe turns a permanent 308 into coreDown.
  **D5** `updatedAtProvenance` dropped → "edited" tooltip shows arrival
  timestamps as publisher edits (also in history, D17). **D6** local
  `permalink` never reaches the card (feed and card disagree on the link).
  **D8** `ambiguous` parent state renders nothing (no "parent unavailable"
  affordance). **D9** `attributionLevel` invisible to readers — a
  hostname-guess byline looks as authoritative as a verified one (product
  call). **D12** `truncated` flags dropped — cut threads look complete.
- **Unwired-audit hygiene:** `synthesizeLocalItem` dead since written (its
  no-write guarantee unenforced); `markReconciliationRequiredIfActive`
  exists twice (tested fn vs server.ts inline SQL — production runs the
  untested one); seven dead store pass-through wrappers (seam-shaped traps:
  routing through them would nest transactions); `JournalChangeMask` is
  write-only precision (3 of 8 values never written, none ever read).

## Verified clean by the auditors

SSE parity (live upserts carry every field SSR has — the live/reload gap is
D2/D3's client filters, not transit); firehose `<source>` attribution for
local posts; WebSub ping firing under v2; comments.xml reply enumeration;
optional deps all supplied at composition sites post-`6024d47`; journal and
job kind read/write symmetry.

## Process lesson (carried to the milestone record)

The layered process verified contracts, not journeys. The cheap durable fix:
a **user-journey checklist as a required gate artifact** — post, reply,
edit, delete, thread, subscribe, import, listen, federate, and their
OUTBOUND mirrors (what a remote peer sees), each exercised through the
front door under flag-on, before any vertical claims completion. The
outbound mirror column would have caught O1-O5 at V2's gate; the journey
column would have caught the other eleven.

## Suggested execution

One SDD fix-wave off this document, severity order: O1-O3 as a single task
(the absolutization decision made in-plan, with the v2 money test), then
D14, D11, W-set, D-set. The Minor tier can batch or ride Task 11's
retirement release. This session (reviewer) holds review duty per task, as
during the verticals.

## 2026-07-25 — T1 correction note (scope growth + mechanism)

T1 (O1-O3) grew during execution from **outbound threading** to **outbound
threading + local feed identity** (one defect). The sweep listed the identity
breakage implicitly and severity-separately, but at the v2 read/emit boundary
a v2-created local post stored its permalink RELATIVE (`/post/<id>`), which
`projectLocal`'s `safeUrl` nulled — so the post emitted a bare UUID `<guid>`
with no `<link>` AND no `<source:inReplyTo>`. Threading and identity are the
same defect: a `source:inReplyTo` can only match a peer item that advertises an
absolute permalink guid.

**Mechanism (maintainer decision):** NOT emission-time absolutization. Instead,
**v1-parity create-time storage** — the v2 logical create now receives
`publicUrl` (threaded `service → store → local.createLocalPost`) and stores the
ABSOLUTE permalink in `posts.url` and the parent's absolute wire ref in
`posts.in_reply_to`, exactly as v1's `service.ts` create did. The existing
(v1) feed emission (`localGuid`, `itemContentFields`) then handles both paths
byte-identically with zero new emission code and no join helper. v2's earlier
relative-permalink storage choice is reversed to match v1 (which also heals the
D6 card permalink as a welcome consequence of matching v1, not a separate
change). No migration (reuses `url` / `in_reply_to`). This supersedes the
earlier in-plan "emission-time absolutization" framing.
