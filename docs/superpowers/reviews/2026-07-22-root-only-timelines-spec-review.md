# Spec review — root-only timelines + compact reply affordance (2026-07-22)

Parallel-session review of `docs/superpowers/specs/2026-07-22-root-only-timelines-design.md`
(3 finder angles: core/SSE grounding, web grounding, and a dedicated ponytail
pass — the spec was written without the ponytail gate). Every claim verified
against the real code. **Verdict: the product core is right and well-grounded —
SSR root-only filter, authoritative counts, compact control — but roughly 40%
of the spec builds a live-reconciliation apparatus for a behavior that has
never existed, whose removal causes zero user-visible regression. Fold R1–R9
as rev 1 before the plan (and re-check the already-written plan against R1
especially).**

## The headline: R1 — cut the live-reconciliation apparatus (ponytail, confirmed twice)

Today's home `onPost` (`+page.svelte:36-41`) is lens-check → `mergeIncoming`;
an open wedge renders only its one-shot `fetchThread` snapshot
(`+page.svelte:57-60`) and **no code anywhere reconciles a live reply into an
open wedge or queues events during a fetch** — verified independently by two
finders. So the spec's §Live-updates apparatus — per-root pending queues, a
pure reconcile helper re-implementing core's depth-first ordering with a
cycle guard in the browser, the edit-vs-new asymmetry, the
hide-without-`rootReplyCount` invariant, queue-clear-on-failure — is entirely
NEW machinery presented as if required by the count feature. It isn't.

**The lazy version with identical UX:** in `onPost`, if the entry is a
resolved reply — never prepend; if `rootReplyCount` is present and a visible
root matches `threadRootId`, overlay that root's `replyCount`; else drop it.
~3 lines. Expanded wedges stay as-fetched (exactly today's behavior — a live
reply never entered an open wedge before either); reload repairs. This
deletes the queue, the reconciler, the ordering restore, the asymmetry, the
failure branch, and the ~6 web tests that assert now-unreachable states
(queued-during-fetch, hidden-without-count, edit-reconciled-into-tree).
Keep: never-prepend, count overlay, no optimistic increment, idempotent
replay. If live in-wedge updates are ever wanted, that's its own future spec.

## Correctness findings

### R2 — Home/following parity is assumed but doesn't exist

The spec treats both rivers uniformly ("pass through `mergeIncoming()`",
edits "swap in place") — but following's `onPost`
(`u/[handle]/following/+page.svelte:19`) is prepend-only: no `mergeIncoming`,
no `edited` map. Even the R1-minimal count overlay needs an edit/overlay
mechanism following doesn't have. The spec must state it: following gains
the home-style handler (small), or its live behavior is scoped down.

### R3 — ReplyToggle's conversation-count language lies on the author profile

Decision 7's invariant is "a control must describe what opening it reveals."
Author profiles deliberately keep DIRECT counts (no `top_level`, direct
`replyCount` — spec §Conversation-reply-counts), yet the surface is routed
through ReplyToggle whose labels are conversation-worded — a multi-level
thread renders "Show 2 replies" and expands 9 nested cards
(`u/[handle]/+page.svelte:99` + ReplyTree recursion). Resolve: either the
author profile shows the subtree count too (one more id set in the existing
count call), or the spec explicitly accepts the direct-count mismatch there
and the label wording stays generic. Pick one in the spec.

### R4 — The filter object lives in FOUR places, not three

`repository.ts:30` (Repository interface), `sqlite.ts:226` (impl),
`service.ts:75`, `app.ts:458`. The uncounted interface is the dangerous one:
widen only the other three and either typecheck breaks or `topLevel` is
silently dropped at the interface boundary. (Ponytail note: the shared
`TimelineFilter` extraction is optional cleanup — adding `topLevel?: true` to
the four inline copies you're already editing is the minimal change; the
shared type is fine if wanted, just not load-bearing.)

### R5 — Loading-state: one guard, three sites; drop `enhanced`

The double-click race is real (`toggleWedge` has no busy guard) but the
answer is `if (loading[id]) return` plus the busy flag — not a second per-id
`enhancementFailed` map and an `enhanced` prop whose only job is the
failure-fallback branch (on failure: clear loading, leave closed; the next
click re-tries or the no-JS `href` navigates). That shrinks ReplyToggle to
5 props and collapses the 4-state click/aria truth table. AND: there are
**three** divergent `toggleWedge` copies (home, following, author) plus
ReplyTree's local toggle — the spec's singular "the expansion handler"
phrasing invites a partial fix; name all sites, or hoist the guard into the
shared extraction.

### R6 — One count method, not two paths

`countThreadRepliesByRootIds` is genuinely new (nothing counts by
`thread_root_id` today — verified) — but specify it once, array-shaped,
mirroring `countRepliesByPostIds(ids) → Map`: the live path calls it with
`[rootId]`, replay with the batch (bounded by REPLAY_CAP=100). Drop the
"one small query + one grouped query" dual-path framing.

## Minor

