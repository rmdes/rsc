# Four-tab web timeline (SP2) — design

**Milestone:** Per-user feeds / feed-reader (sub-project 2 of 3)
**Date:** 2026-07-19
**Depends on:** SP1 engine (commits `8ffd69a..734d8d0` on main) — see
`2026-07-19-per-user-feeds-engine-design.md` for the milestone model.

## Context

SP1 shipped the headless engine: `feed_type ∈ {person, webfeed, instance}` on
remote users, self-serve `POST /me/subscriptions`, and `GET /timeline` filters
`source=local` / `feed_type=instance` composable with `followed_by` (which now
excludes instances at the query level — Decision B). The web home (`/`) is
still the unfiltered firehose: `+page.server.ts` calls `getTimeline({ before })`
with no filter; the only home query params are `?before` (cursor) and `?feed`
(add-remote flash).

SP2 makes the home tabbed. Locked decisions (milestone brainstorm — not
re-litigated here):

- **Four tabs = filters over the one shared pool:** Local (`source=local`) ·
  Federated (`feed_type=instance`) · Personal river (`followed_by=me`,
  instances excluded server-side) · Public river (unfiltered).
- **Default tab:** registered → Personal river; guest/anon → Public river.
  ("Me" is the profile page `/u/<handle>`, not a tab.)
- All subscribe/manage surfaces, the stale add-remote form fix, admin cap UI,
  and feed-type re-tag are **SP3**.

Decisions made in this brainstorm:

- **All four tabs get live SSE prepends** — includes the small core change
  adding `author.feedType` to timeline entries (the follow-up SP1's ledger
  earmarked); Federated live-filtering is blocked on exactly that field.
- **Tabs are `?tab=` on `/`** — single route, one load function, composes with
  `?before`; no new routes, no redirect hop, no-JS-first real links.

## Grok findings the design leans on

- Core `/timeline/stream` is firehose-only (no filter params); per-tab live
  filtering must be client-side, like the existing per-route lenses
  (`web/src/lib/lens.ts`: author/followed/thread).
- `author.feedType` is absent from all client-facing entries: `joinedRowToEntry`
  (`core/src/storage/sqlite.ts:36-41`) omits it and its `JoinedRow` input has no
  `u_feed_type`; five joined select sites feed it — `getTimeline` (~:226),
  `getTimelineAfter` (~:252, SSE replay), `getRecentLocalPosts` (~:285),
  `getThread` (~:309), `listRepliesByPostId` (~:411). Live-post emission
  (`bus.emitNewPost` from `createLocalPostAs`/`editLocalPost`/ingest) carries a
  full `User` author, which already includes `feedType`.
- `listFollowing` (`sqlite.ts:197-206`) returns **all** follows unfiltered —
  local users (`feedType` null) and any vestigial instance follows included —
  and its select does carry `feed_type`. The web wrapper (`getFollowing`,
  `web/src/lib/api.ts:54-58`) types the result without `feedType`, discarding it.
- `LiveTimeline.svelte` mounts only when `isFirstPage`; the home's `onPost`
  currently accepts every event (no lens). Edits ride the same `post` SSE event
  (`mergeIncoming`, `web/src/lib/live.ts`); deletes are not streamed.
- Anonymous users are real sessions with follow graphs (`me.isAnonymous`);
  guests have `me == null`.
- MASTER.md (no page override exists): no-JS first-class (tabs = real links,
  active state SSR-rendered, no JS-added classes), jank-free prepends (tab bar
  must not shift), local/remote badge never dropped, both themes independently,
  42rem single column, 150–300ms transitions, visible focus states, ≥4.5:1
  contrast on active and inactive tab text.

## Design

### 1. Core: `author.feedType` on entries

In `core/src/storage/sqlite.ts`: add `'users.feed_type as u_feed_type'` to the
five joined select lists above; add `u_feed_type: string | null` to `JoinedRow`;
add `feedType: r.u_feed_type` (cast to `FeedType | null`) in
`joinedRowToEntry`'s author literal. Every `/timeline`, thread, reply, and SSE
entry then carries `author.feedType`. No route or service changes.

### 2. Web plumbing

- `web/src/lib/api.ts` `getTimeline` opts gain `source?: 'local'` and
  `feedType?: 'instance'`; two more `params.push(...)` lines in the manual
  query builder (keep `encodeURIComponent` style — cursor `~` caveat).
- `web/src/lib/types.ts`: author gains
  `feedType?: 'person' | 'webfeed' | 'instance' | null`. (`getFollowing`'s
  return type is the author type, so the follows list picks this up too.)

### 3. Home load — tab routing

`web/src/routes/+page.server.ts`:

