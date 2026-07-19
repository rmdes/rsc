# Subscribe & manage web UX (SP3) — design

**Milestone:** Per-user feeds / feed-reader (sub-project 3 of 3)
**Date:** 2026-07-19 · **rev 0**
**Depends on:** SP1 engine (`8ffd69a..734d8d0`) + SP2 four-tab timeline
(`9ea04a7..483a43d`), both on main. Milestone model in
`2026-07-19-per-user-feeds-engine-design.md`; SP2 in
`2026-07-19-four-tab-timeline-design.md` (rev 3).

## Context

Core has the full self-serve engine (`POST /me/subscriptions` registeredOnly +
SSRF + cap; `GET/PATCH /admin/settings`; follow/unfollow with orphan cascade;
OPML both ways) but the web never caught up:

- The home "Add remote user" form renders for every registered user and POSTs
  to admin-only `POST /users` → non-admins get a bare 403 "admin only"
  (`web/src/routes/+page.server.ts` `addRemote`, `api.ts:135`).
- `/u/[handle]/following` conflates owner and viewer: headed "@handle's
  following," but every button acts as the logged-in viewer (the auth-note at
  `+page.svelte:54` admits it); a visitor's Unfollow click targets their own
  list while appearing to edit @handle's.
- `maxSubsPerUser` has core CRUD and zero web surface (no route, tab, or
  wrapper).
- Known SP1/SP2 review follow-ups queued for here: following-page live lens
  omits the owner (SP2 self-inclusion follow-through) and doesn't exclude
  vestigial instance follows; `subscribeByUrl` reuse mints a vestigial
  me→instance follow; OPML Case-3 lacks the feed_url-race re-resolve; reuse
  returns 201 not 200; the poller never backfills `users.display_name`, so
  subscribed feeds display as raw URLs forever.

## Decisions (this brainstorm; milestone locks not revisited)

- **Mode-switched following page.** One route: your own
  `/u/<you>/following` is the full manager; anyone else's is a read-only list
  with per-row Follow buttons that explicitly act as you.
- **Home gets a self-serve subscribe form** (URL + person/webfeed) replacing
  the broken admin-endpoint form; the full manager lives on your following
  page; admin instance-adds stay on `/admin/feeds`.
- **All four queued core touch-ups ride along:** displayName backfill,
  instance-reuse guard, OPML Case-3 re-resolve, reuse → 200.
- **Admin cap UI = new Settings tab** (`/admin/settings`), fourth `.admin-nav`
  entry.

## Design

### 1. Core touch-ups

- **`subscribeByUrl` returns `{ user, followed, created }`**
  (`core/src/domain/service.ts:161-181`). Reuse path (`:162-164`): if the
  existing row's `feedType === 'instance'`, do NOT `addFollow` — return
  `{ user, followed: false, created: false }` (instances are global; kills the
  vestigial-follow bug at source). Otherwise follow and return
  `created: false`. Create path returns `created: true`.
- **Route 201/200** (`core/src/api/app.ts:294-305`): `201` when
  `created`, else `200`. Response body unchanged plus `followed` now honest.
- **OPML Case-3 re-resolve** (`core/src/domain/opml.ts:122-134`): on mint-loop
  exhaustion, re-resolve `getRemoteUserByFeedUrl(url)`; if a concurrent create
  won, follow the winner (counts toward `followed`), else `skipped++` as
  today. Mirrors `service.ts:175-176`.
- **displayName backfill.** New repo method
  `updateDisplayNameIfUnset(userId, name)` (targeted single-column update, the
  `updateFeedUrl` pattern at `sqlite.ts:269`) that writes `display_name = name`
  **only when the current `display_name` equals the row's `feed_url`** (the
  seeded value from `subscribeByUrl`) — never clobbers admin- or profile-set
  names. Called from the ingest path where feed-level metadata (title) is
  parsed (`ingest.ts` `ingestFromFeed`/discovery, ~:228-274) when a non-empty
  feed title is present. Applies on any poll, so pre-existing URL-named rows
  heal too.

### 2. Web plumbing

- `web/src/lib/api.ts` new wrappers:
  - `subscribeToFeed(f, { url, type }: { url: string; type: 'person' | 'webfeed' })
    : Promise<{ user: TimelineEntry['author']; followed: boolean }>` —
    `POST /me/subscriptions`; non-OK throws with core's error string (429 →
    "subscription limit reached" surfaces as-is).
  - `getAdminSettings(f): Promise<{ maxSubsPerUser: number }>` —
    `GET /admin/settings`.
  - `patchAdminSettings(f, { maxSubsPerUser: number }): Promise<void>` —
    `PATCH /admin/settings`.
- **Lens extension** (`web/src/lib/lens.ts`): the `followed` kind gains an
  optional `ownerHandle`:
  `{ kind: 'followed'; followIds: Set<string>; ownerHandle?: string }`;
  `keepEvent` keeps an entry if `followIds.has(author.id) ||
  author.handle === ownerHandle`. Closes the following-page owner gap with no
  new fetches (visitor views included — the owner's id isn't otherwise
  available there). SP2's home Personal tab already has the viewer's id in
  `followIds`; it may pass `ownerHandle` too (harmless either way).

### 3. Home aside — subscribe form

`web/src/routes/+page.svelte` + `+page.server.ts`:

- Replace the "Add remote user" `<details class="panel">` with **"Subscribe to
  a feed"** for `data.me && !data.me.isAnonymous`: URL input (type=url,
  required) + radio `webfeed` (default, "a site or publication's feed") /
  `person` ("an individual's feed"), POST `?tab={data.tab}&/subscribe`,
  `form.add-remote` styling. Anon/guest branch stays "Register to add feeds."
