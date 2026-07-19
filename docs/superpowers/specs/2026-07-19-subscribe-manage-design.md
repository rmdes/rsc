# Subscribe & manage web UX (SP3) — design

**Milestone:** Per-user feeds / feed-reader (sub-project 3 of 3)
**Date:** 2026-07-19 · **rev 2** (rev 1: clean-context correctness — 13
findings — + ponytail — 8 cuts; rev 2: parallel-session pass on the rev-1
folds — S1 guard mechanism, S2 minted-boolean counts, S3 self-follow, S4/S6/S7
scoping, S8 count; see
`../reviews/2026-07-19-subscribe-manage-spec-review.md`)
**Depends on:** SP1 engine (`8ffd69a..734d8d0`) + SP2 four-tab timeline
(`9ea04a7..483a43d`), both on main. Milestone model in
`2026-07-19-per-user-feeds-engine-design.md`; SP2 in
`2026-07-19-four-tab-timeline-design.md` (rev 3).

## Context

Core has the full self-serve engine (`POST /me/subscriptions` registeredOnly +
SSRF + cap; `GET/PATCH /admin/settings`; follow/unfollow with orphan cascade;
OPML both ways) but the web never caught up:

- The home "Add remote user" form renders for every registered user and POSTs
  to admin-only `POST /users` → non-admins get a bare 403 "admin only".
- `/u/[handle]/following` conflates owner and viewer: headed "@handle's
  following," but every button acts as the logged-in viewer (auth-note at
  `following/+page.svelte:54` admits it); a visitor's Unfollow click targets
  their own list while appearing to edit @handle's.
- `maxSubsPerUser` has core CRUD and zero web surface.
- Queued review follow-ups land here: following-page live lens omits the owner
  and doesn't exclude vestigial instance follows; vestigial instance follows
  can be minted by `subscribeByUrl` reuse AND OPML Case-1; OPML Case-3 lacks
  the feed_url-race re-resolve; reuse returns 201 not 200; the poller never
  backfills `users.display_name` (self-serve feeds display as raw URLs
  forever); `subscribeByUrl` has no local-URL resolve, so pasting a
  same-instance feed URL (even your own) mints a remote shadow that
  re-ingests duplicate posts.

## Decisions (this brainstorm; milestone locks not revisited)

- **Mode-switched following page.** One route: your own
  `/u/<you>/following` is the full manager; anyone else's is a read-only list
  with per-row Follow buttons that act as you (existing auth-note covers the
  semantics).
- **Home gets a self-serve subscribe form** (URL + person/webfeed) replacing
  the broken admin-endpoint form; admin instance-adds stay on `/admin/feeds`.
- **Core ride-alongs (5):** displayName backfill; central follow guard
  (instance targets AND self-follows, via a shared helper every minting path
  uses — rev 2); OPML Case-3 re-resolve; reuse → 200; local-URL resolve in
  `subscribeByUrl` (rev 1, from review F1).
- **Admin cap UI = new Settings tab** (`/admin/settings`).

## Design

### 1. Core touch-ups

- **Central follow guard, as a shared helper** (rev 2, S1/S2/S3 — rev 1's
  "guard in `service.addFollow`" did NOT cover `subscribeByUrl`, whose reuse/
  race-winner/create paths call `repo.addFollow` directly at
  `service.ts:164,176,179`). Mechanism: one private helper
  `followUnlessExcluded(followerId, target): boolean` — mints the edge and
  returns `true` unless the target's `feedType === 'instance'` (global —
  Decision B) **or** `target.id === followerId` (self-follow guard, S3), in
  which case it mints nothing and returns `false`. EVERY minting path routes
  through it: `service.addFollow` (public API — `POST /me/follows` stays
  `200 {ok:true}` on a no-op, idempotent semantics), all three `subscribeByUrl`
  call sites, OPML Case-1 (`opml.ts:103-106`), and the OPML re-resolve winner.
  The **returned boolean is load-bearing** (S2): OPML counts branch on it
  (`minted → followed++, subCount++; else skipped++`) — `addFollow`'s current
  void return makes the counts unimplementable otherwise.