- `tab = url.searchParams.get('tab')`; valid values
  `local | federated | personal | public`. Missing or invalid → the viewer's
  default: **registered → `personal`, anon/guest → `public`** (`me` comes from
  the layout load via `await parent()` — no duplicate `getMe` fetch).
- Tab → filter: `local → { source: 'local' }` · `federated →
  { feedType: 'instance' }` · `personal → { followedBy: me.user.handle }` ·
  `public → {}`.
- `tab === 'personal'`:
  - guest (`me == null`) → skip the timeline call; return an
    empty timeline + a flag the page renders as a "log in to build your
    personal river" empty state.
  - otherwise → `getTimeline({ before, followedBy })` in parallel with
    `getFollowing(me.user.handle)`; return
    `followIds = following.filter(u => u.feedType !== 'instance').map(u => u.id)`
    for the live lens (vestigial instance follows must not leak into the
    client-side filter; server-side `followed_by` already excludes them).
- Return `tab` (resolved, not raw) so the page renders `aria-current` and the
  pagination link server-side.
- The "Older posts" link becomes `/?tab=<tab>&before=<cursor>` — the resolved
  tab is always explicit in paginated URLs (never omitted as "default"), so
  they stay stable if auth state changes.
- `?feed` flash and `getPeers` widget unchanged.

### 4. Tab bar

Inline `<nav class="tabs" aria-label="Timeline">` in `+page.svelte` (single
consumer — no component file), placed at the top of `<main>`, above the
timeline, inside the 42rem measure. Four real links `/?tab=…` in fixed order
Local · Federated · Personal · Public, always all visible to every viewer.

- Active tab: SSR `aria-current="page"`; styled via `[aria-current]` selector —
  `--color-foreground` text + 2px `--color-accent` underline.
- Inactive: `--color-secondary` (matches `.subnav`), hover surface
  `--color-muted`, `cursor: pointer`, no layout-shifting hover.
- Focus: the standing ring pattern
  (`box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-ring) 15%, transparent)`).
- 150–300ms color/border transitions; fixed height so live prepends below
  never move it; verified in both themes; contrast ≥4.5:1 both states.
- No new color tokens, no raw hex.

### 5. Live filtering per tab

`web/src/lib/lens.ts` gains two kinds:

```ts
| { kind: 'source'; source: 'local' }      // entry.source === source
| { kind: 'feedType'; feedType: 'instance' } // entry.author.feedType === feedType
```

Home maps the active tab to a lens: local → `source`, federated → `feedType`,
personal → `{ kind: 'followed', followIds }` (existing kind, instance-filtered
set from the load), public → no lens (keep all). `onPost` runs
`keepEvent(entry, lens)` before `mergeIncoming`, exactly like the author/thread
pages. Notes:

- Edit events pass the same lens their post did (same author/source), so edit
  overlay behavior is unchanged; `mergeIncoming`'s stale-edit drop still
  applies after the lens.
- Tab switches are full navigations, so `live`/`edited`/wedge state resets
  naturally; `LiveTimeline` keeps mounting only on `isFirstPage`.

### 6. Errors and empty states

- Core down: unchanged (`coreDown` banner, empty timeline).
- Invalid `?tab` → viewer default, no error (UI param, not an API).
- Personal, registered/anon, zero follows → empty state: "Your personal river
  is empty — follow people and feeds to fill it," linking to
  `/u/<handle>/following` (the existing manage surface; SP3 replaces it with
  richer subscribe UX).
- Personal, guest → login/register CTA empty state (links to `/login`,
  `/register`).
- Federated with no instances / Local with no posts → the existing "empty
  timeline" rendering; no special copy.

### 7. Testing

- **Core** (`npm run -w core test`): extend timeline HTTP tests to assert
  `author.feedType` is present and correct on `/timeline` entries (instance vs
  webfeed vs local-null) — also closes SP1's deferred "no HTTP-layer test for
  source/feed_type params" minor. Thread/replies sites covered by asserting on
  one thread fetch.
- **Web** (in-container): load-function tests — tab→filter mapping (spy on
  `getTimeline` args), default resolution per auth state (registered/anon/
  guest), guest-on-personal skips the fetch, invalid tab falls to default,
  older-link tab threading, `followIds` excludes instance follows. Lens unit
  tests for the two new kinds. Existing drift-canary and page tests untouched.
- **Gates:** `npm run -w core typecheck` + `docker compose exec -T web npm run
  check -w web` (type-stripping means vitest alone proves nothing).

## Out of scope (SP2)

- Subscribe & manage surfaces, stale add-remote-form fix, admin cap UI,
  admin feed-type re-tag, OPML UX — **SP3**.
- Feed-type badges on timeline entries (UI legibility beyond the existing
  local/remote badge) — SP3 if wanted; `author.feedType` is now available.
- Server-side SSE filter params, tab persistence (cookie), Federated
  per-instance sub-filters — YAGNI until asked for.
