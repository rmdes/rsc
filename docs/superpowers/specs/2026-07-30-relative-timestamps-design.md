# Relative timestamps on posts

Status: rev 1 (2026-07-30)

## Motivation

Every post timestamp in the web UI renders as a bare, static date
(`{post.publishedAt.slice(0, 10)}`, e.g. `2026-07-30`) — the same six call
sites across the codebase all do this identically. A live, feeds-native
social timeline should read as *alive*: a post from two minutes ago should
say so, not look identical to one from this morning. There is no existing
`docs/superpowers/ideas.md` entry for this — the closest hits are about
`published_at`'s mechanics for pagination/sort ordering, not about how it's
presented to a viewer.

Grounding: `publishedAt` (the DTO field, mapped from `logical_items_v2
.timeline_sort_at` in `core/src/logical/projector.ts:603`) is already a
full-precision ISO datetime end to end — for remote items it's set once,
immutably, as the feed's claimed `<pubDate>` when trustworthy or our own
arrival time as a fallback (`core/src/logical/reconcile.ts:377-379`). The
truncation to a bare date happens **only** in the Svelte template
(`.slice(0, 10)`), not in the data. **This makes the whole fix frontend-only
— no core/API changes.**

## Goals

1. Replace the bare static date with a relative, human string ("2 min ago",
   "3h ago") everywhere a post timestamp renders today.
2. Make it feel live: while the page is open, a recent timestamp visibly
   counts up ("2 min ago" → "3 min ago") without a page reload or SSE event
   — a real interval-driven tick, not just "accurate as of last render."
3. Never lose the exact moment: the full absolute date/time stays available
   on hover (native `title` attribute on the `<time>` element).
4. No-JS-safe: correct and readable with JavaScript disabled, matching this
   project's "enhancement only" convention (`design-system/rsc/MASTER.md`;
   the same posture as the theme toggle) — server-rendered relative text at
   page-load time, JS only adds the live ticking on top.
5. Degrade sensibly for old/backfilled posts: beyond roughly a week, showing
   "3 months ago" reads worse than just the date — fall back to an absolute
   date past that threshold.

## Non-goals

- No provenance signal (icon/label distinguishing "the author's claimed
  publish time" from "our own arrival-time fallback"). The user scoped this
  down to liveness/relative-time only during brainstorming. Recorded as a
  follow-up idea in `docs/superpowers/ideas.md`, not built here.
- No changes to `publishedAt`'s underlying value or how `timeline_sort_at`
  is computed — this is purely a display change over already-correct data.
- No changes to `updatedAt`/edit-history displays (the post-history page,
  "edited" indicators) — out of scope; only the primary `publishedAt`
  render sites listed below are touched.
- No new dependency. `Intl.RelativeTimeFormat` (native, in every supported
  browser and in Node) does exactly this formatting — no library needed.

## Design

### New component: `web/src/lib/RelativeTime.svelte`

```
Props: { datetime: string }   // ISO 8601, e.g. post.publishedAt

Renders: <time datetime={datetime} title={absoluteLabel}>{relativeLabel}</time>
```

- `relativeLabel` is computed via `Intl.RelativeTimeFormat('en', { numeric:
  'auto' })`, bucketed: seconds → "now"/"Xs ago", minutes, hours, days.
  Beyond **7 days**, `relativeLabel` switches to an absolute date instead
  (e.g. `Jul 12, 2026`) — the same threshold GitHub/Twitter-style UIs use,
  chosen because it's the point where "N days ago" stops being more useful
  than a date and because this app's `RSC_INGEST_CYCLE_MINUTES`-driven
  self-pacing scheduler (a separate, unrelated feature) already means some
  feeds' items can legitimately arrive at an irregular cadence — old items
  reading as an absolute date avoids ever showing something absurd like
  "47 days ago" for a backfilled historical import.
- `absoluteLabel` (the `title` attribute) is a full locale-formatted
  date+time string (`Intl.DateTimeFormat` with `dateStyle: 'medium'`,
  `timeStyle: 'short'`), always the full precision regardless of which
  bucket `relativeLabel` is in.
- **Server-render path (no JS):** the component computes `relativeLabel`
  once at render time using the current server clock — correct at the
  moment the page was generated, static thereafter without JS. This is
  already fully functional and readable with JavaScript off; nothing more
  is needed for the no-JS case.
- **Client tick (progressive enhancement):** on mount, an adaptive
  `setInterval` (via Svelte 5 runes — `$effect` scheduling `setInterval`,
  cleaned up in the effect's teardown) recomputes `relativeLabel` and
  re-renders the text node. Interval cadence adapts to age so a stale tab
  left open for days doesn't recompute every 30 seconds pointlessly:
  - age < 2 min: every 15s
  - age < 1 hour: every 60s
  - age < 1 day: every 5 min
  - age >= 7 days (already showing an absolute date): no timer at all —
    nothing to tick, the label will never change.
  This is a genuinely new pattern in this codebase — there's no existing
  client-side ticking/interval UI component today (the app's only other
  "live" mechanism is SSE-push-driven refresh, a different mechanism for a
  different purpose: new content arriving vs. a display's own clock ticking).

### Call sites — swap all 7 (6 files)

Every one of these currently renders the identical pattern
`<a class="permalink" ...><time datetime={X.publishedAt}>{X.publishedAt.slice(0, 10)}</time></a>`
(one has a `.slice(5, 10)` MM-DD compact variant instead). Replace the
`<time>` element with `<RelativeTime datetime={X.publishedAt} />` in each,
leaving the surrounding `<a class="permalink">` wrapper untouched:

- `web/src/routes/+page.svelte:192`
- `web/src/routes/p/[publisherId]/+page.svelte:30`
- `web/src/routes/post/[id]/+page.svelte:93`
- `web/src/routes/u/[handle]/+page.svelte:102` (main list)
- `web/src/routes/u/[handle]/+page.svelte:146` (compact `MM-DD` variant —
  becomes the same `<RelativeTime>` as everywhere else; the compact-format
  special case goes away since relative text is already compact)
- `web/src/routes/u/[handle]/following/+page.svelte:143`
- `web/src/lib/ReplyTree.svelte:46`

### Styling

No new CSS tokens needed — `<RelativeTime>` renders a bare `<time>` element
in the same position the old one occupied, inheriting whatever `.permalink`
already applies. If the relative strings ("2 min ago" vs "2026-07-30") differ
enough in width to cause layout shift in any of the 7 sites, note it during
implementation but don't preemptively add width-clamping CSS — YAGNI unless
it's an actual observed problem.

## Testing

- A unit test for the bucketing/formatting logic itself (pure function,
  no DOM): given a fixed "now" and a set of input timestamps, assert the
  expected relative string at each bucket boundary (just under/over 1
  minute, 1 hour, 1 day, 7 days) — this is the one place real behavior
  needs verifying independent of rendering.
- A render test (this codebase's existing `render` from `svelte/server` +
  dynamic import pattern, e.g. `web/src/routes/admin/feeds/feeds.render.test.ts`)
  confirming the component renders a `<time>` element with the correct
  `datetime` attribute and a non-empty text label for a given fixed input
  — SSR-only, matching how `ThemeToggle` is tested elsewhere in this
  codebase (client-only ticking behavior isn't verifiable through this
  test harness, same limitation noted for `ThemeToggle`'s AccountMenu fix).
- No test changes needed at the 7 call sites themselves unless an existing
  render test asserts on the old `.slice(0, 10)` text directly (check during
  implementation; update any that do).

## Rollout

Frontend-only change, no migration, no core changes, no config. Ships in the
next web deploy alongside whatever else is queued — no special sequencing
needed.