- **`subscribeByUrl` returns `{ user, followed, created }`**
  (`service.ts:161-181`; sole consumer is the route — OPML has its own deps,
  verified). Order of resolution:
  1. **Local-URL resolve** (rev 1, F1): if the URL matches this instance's own
     minted feed pattern (`localHandleForUrl`, as OPML Case-2 does at
     `opml.ts:69-76`) → follow that local user via the guard helper, return
     `{ user, followed: minted, created: false }`. No remote shadow row.
     **Your own URL** (rev 2, S3): the self-guard makes `followed: false` —
     no self-edge, no double-sourcing against SP2's self-inclusive river.
     **Scoping (S4):** `localHandleForUrl` requires `TEXTCASTER_PUBLIC_URL`;
     without it (dev/docker) the resolve never matches and the shadow-mint
     persists — accepted, dev-only exposure (prod Cloudron sets it).
  2. Reuse by `getRemoteUserByFeedUrl`: guard helper →
     `{ user, followed: minted, created: false }` (instance reuse mints
     nothing).
  3. Create path as today → `created: true` (its follow also routes through
     the helper — a fresh person/webfeed row always mints).
- **Route 201/200** (`app.ts:294-305`): `201` when `created`, else `200`.
  Body gains honest `followed`. (Note: `subscribe.test.ts:77` uses strict
  `toEqual({user, followed:true})` — gains `created`; `subscriptions-api.test.ts`
  already accepts `[200, 201]`.)
- **OPML Case-3 re-resolve** (`opml.ts:114-137`): `ImportDeps` gains
  `getRemoteUserByFeedUrl` (wired at `app.ts:274-286`); on mint-loop
  exhaustion re-resolve — if a concurrent create won, follow the winner via
  the guard helper and branch on its boolean (`minted → followed++,
  subCount++; else skipped++` — an instance winner mints nothing). Else
  `skipped++` as today. Case-1's unconditional `followed++; subCount++` gains
  the same branch (S2).
- **displayName backfill.** `parseFeedWithMeta` (`ingest.ts:87-131`) returns
  feed-level `title` alongside `{items, discovery}` (all four format
  branches). New repo method `updateDisplayNameIfUnset(userId, name)`
  (targeted single-column update, `updateFeedUrl` pattern — `sqlite.ts:108`)
  writing `display_name = name` **only when current `display_name` equals the
  row's current `feed_url`** (the seeded value — exact equality verified:
  `service.ts:167-168`, `opml.ts:119`). Called from `ingestRemoteUser` and
  `ingestViaDiscovery` when a non-empty title is present; **in the discovery
  pass the backfill runs BEFORE `updateFeedUrl`** (rev 1, F3 — R1 rewrites
  `feed_url` to the discovered URL, which would break the equality guard
  forever). WebSub fat-ping feeds (`push-in.ts:224-225`) heal on their
  every-10th-tick full poll — accepted, not wired separately. Applies on any
  poll, so pre-existing URL-named rows heal too — **scoped (S6): only rows
  never discovery-rewritten**; a row whose `feed_url` was rewritten pre-ship
  has `display_name ≠ feed_url` forever and stays stranded (cosmetic; backlog
  one-time heal query, YAGNI). **The h-feed/mf2 discovery branch is out of
  scope (S7)** — `discoverFeed` returns no feed-level title
  (`ingest.ts:275-278` never calls `parseFeedWithMeta`); h-card/author-name
  harvesting is backlog.

### 2. Web plumbing

- `web/src/lib/api.ts` new wrappers:
  - `subscribeToFeed(f, { url, type }: { url: string; type: 'person' | 'webfeed' })
    : Promise<{ user: TimelineEntry['author']; followed: boolean }>` —
    `POST /me/subscriptions`; non-OK throws core's error string (429 →
    "subscription limit reached" surfaces as-is).
  - `getAdminSettings(f): Promise<{ maxSubsPerUser: number }>`.
  - `patchAdminSettings(f, body: { maxSubsPerUser: number }): Promise<void>`.