- New `?/subscribe` action: validate non-empty URL; `authedFetch` (no mint —
  endpoint is registeredOnly); `subscribeToFeed`; on error
  `fail(400, { error })` (cap 429 and SSRF "url invalid" surface via the
  existing `form?.error` rail); on success
  `redirect(303, '/?tab=personal&feed=<user.handle>')`.
- The `addedFeed` flash copy becomes tab-aware personal-river phrasing:
  "Now following **@handle** — its posts appear in your Personal river." (The
  flash renders on the personal tab now, where the claim is true; `followed:
  false` (instance reuse) redirects to `/?tab=federated&feed=<handle>` with
  the existing federated phrasing — see open detail in §6.)
- The old `?/addRemote` action + `addRemoteUser` home usage are deleted
  (admin `/admin/feeds` keeps its own add flow; `api.ts` `addRemoteUser`
  wrapper stays — feeds page uses it).

### 4. Following page — mode-switched

`web/src/routes/u/[handle]/following/`:

- **Load:** `const { me } = await parent()`;
  `isOwner = me?.user.handle === params.handle`. Return `isOwner` and the
  fixed live-lens inputs:
  `followIds = following.filter(u => u.feedType !== 'instance').map(u => u.id)`
  plus `ownerHandle = params.handle` for the lens (§2). The full unfiltered
  `following` list still renders (instance follows visible + manageable).
- **Owner mode** (`isOwner`): heading "Your subscriptions". Panels: Subscribe
  to a feed (same form/action shape as home's §3, posting to this route's own
  `?/subscribe`), Follow someone (existing handle form), Import OPML
  (existing, registered-gate unchanged), export link. List rows: displayName +
  `@handle` + kind badge + **feedType badge** (`person`/`webfeed`/`instance`
  via the existing `.badge-kind` pill; local rows show no feedType badge) +
  Unfollow button (existing form).
- **Visitor mode:** heading "@handle follows". Read-only rows (same badges);
  each row gets a **Follow** button posting `?/follow` with `target=u.handle`
  (the existing action, `ensureSessionFetch` anon-mint preserved), labeled so
  it's clearly the viewer's action (button title/aria "Follow as you"); rows
  the viewer already follows show no button (compare against the viewer's own
  follow set — see open detail in §6). No unfollow, no import, no
  follow-by-handle form. Export link stays (public).
- **Guest:** visitor mode + the existing register CTA in place of actions?
  No — per-row Follow still works (anon mint is today's semantics). Keep it.
- The old always-on "Follow someone" panel and the misleading unfollow-on-
  visitor rendering are gone; the auth-note shrinks to the visitor-mode Follow
  buttons' "acts as you" hint.

### 5. Admin Settings tab

- `web/src/routes/admin/+layout.svelte`: fourth tab `{ href: '/admin/settings',
  label: 'Settings' }`.
- New `web/src/routes/admin/settings/+page.server.ts`: load →
  `getAdminSettings` (gate inherited from admin layout); action `save` →
  integer-validate ≥ 0, `patchAdminSettings`, return `{ saved: true }`.
- `+page.svelte`: one `.field` — label "Max subscriptions per user",
  `<input type="number" min="0">`, `.field-hint` "Self-serve subscriptions
  (person + web feeds) each registered user may hold. Default 500." — Save
  button, `use:enhance`, success/error via the existing `.notice.confirm` /
  `.error` patterns.

### 6. Errors, empty states, open details

- Subscribe errors: 429 "subscription limit reached", 400 "url invalid"
  (validation or SSRF), both via `form?.error`; the form keeps entered values
  (standard SvelteKit re-render).
- Owner with zero follows: "You're not following anything yet — subscribe
  above." Visitor of an empty list: "@handle isn't following anything yet."
- **Instance-reuse subscribe UX:** when `followed: false` (URL was an
  instance), redirect to `/?tab=federated&feed=<handle>` and flash "That's a
  connected instance — its posts are already in the Federated tab for
  everyone."
- **Visitor already-follows detection** needs the viewer's own follow set on a
  visitor page: when `me` exists and `!isOwner`, the load additionally fetches
  `getFollowing(me.user.handle)` and returns `viewerFollowIds` (ids only) to
  suppress redundant Follow buttons. Guest → no extra fetch, all rows get
  Follow.
- Core-down: pages keep their existing `coreDown` fail-soft shapes.

### 7. Testing

- **Core:** subscribeByUrl `created` flag (create vs reuse) + instance-reuse
  guard (no follow row minted; `followed: false`); route 201-vs-200; OPML
  Case-3 re-resolve (concurrent-create collision followed, not skipped);
  `updateDisplayNameIfUnset` (updates when name===feedUrl, refuses otherwise) +
  ingest backfill wiring. Existing suites stay green (`removeFollow` cascade
  etc. untouched).
- **Web (in-container):** lens `ownerHandle` unit test; home `?/subscribe`
  action tests (success redirect to personal, 429 surfaces, instance-reuse
  redirect to federated); following-page load tests (isOwner both ways,
  followIds instance-excluded, `viewerFollowIds` only when visitor+me);
  admin settings load/action tests (gate via layout untested here — inherited).
- **Gates:** `npm run -w core test` + `npm run -w core typecheck`;
  `docker compose exec -T web env -u CORE_API_URL npm test -w web` +
  `docker compose exec -T web npm run check -w web`.

## Out of scope (SP3)

- Feed-type re-tag UI (admin editing an existing row's `feed_type`), OPML
  category import/filtering, per-instance sub-filters, subscription
  search/sort/pagination, avatar harvesting — backlog/YAGNI.
- Poller-side niceties beyond the title backfill (avatars, descriptions).
