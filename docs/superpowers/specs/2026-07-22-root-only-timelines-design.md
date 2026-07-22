# Root-only timelines and compact reply affordance — design

**Date:** 2026-07-22 · **rev 1** (parallel-session correctness + ponytail
review folded — see `../reviews/2026-07-22-root-only-timelines-spec-review.md`,
R1–R9; the headline cut: no live reconciliation into open threads — count
overlay only, matching today's snapshot-wedge behavior)
**Status:** Approved brainstorm; ready for implementation planning after maintainer review
**Scope:** Timeline presentation and live reply activity. Reply storage, feeds,
federation, threading, and conversation pages retain their existing semantics.

## Context

RSC currently treats replies as top-level cards in chronological timelines and
also exposes them beneath their parent through an outliner wedge. The
`hiddenIds()` helper removes duplicate cards only after a wedge opens. Before
that interaction, a busy conversation contributes many context-poor cards to
the river while its root independently advertises the same replies.

That behavior follows the founding threading decision that replies are
first-class posts in the firehose. It is still correct for storage and open-feed
transport, but it is not the best presentation rule for a social timeline.
Replies remain posts, stable feed items, editable objects, federation events,
and permalink targets; ordinary rivers simply stop presenting resolved replies
as conversation starters.

The existing wedge is also visually too prominent. A bordered pill with a
44-pixel visible body and text such as “3 replies” competes with post content.
The desired affordance is the familiar compact reply icon plus count, while
retaining a full accessible target and a no-JavaScript conversation link.

## Decisions

1. The four home tabs—Local, Federated, Personal, and Public—show top-level
   conversation entries only.
2. The following-management timeline uses the same top-level presentation as
   the Personal river. It must not reintroduce the clutter under another URL.
3. A top-level entry is either:
   - a true non-reply/root (`in_reply_to IS NULL`); or
   - an unresolved reply (`in_reply_to IS NOT NULL` and
     `in_reply_to_post_id IS NULL`).
   Resolved replies have `in_reply_to_post_id IS NOT NULL` and are excluded.
   This explicit predicate is preferred over `thread_root_id IS NULL`: both
   currently describe unresolved replies, but the reply-resolution field is
   the direct semantic boundary and remains honest if root bookkeeping evolves.
4. Unresolved replies remain visible with the existing unverified
   `ReplyContext` or external “in reply to” link. Hiding them would make valid
   remote content undiscoverable merely because its parent is unavailable.
5. Author profiles keep their current activity-oriented behavior: an author’s
   replies remain visible, grouped one card per conversation with the local
   stack behavior. A profile answers “what did this author publish?”, not “what
   conversations exist in this river?”
6. Conversation pages keep the complete, fully unfolded reply tree. Thread JSON
   and comments-feed behavior are unchanged.
7. Root reply counts represent all resolved descendants in the conversation,
   not only direct children. A root-level “7 replies” affordance must describe
   what opening it reveals. Nested controls inside `ReplyTree` continue to show
   direct-child counts, because each nested control reveals exactly those
   children.
8. The large wedge pill is replaced by a compact, reusable reply-count control:
   an outline speech-bubble icon and numeric count, with no persistent border or
   filled pill. The visible glyph is small; the interactive target remains at
   least 44 by 44 CSS pixels.
9. Live resolved replies do not prepend as timeline cards. They update the
   visible root’s count using an authoritative count supplied by core. Counts
   are never incremented optimistically in the browser.

## Considered approaches

### A. Filter replies after loading in Svelte

Rejected. Pagination would still count hidden replies. A page could return 100
rows and render only a handful, or appear empty while exposing an “Older posts”
cursor. It would also ship unnecessary content to the browser.

### B. Change `getTimeline()` globally to return roots only

Rejected. The repository method is also an inspection primitive used by tests,
author views, ingestion/federation verification, and other domain paths. A
global semantic change would hide stored replies from callers that legitimately
need them and create a much larger test and behavior blast radius.

### C. Add an explicit top-level timeline filter

Chosen. The public timeline API gains an explicit query option, the repository
applies it before ordering and limiting, and only river-style web surfaces opt
in. Pagination remains correct and other consumers retain current semantics.

For live counts, three approaches were considered:

- browser-side `replyCount + 1`: rejected because inclusive SSE replay and
  reconnect duplicates would inflate counts;
- refetch the thread after every reply: correct but transfers full thread
  content just to learn a count;
- authoritative count metadata on SSE reply entries: chosen. ONE array-shaped
  grouped query (mirroring `countRepliesByPostIds(ids) → Map`) serves both
  paths: the live path calls it with a single root id, replay with the batch's
  distinct root ids (bounded by the replay cap). No N+1 replay queries, no
  separate single-reply query shape.

## Core timeline selection

### Filter contract

The timeline filter object is currently repeated inline in FOUR places —
the `Repository` interface (`repository.ts:30`), the SQLite implementation
(`sqlite.ts:226`), the service (`service.ts:75`), and the API route
(`app.ts:458`) — and all four must gain `topLevel?: true` (widening only some
of them either breaks typecheck or silently drops the flag at the interface
boundary). A shared `TimelineFilter` type is acceptable house cleanup while
touching those lines, but it is optional, not load-bearing:

```ts
interface TimelineFilter {
  followedBy?: string
  authorId?: string
  source?: 'local'
  feedType?: 'instance'
  topLevel?: true
}
```

`GET /timeline` accepts `top_level=1`. Any other supplied value returns
`400 { error: 'top_level invalid' }`, matching the strict existing
`source`/`feed_type` validation style.

When enabled, the SQLite query adds:

```sql
WHERE posts.in_reply_to_post_id IS NULL
```

This includes true roots and honest unresolved replies and excludes every
resolved direct or nested reply. The condition is applied before the existing
`ORDER BY`, cursor tuple, and `LIMIT`, so page size and cursor semantics remain
correct. No schema migration or new index is required at the current scale;
`posts_parent_idx` already indexes `in_reply_to_post_id`.

The home page always sends `top_level=1`, composed with its active tab filter.
The following-management timeline also sends it. Author-page loads do not.

### Conversation reply counts

Do not change `countRepliesByPostIds()`: feeds and nested reply UI rely on its
direct-child semantics. Add a distinct repository operation such as
`countThreadRepliesByRootIds(rootIds)` for root affordances.

For each requested root ID, it counts rows whose `thread_root_id` equals that
ID. This is the stored resolve-once conversation membership and therefore
counts every resolved descendant. Roots with no descendants map to zero. An
unresolved reply CAN routinely acquire resolved descendants rooted at its own
ID (a reply targeting it resolves with `thread_root_id = its id` —
`service.ts:59-60`, `ingest.ts:163-164`); the same query truthfully counts
that visible subtree.

The `/timeline` route uses conversation counts when `top_level=1` and preserves
the existing direct counts otherwise. This avoids silently changing the API
meaning for author-profile callers during this milestone.

## Live updates

### Wire shape

The SSE event remains `event: post` and continues carrying a `TimelineEntry`.
Add optional `rootReplyCount?: number` metadata only when serializing a newly
created resolved reply. Its value is the current total resolved-descendant count
for `entry.threadRootId`.

The stored post and regular HTTP thread representations do not need this field;
it is transient timeline activity metadata. Edits do not carry
`rootReplyCount`, because they do not change conversation cardinality.

The core SSE route owns this enrichment because it handles both live events and
replay. Both paths use the same array-shaped count method: live with a
one-entry batch, replay with the batch's distinct reply root IDs in one
grouped query. Root posts, unresolved replies, and edits serialize as today.
A count-enrichment failure degrades to the existing post frame — it must not
kill the stream; the web then drops the reply without changing a visible
count, and the next reload repairs presentation.

Note: `bus.onNewPost` handlers are today synchronous fire-and-forget; the
count query makes the handler async, so frames from closely-spaced posts may
write out of emit order. This is harmless — every frame carries an
authoritative total, so ordering cannot corrupt counts — but tests must not
assert cross-frame emit ordering.

Inclusive replay may deliver the same reply more than once. Because every frame
carries an authoritative total rather than a delta, applying it repeatedly is
idempotent.

### Home and following consumers

For home and following river `onPost` handlers (rev 1 — the count overlay is
the WHOLE live-reply behavior; there is no reconciliation into open threads):

1. If the entry is a resolved reply (`inReplyToPostId` is set):
   - never prepend it and never pass it to `mergeIncoming()`;
   - if `threadRootId`, `rootReplyCount`, and a matching visible root are
     present, overlay that root with the authoritative `replyCount`;
   - otherwise do nothing. Do not fetch or insert an off-page root.
   Do this before applying the author/source lens: a remote reply still changes
   the count of a visible Local root, and a local reply still changes a visible
   Federated root. Visibility of the root, not membership of the replier, is
   the count-update boundary.
2. If the entry is a root or unresolved reply, apply the existing tab/follow
   lens and then pass it through `mergeIncoming()`. New entries prepend; edits
   swap in place.

An expanded inline thread remains exactly what its `fetchThread()` snapshot
returned — matching today's behavior, where a live reply never enters an open
wedge either. New replies (and reply edits) inside an open thread become
visible on the next expansion or reload, which re-fetches authoritative HTTP
state. If live in-wedge updates are ever wanted, that is a separate future
design; this milestone deliberately does not build reconciliation, queues, or
browser-side thread re-ordering.

The following river currently lacks home's live machinery (its `onPost` is
prepend-only — no `mergeIncoming`, no `edited` map). It gains the home-style
handler (`pageIds`, `edited`, `mergeIncoming`, and the count overlay) so both
rivers share one behavior.