- **No lens change** (rev 1, ponytail): the following page's own `onPost`
  gains one inline disjunct —
  `keepEvent(entry, lens) || entry.author.handle === data.handle` — closing
  the owner gap with `lens.ts` untouched and no new fetches.

### 3. Home aside — subscribe form

`web/src/routes/+page.svelte` + `+page.server.ts`:

- Replace the "Add remote user" `<details class="panel">` with **"Subscribe to
  a feed"** for `data.me && !data.me.isAnonymous`: URL input (type=url,
  required) + radio `webfeed` (default, "a site or publication") / `person`
  ("an individual"), POST `?tab={data.tab}&/subscribe`, `form.add-remote`
  styling. Anon/guest branch stays "Register to add feeds."
- New `?/subscribe` action: validate non-empty URL + type ∈
  {person, webfeed}; `authedFetch` (no mint — endpoint is registeredOnly);
  `subscribeToFeed`; on error `fail(400, { error })` (cap 429 and SSRF "url
  invalid" surface via the existing `form?.error` rail, re-rendering on the
  origin tab since the action URL carries `?tab=`). Success redirects (rev 2,
  S3 — three outcomes, branched on fields the response already carries; the
  deliberate exception to SP2's tab-preserving redirects, because the landing
  tab must be where the outcome is visible; failure re-renders stay
  tab-preserving):
  - `followed: true` → `/?tab=personal&feed=<handle>` + flash.
  - `followed: false`, `user.feedType === 'instance'` → `/?tab=federated`
    (no `feed` param, no flash — the instance's content on screen is the
    explanation).
  - `followed: false`, `user.kind === 'local'` (your own URL) →
    `/?tab=personal` (no flash — your posts are already there; nothing
    changed, nothing claimed).
- One flash string (rev 1, ponytail): "Now following **@handle**." — rendered
  only on actual follows; replaces the current "its posts appear in your
  timeline" copy.
- The old `?/addRemote` action and its three `page.actions.test.ts` tests are
  deleted (`api.ts` `addRemoteUser` stays — `/admin/feeds` uses it).

### 4. Following page — mode-switched

`web/src/routes/u/[handle]/following/`:

- **Load:** `const handle = params.handle.toLowerCase()` (rev 1, F2 — handles
  are stored lowercase and core lowercases route params; a mixed-case URL must
  not silently demote the owner to visitor mode). `const { me } = await
  parent(); isOwner = me?.user.handle === handle`. Return `handle` (lowercased
  — the `onPost` disjunct compares against it), `isOwner`, and
  `followIds = following.filter(u => u.feedType !== 'instance').map(u => u.id)`
  (instance exclusion fix). The full unfiltered `following` list still renders.
- **Owner mode** (`isOwner`): heading "Your subscriptions". Panels: Subscribe
  to a feed — the form posts **cross-route to the home action**
  (`action="/?/subscribe"`; one action, one error rail, an error re-renders on
  home where the same form lives), Follow someone (existing handle form),
  Import OPML (existing gates), export link. List rows: displayName +
  `@handle` + kind badge + an **`instance` badge only** on instance rows
  (`.badge-kind`; person/webfeed carry no behavioral difference a row-reader
  needs) + Unfollow (existing form — unfollowing a vestigial instance follow
  is the cleanup path).
- **Visitor mode:** heading "@handle follows". Read-only rows (same badges);
  every row gets a **Follow** button posting the existing `?/follow`
  (`ensureSessionFetch` anon-mint preserved; `addFollow` is idempotent
  `onConflict doNothing` and the instance guard no-ops instance rows, so
  redundant clicks are harmless — no viewer-follow-set fetch). No unfollow, no
  import, no follow-by-handle form. Export link stays (public). The existing
  auth-note carries the "acts as you" semantics.