- **R7 — SSE enrichment ordering caveat:** `bus.onNewPost` handlers are
  synchronous fire-and-forget (`app.ts:488`); inserting an await-ing count
  query means frames can write out of emit order. Harmless by construction
  (authoritative totals are idempotent) — but add one spec sentence so no
  test asserts emit-order.
- **R8 — MASTER.md reference is circular:** MASTER.md contains no
  wedge/reply-control/44px content today; this spec IS the source and §Docs
  adds it later. Reword "follows MASTER.md" → "this section is the design
  source; fold into MASTER.md per §Documentation". Also note the
  44×44-without-visible-pill technique (padding on a compact glyph) isn't
  modeled in the codebase yet — the current idiom is `min-height: 44px` on a
  pill; one line saying "hit target via padding, matching the tabs' pattern"
  keeps implementers off `::after` hacks.
- **R9 — Drop a false clause:** "Unresolved replies have no resolved
  descendants under normal construction" is wrong — a reply targeting an
  unresolved reply U routinely resolves with `thread_root_id = U.id`
  (service.ts:59-60, ingest.ts:163-164). The spec's own next clause handles
  it correctly; delete the misleading lead-in.

## Verified clean (for the record)

Threading semantics exactly as specced (resolved/unresolved fields, resolve-
once `thread_root_id`, adoptOrphans re-roots descendants); the decision-3
predicate equivalence holds (no row has `thread_root_id` set with
`in_reply_to_post_id` NULL); `posts_parent_idx` exists (sqlite.ts:637) — no
new index needed; filter composes with SP2 tabs + self-inclusive
`followedBy`, and Kysely emits WHERE before ORDER/LIMIT so pagination holds;
`/timeline` replyCount plumbing (app.ts:474-475) and its four
`countRepliesByPostIds` consumers as described; SSE live+replay carry no
counts today (enrichment is genuinely new, in the right place); getThread
ordering contract matches the spec's description (sqlite.ts:51-73, 321-324);
thread.json sanitation boundary real; `hiddenIds`/`subtreeIds`: removing
`hiddenIds` leaves `subtreeIds` with no runtime consumer — the spec's
conditional resolves to **remove both**; the current pill matches the spec's
description (app.css:628-661); all four ReplyToggle consumer surfaces exist;
the author-profile "N more" stack correctly excluded; the double-fetch race
is real; callback-prop and `--color-ring` focus patterns match house style;
`top_level=1`-or-400 validation matches the `feed_type` style (keep it);
`rsc-core`/`rsc-web` container names and TESTING.md command forms verified;
authoritative-count-over-optimistic-increment is the right call (inclusive
replay would inflate deltas).

## Plan review (2026-07-22-root-only-timelines.md, pre-rev)

The plan is unusually well-grounded mechanically — **every named test file
verified real** (sqlite-repository, api-threading, sse, timeline-tabs,
page.load, stream/server, reply.actions, live, wedge), the TDD sketches match
the real harnesses, R4 is already handled (all four filter sites in Task 1's
file list), R6 is already satisfied (one array-shaped
`countThreadRepliesByRootIds`), and R2 is partially pre-empted (Task 6 Step 4
explicitly builds Following's `edited`/`pageIds`/`mergeIncoming` parity).

But it fully inherits R1: **Task 4 is the cut apparatus in its entirety**
(`reconcileThreadEntry` + the `RiverThreads` reducer state machine with
`queued`/`enhancementFailed` and 8 reducer test states), and the `enhanced`
prop threads through Tasks 5–6. Plan-specific findings:

- **PL1 (R1):** delete Task 4; Task 6 keeps `overlayVisibleRootCount`
  (Steps 1–3 — that IS the minimal design) plus a per-id `loading` guard on
  today's `expanded[id] = await fetchThread(id)` shape. Resolved replies:
  overlay count if a visible root matches, never `mergeIncoming`, else drop.
- **PL2 (R5):** Task 5 drops `enhanced`/`activationMode`'s navigate branch and
  the 4th label; ReplyToggle = count/href/expanded/busy/onactivate, suppress
  when busy, activate otherwise; on fetch failure just clear loading (href
  remains the fallback).
- **PL3:** Task 1 Step 5 widens only the WHERE clause — the impl's own inline
  filter type at `sqlite.ts:226` must also become `TimelineFilter` (typecheck
  catches it, but say it).
- **PL4 (R7):** Task 3's SSE tests must not assert frame order across
  distinct posts — enrichment makes the bus handler async; assert per-frame
  content only.
- **PL5 (R8):** Task 5's SVG is a placeholder comment (`<!-- checked-in
  outline bubble path -->`) — the plan must carry a real path (or instruct
  drawing one) so the implementer doesn't check in a comment.
- **PL6 (R3-revised):** ReplyTree nests CLOSED by default (`open[id] ??
  openAll`), so the author-profile control's direct count is honest — Task 6
  Step 5 needs no count change there. One spec line acknowledges the rivers'
  total-count-over-collapsed-tree drill-in pattern instead.