There is a subtle Personal-river case: a followed author may reply inside a
conversation whose root author is not followed. The root is absent, so the
handler does not materialize that foreign root merely to show the activity; the
reply remains available through the author profile, feeds, and conversation
permalink. Conversely, once a root belongs to Personal, replies from any author
update its count because opening the control reveals the whole conversation.
This keeps Personal’s root membership author-based without making its displayed
conversation counts partial.

The conversation page and author profile retain their existing `onPost`
semantics. They continue receiving and rendering reply posts because those
surfaces are explicitly activity/thread views rather than root-only rivers.

### Edits and adoption

- Editing a root continues to update its visible timeline card.
- Editing a resolved reply does not prepend it or change counts in root-only
  rivers (edits carry no `rootReplyCount`; the resolved-reply branch drops
  them). An open inline thread shows the edit on its next expansion or reload;
  the conversation page updates it live through its existing merge path.
- Orphan adoption currently does not emit a distinct bus event. If an already
  visible unresolved reply is later adopted, the root-only river may retain
  that card until reload. This is an existing live-consistency limitation and
  remains out of scope; SSR reload applies the authoritative filter. A future
  adoption event can remove it live if real usage makes the residual visible.

## Web reply-count control

Extract the repeated control into `web/src/lib/ReplyToggle.svelte`. It is used
by the home timeline, following timeline, author profile, and nested
`ReplyTree`. The component receives:

- `count: number`;
- `href: string` (the conversation permalink and no-JS fallback);
- `expanded: boolean`;
- `busy: boolean` (default `false`);
- `onactivate: () => void`, an activation callback owned by the parent.

The rendered element remains an `<a>`:

- without JavaScript, it navigates to the full conversation;
- when `busy`, the component prevents navigation and does not call
  `onactivate`, suppressing duplicate requests;
- when not busy, the component prevents navigation and calls `onactivate` to
  toggle the inline tree;
- `aria-expanded` exposes state;
- `aria-busy="true"` is present exactly while `busy`;
- `aria-label` is `Loading N replies`, `Show N replies`, or `Hide N replies`
  according to those states, with correct singular wording;
- the SVG is `aria-hidden="true"` and uses `currentColor`;
- the numeric count remains visible; no tooltip is required for basic meaning.

Visual treatment (this section is the design source — it is folded INTO
`design-system/rsc/MASTER.md` per §Documentation updates; MASTER.md has no
reply-control content yet):

- outline speech-bubble SVG, approximately 1rem;
- count at the existing small metadata size;
- transparent background and no persistent border;
- minimum 44×44 hit target without a visually large pill — via padding on the
  compact glyph (the tabs' `min-height` + padding idiom), not `::after` hacks;
- secondary text color at rest, foreground/accent treatment on hover and focus;
- expanded state uses accent color and `aria-expanded`, not rotation of a
  wedge glyph;
- the standard visible focus ring remains;
- no raw hex values and no new color token.

`ReplyTree` continues to recurse and manage nested open state. Its controls use
direct-child counts computed from the already fetched flat thread. Home and
following no longer need `hiddenIds()`, because resolved replies are absent
from their top-level datasets. Keep `subtreeIds()` only if another current
consumer or test needs it; otherwise remove dead duplicate-prevention logic as
part of this focused change.

Count honesty note: `ReplyTree` nests collapsed by default (`open[id] ??
openAll`), so a control's expansion reveals direct children with nested
controls beneath — the standard drill-in pattern. On rivers the root control
shows the conversation TOTAL while the first expansion shows direct children;
this is the accepted reading of decision 7 ("what opening reveals" = the
conversation reachable through it). On author profiles the direct count is
already honest as-is: opening reveals exactly the counted direct children.

The author profile’s special “N more in this conversation” stack is not a reply
count and retains text. It may reuse the compact visual language later, but
changing that activity-specific control is out of scope.

## Loading, errors, and interaction races

Inline thread fetching remains lazy through `/post/:id/thread.json` and retains
server-side sanitation. The compact control does not change that security
boundary.

Add per-ID loading state around expansion. There are THREE divergent
`toggleWedge` copies today (home, following, author profile) plus ReplyTree's
local toggle — the guard applies to all expansion handlers, not just one:

- the handler starts with `if (loading[id]) return`, then sets `loading[id]`,
  fetches, installs the snapshot, and clears loading;
- the parent passes `busy={loading[id]}` to `ReplyToggle`; while busy, the
  component contract above suppresses repeated activation (belt-and-braces
  with the handler guard);
- on success, open the tree;
- on failure, clear loading and leave the tree closed — the user can re-click
  (the fetch is an idempotent GET) or follow the conversation permalink;
- do not replace the timeline with a global error for a failed enhancement.

This closes the existing race where rapid clicks launch duplicate thread
requests, with one guard and one busy flag — no `enhancementFailed` state and
no un-enhanced click mode.

- Root-only selection happens during SSR, so no-JavaScript users see the same
  uncluttered river.
- The compact control is a normal conversation link before enhancement.
- The visible count is not the accessible name; the explicit label provides
  the action and correct singular/plural wording.
- The target remains at least 44×44 CSS pixels even though its visible icon is
  compact.
- Focus indication, keyboard navigation, and both color themes are required.
- Expanded replies remain a nested `<ul>` beneath their parent, preserving the
  current document structure.

## Testing

### Core

- Repository contract: `topLevel` includes roots and unresolved replies,
  excludes resolved direct and nested replies, and applies before pagination.
- Repository contract: conversation-count query returns all descendants while
  the existing direct-count query remains direct-only.
- Timeline API: accepts `top_level=1`, rejects other values, composes with
  `source`, `feed_type`, and `followed_by`, and returns total conversation
  counts in top-level mode.
- Timeline API: default behavior remains unchanged for callers that omit the
  parameter.
- SSE: live resolved reply carries authoritative `rootReplyCount`; root,
  unresolved reply, and edit events do not.
- SSE replay: reply counts are authoritative and replay-safe; the batch path
  uses grouped lookup behavior rather than one count query per replayed reply.
- SSE failure path: count-enrichment failure does not terminate live delivery;
  the un-enriched reply frame is dropped by root-only rivers (no count change)
  until authoritative reload.
- SSE tests assert per-frame content only, never cross-frame emit ordering
  (the enrichment makes the bus handler async).

### Web

- API wrapper sends `top_level=1` only when requested.
- Home load requests top-level mode for all four tabs.
- Following load requests top-level mode; author load does not.
- Home and following live handlers never prepend resolved replies (and never
  pass them to `mergeIncoming`), and overlay a visible root’s count from
  `rootReplyCount`; applying the same frame twice yields the same count
  (idempotent, replay-safe).
- An expanded inline thread is snapshot-only: a live reply (new or edited)
  does not alter it; the next expansion/reload shows it.
- A resolved reply updates an already-visible root regardless of the replier’s
  lens membership, but never materializes an absent root.
- Root and unresolved-reply events retain existing prepend/edit behavior;
  following now shares home's `edited`/`mergeIncoming` handler.
- `ReplyToggle` renders icon, count, href, accessible singular/plural label,
  expansion state, `aria-busy`, and the busy click contract.
- Expansion tests cover success, double-click suppression (the loading guard),
  and fetch failure leaving the tree closed with loading cleared.
- Conversation-page tests confirm the complete reply tree remains visible and
  live.
- Author-profile tests confirm grouped reply activity remains unchanged.

### Verification commands

With the Docker stack running, use the repository-prescribed commands:

```bash
docker exec rsc-core sh -c "cd /app && npm test -w core"
docker exec rsc-core sh -c "cd /app && npm run typecheck -w core"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm test -w web"
docker exec rsc-web sh -c "cd /app && env -u CORE_API_URL npm run check -w web"
```

## Documentation updates

- Update `README.md` so the four-tab timeline description says conversations
  appear once at the root and replies expand inline or on the conversation
  page.
- Update `design-system/rsc/MASTER.md` with the compact reply-count control and
  root-only river rule.
- Treat the 2026-07-16 threading design as historical. Do not rewrite its
  original “replies live in the timeline” decision; this design supersedes
  presentation only and should be linked from current documentation.

## Non-goals

- Changing reply storage or making replies cease to be posts.
- Changing RSS, JSON Feed, OPML, WebSub, rssCloud, comments feeds, or ingest.
- Bumping conversation roots when replies arrive.
- Notifications, ranking, or unread-reply state.
- Hiding unresolved replies.
- Changing author-profile activity grouping.
- Live orphan-adoption removal.
- Live reconciliation of replies into open inline threads (queues, browser-side
  thread re-ordering) — expanded threads are snapshot-only; a future design if
  ever wanted.
- Fetching or inserting off-page roots in response to reply activity.
- Redesigning the reply composer or conversation page.