- Live lens: `keepEvent(entry, { kind: 'followed', followIds }) ||
  entry.author.handle === data.handle` (§2).

### 5. Admin Settings tab

- `web/src/routes/admin/+layout.svelte`: fourth tab
  `{ href: '/admin/settings', label: 'Settings' }`.
- New `web/src/routes/admin/settings/+page.server.ts`: load →
  `getAdminSettings` (404-hide gate inherited from `admin/+layout.server.ts`);
  action `save` → integer ≥ 0 validation, `patchAdminSettings`,
  `{ saved: true }`.
- `+page.svelte`: one `.field` — label "Max subscriptions per user",
  `<input type="number" min="0">`, `.field-hint` "Self-serve subscriptions
  (person + web feeds) each registered user may hold. Default 500." — Save
  button, `use:enhance`, `.notice.confirm` / `.error` feedback.

### 6. Errors and empty states

- Subscribe: 429 "subscription limit reached", 400 "url invalid" (validation
  or SSRF) via `form?.error`; failure re-renders keep the origin tab.
- OPML import result copy gains a skip hint: "N skipped (unfetchable,
  duplicate, or over your subscription cap)" — the import path never errors on
  cap, it silently skips (review F11).
- Known + accepted (documented, not built): `POST /me/follows` on an existing
  person/webfeed row is uncapped yet counts toward `countRemoteSubscriptions`
  — a determined user can exceed the cap via visitor-page Follow buttons and
  then hit 429 on the next URL subscribe (review F10; gate later if abused).
- Owner with zero follows: "You're not following anything yet — subscribe
  above." Visitor of an empty list: "@handle isn't following anything yet."
- Core-down: pages keep their existing `coreDown` fail-soft shapes.

### 7. Testing

- **Core:** guard helper — instance target and self target both mint nothing
  and return `false`, normal target mints and returns `true`; `/me/follows` on
  an instance handle still 200s; **all three `subscribeByUrl` call sites route
  through it** (S1 — test: pasted instance URL mints NO follow row);
  `subscribeByUrl` — local-URL resolve (other local user `followed:true`; OWN
  URL `followed:false`, no self-edge; no remote row created either way), reuse
  vs create `created` flag; route 201-vs-200; OPML Case-3 re-resolve (raced
  winner minted + cap-counted; instance winner skipped) and Case-1 branch on
  `minted`; `updateDisplayNameIfUnset` (updates when name===feedUrl, refuses
  otherwise) + backfill-before-updateFeedUrl ordering in the discovery pass +
  `parseFeedWithMeta` title extraction. Amend `subscribe.test.ts:77` (strict
  `toEqual` gains `created`) and `repository-contract.ts:276`'s "self-follow
  is allowed" documentation/assertion if the guard moves that behavior to the
  service layer (repo stays permissive; service refuses — state which layer
  the contract describes).
- **Web (in-container):** home `?/subscribe` action tests (success →
  personal redirect + flash, instance-reuse → federated no-flash redirect,
  own-URL → personal no-flash redirect, 429 surfaces, invalid type rejected);
  the **four** deleted `addRemote` tests removed (S8 —
  `page.actions.test.ts:66,74,81,107`);
  following-page load tests (isOwner incl. mixed-case URL, followIds
  instance-excluded); admin settings action test (validation + PATCH call).
  No lens unit test (lens unchanged); no admin-settings load test (one-line
  passthrough).
- **Gates:** `npm run -w core test` + `npm run -w core typecheck`;
  `docker compose exec -T web env -u CORE_API_URL npm test -w web` +
  `docker compose exec -T web npm run check -w web`.

## Out of scope (SP3)

- Feed-type re-tag UI, OPML category import/filtering, per-instance
  sub-filters, subscription search/sort/pagination, avatar harvesting,
  capping `POST /me/follows` (documented above) — backlog/YAGNI.
- Fat-ping-path displayName wiring (heals via the periodic full poll).
