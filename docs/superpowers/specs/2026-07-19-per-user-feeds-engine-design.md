# Per-User Feeds — SP1: Subscription Engine (core)

**Status:** design (rev 1 — clean-context security review folded)
**Date:** 2026-07-19
**Milestone:** Per-user feeds / feed-reader (sub-project 1 of 3)

## Context

Textcaster today has one timeline — the instance-wide firehose — and adding any
remote feed is **admin-only** (`POST /users` is `adminOrToken`-gated since SP2).
The "per-user feeds" milestone turns Textcaster into a feed reader with a social
layer: each registered user self-serves their own subscriptions and reads a
personal timeline, alongside local, federated, and public views.

**The milestone decomposes into three sub-projects** (each its own spec → plan →
build):
1. **Subscription engine (core)** — data model, self-serve subscribe primitive
   (capped), the four filtered timeline queries, cleanup. *(this spec)*
2. **Four-tab timeline (web)** — tab chrome + default routing + per-tab SSE filtering.
3. **Subscribe & manage UX (web)** — add-web-feed / follow-user / OPML surfaces,
   stale-form fix, subscription management, admin add-instance, **the admin
   subscription-cap setting UI**, admin feed-type re-tag.

**What already exists (verified during brainstorming + review):**
- A remote feed = a `users` row (`kind='remote'`, `feed_url`), shared
  instance-wide; N followers → one row, polled once (`runPollCycle` iterates
  `listRemoteUsers()`; posts dedup by `UNIQUE(author_id, guid)`). **Polling
  already scales per-unique-feed** — no per-user polling.
- `follows(follower_id, followed_id)` allows a local→remote edge (`addFollow`
  guards only that the *follower* is local).
- `getTimeline(limit, before?, filter?)` with `filter.followedBy` is a real,
  tested, keyset-paginated query: `author_id IN (SELECT followed_id FROM follows
  WHERE follower_id = ?)`.
- `importFollowingOpml` (`opml.ts`) already does find-or-create-remote-user
  (dedup by `feedUrl`, in-memory) + follow, `registeredOnly`-gated — and it
  **inlines** the handle slug/suffix/`HandleTakenError`-retry minting loop
  (`addRemoteUser` itself mints nothing — its handle is required).
- Every poll fetch is SSRF-guarded: `fetchFeedBody` → `checkCallbackUrl` on the
  initial URL **and every redirect hop** (rejects private/loopback via DNS).
- `deleteUserCascade` already clears (in one transaction) follows both
  directions, `push_subscriptions`, `post_revisions`, then posts, then the user.

So SP1 is **permission + a type tag + a cap + a filter expansion + cleanup** —
not new data modeling.

## Decisions locked (brainstorming + rev-1 review)

- **One mechanism + a type tag.** Remote target = `users` row + `follows` edge;
  new column **`feed_type ∈ {person, webfeed, instance}`**.
- **Permissions by type.** `person` + `webfeed` → **self-serve** (registered,
  **capped**). `instance` → **admin-only** (today's gate, relabeled).
- **Instances are global, not followed (Decision B).** Federated tab shows all
  `instance` content to everyone; follows are meaningful only for
  `person`/`webfeed`. **Personal river excludes `instance` at the query level**
  (`followedBy AND feed_type ≠ 'instance'`) — robust against any vestigial
  instance-follow edges, so the migration **does not delete follows** (rev-1: the
  earlier follow-DELETE was a data-loss risk and is dropped).
- **Data-driven classification (Decision A, revised).** The live fleet has both
  admin instances (bob/alice/rss.chat) *and* user-imported webfeeds, so a blanket
  `→instance` backfill is unsafe. Instances are exactly the Textcasting peers —
  their items carry `source:markdown` (`content_markdown`), the same signal
  `listTextcastingPeers` / the "Connected instances" panel use. The migration
  classifies each `kind='remote'` row `instance` **iff it has a post with
  `content_markdown`**, else `webfeed`. (A remote instance with zero ingested
  posts at migration time would fall to `webfeed`; rare, and admin re-tag in SP3
  fixes it.)
- **Per-user subscription cap, admin-configurable.** Self-serve subscribing is
  capped per user (default **500**), stored as an editable instance setting; the
  admin edits it in `/admin` (UI = SP3). The cap counts a user's **remote**
  (`person`/`webfeed`) subscriptions only — local-person follows add no polling
  cost and are uncapped.
- **All subscriptions public.** No private subscriptions; per-post/local privacy
  is a separate parked idea.
- **Four tabs = filters over the one pool:** Local (`source='local'`) · Federated
  (`feed_type='instance'`) · Personal river (`followedBy=me`, instance-excluded) ·
  Public river (unfiltered).

## Design

### Data model

One new `MIGRATIONS` entry:
1. `ALTER TABLE users ADD COLUMN feed_type text` (nullable; local rows stay `NULL`).
2. **Data-driven backfill:**
   ```sql
   UPDATE users SET feed_type = 'instance'
     WHERE kind='remote'
       AND EXISTS (SELECT 1 FROM posts p WHERE p.author_id = users.id
                   AND p.content_markdown IS NOT NULL);
   UPDATE users SET feed_type = 'webfeed'
     WHERE kind='remote' AND feed_type IS NULL;
   ```
3. `CREATE UNIQUE INDEX users_feed_url_idx ON users (feed_url)` — makes
   find-or-create **atomic** (closes the dedup race) and backs
   `getRemoteUserByFeedUrl`. SQLite `UNIQUE` ignores NULLs, so local rows
   (`feed_url` NULL) are unaffected — same pattern as `users_auth_user_idx`.
   **Precondition:** `POST /users` never dedup'd `feed_url`, so an admin *could*
   have created two rows with the same URL; the index build fails if so. The plan
   must first assert no duplicate `feed_url` exists (and de-dup if it does) — see
   open detail 3.
4. `CREATE TABLE instance_settings (key text PRIMARY KEY, value text)` +
   `INSERT INTO instance_settings VALUES ('max_subs_per_user', '500')` — the
   editable-settings primitive (one key today; shaped to grow, but no generic
   settings system is built beyond this — YAGNI).

Types: `UsersTable.feed_type: 'person'|'webfeed'|'instance'|null`; `User.feedType`;
`rowToUser` maps it; `NewRemoteUser.feedType` becomes required so every creation
path sets it.

### Subscribe API

**`POST /me/subscriptions` — new, mounted `authed, registeredOnly()`** (both — see
review note; `registeredOnly` alone lets a sessionless request fall through).
Body `{ url, type }`, `type ∈ {person, webfeed}` (hand-rolled enum/`isString`
validation per the `hono` skill). Steps:
1. Validate: `isString(url)` + `httpOnly(url)` + **`checkCallbackUrl(url)`**
   (reject private/loopback at add-time — don't create SSRF-target rows that
   fail-poll forever) + `type` enum.
2. **Cap check:** count the caller's remote (`person`/`webfeed`) subscriptions; if
   `>= max_subs_per_user` (from `instance_settings`), return
   `429 { error: 'subscription limit reached' }`.
3. **Find-or-create by `feedUrl`** (`getRemoteUserByFeedUrl`, UNIQUE-backed): if a
   remote row holds this `feedUrl`, reuse it (keep its `feed_type`); else create a
   `kind='remote'` row with the given `feed_type` and a **minted handle** — URL
   **host slug** + collision suffix, **no request-time fetch** (the poller fetches
   later; fetching here would reintroduce a synchronous SSRF/DoS surface).
   `displayName` = the URL until a later poll backfills it (note: the poller does
   not currently backfill *user* displayName — acceptable for SP1; a nicety for
   SP3). Extract the minting loop from `opml.ts` into a shared
   `service.subscribeByUrl` (the importer then reuses it).
4. `addFollow(me, target)` (idempotent).
5. Return `{ user, followed: true }`.

**`POST /me/follows { handle }` — unchanged** (follow an already-known
user/feed). **`POST /me/subscriptions` stays URL-only** — no handle overload.

**`POST /users` — unchanged gate (`adminOrToken`), now tags `feed_type='instance'`.**
Admin instance-add; mints no follow edge (instances are global).

**Admin cap setting:** `GET /admin/settings` + `PATCH /admin/settings
{ maxSubsPerUser }` (`sessionAuth + requireAdmin`) read/write the
`instance_settings` value. (The `/admin` UI is SP3.)

New repo reads/writes: `getRemoteUserByFeedUrl(url)`, `countRemoteSubscriptions(userId)`,
`countFollowers(userId)`, `getSetting(key)`/`setSetting(key,value)`.

### Timeline queries — the four tabs

Extend `getTimeline`'s filter to `{ followedBy?, authorId?, source?: 'local',
feedType?: 'instance' }` (last two additive `AND` clauses; `followedBy`/`authorId`
stay mutually exclusive). **The `followedBy` branch gains a standing
instance-exclusion** (`AND (users.feed_type IS NULL OR users.feed_type <>
'instance')`), so both Personal river and the existing `/u/:handle/following`
lens are instance-free by construction:

| Tab | filter | SQL added |
|---|---|---|
| Local | `{ source: 'local' }` | `AND posts.source='local'` |
| Federated | `{ feedType: 'instance' }` | `AND users.feed_type='instance'` (join present) |
| Personal river | `{ followedBy: me }` | `author_id IN (follows…) AND feed_type<>'instance'` |
| Public river | `{}` | none |

`GET /timeline` gains optional `source=local` / `feed_type=instance` params,
composable with `before`/`followed_by`. (SP2 owns tab UI + default routing.)

### Last-unfollow cleanup

`service.removeFollow` orchestrates: remove the edge, then **if `target.feedType ∈
{person, webfeed}` and `countFollowers(target)==0`, `deleteUserCascade(target.id)`**
(stops polling an orphaned self-serve feed). **`instance` rows are never
auto-cleaned.** `ponytail:` synchronous on-unfollow cleanup; add a periodic sweep
only if unfollow-race orphans are ever observed.

## API changes

| Method | Route | Auth | Change |
|---|---|---|---|
| POST | `/me/subscriptions` | `authed, registeredOnly` | **new** — capped self-serve `{url, type∈{person,webfeed}}` → validate+SSRF-check, find-or-create (dedup), follow |
| POST | `/users` | `adminOrToken` | tags created row `feed_type='instance'` |
| DELETE | `/me/follows/:target` | `authed` | cascades: last-follower of a `person`/`webfeed` → `deleteUserCascade` |
| GET | `/timeline` | — | optional `source=local`, `feed_type=instance` params; `followed_by` now instance-excluded |
| GET/PATCH | `/admin/settings` | `requireAdmin` | **new** — read/set `max_subs_per_user` |

## Out of scope (SP1)

- **All web work** — four-tab UI, default routing, subscribe/manage surfaces, the
  stale add-feed form fix, the admin cap-setting UI, admin feed-type re-tag — SP2 + SP3.
- **Private subscriptions** (scrapped) and **per-post/local privacy** (parked).
- **Residual (pre-existing, noted):** `deleteUserCascade` deletes the orphaned
  feed's posts; `posts.in_reply_to_post_id` has no FK, so a local reply to one of
  those becomes a dangling (honestly-orphaned) pointer — already true of admin
  `removeRemoteFeed`, just made routine by self-serve unfollow. No new fix here.

## Testing (in-process; core tests in `core/test/`)

- **Migration:** fresh DB reaches the new version; a remote row **with** a
  `content_markdown` post → `instance`; a remote row **without** → `webfeed`;
  local rows → `NULL`; `UNIQUE(feed_url)` rejects a second row with the same url;
  `instance_settings` seeded `max_subs_per_user=500`. (Follows are **not**
  deleted — a follow of a local user survives.)
- **Subscribe:** `{url,type:'webfeed'}` creates a `webfeed` row + follow; a second
  subscribe to the same url reuses the row (no dup) and still follows;
  `type:'person'` tags `person`; anonymous/unregistered → 403; bad url/type → 400;
  a private/loopback url → 400 (checkCallbackUrl); at `max_subs_per_user` → 429.
- **Instance add:** `POST /users` tags `instance`, no follow edge.
- **Timeline filters:** seed local posts + a followed `webfeed` + an `instance`;
  Local → only `source='local'`; Federated → only `instance`-authored; Personal
  river (`followedBy=me`) → the webfeed (+ any followed person) but **not** the
  instance even if a stale instance-follow exists; Public river → everything.
- **Cleanup:** unfollow sole follower of a `webfeed` → row `deleteUserCascade`d;
  another follower remains → kept; unfollow an `instance` → kept.
- **Admin cap:** `PATCH /admin/settings` sets the value; non-admin → 403; the new
  value is enforced on the next subscribe.

## Open details resolved in the plan

1. **Handle minting** — extract the slug/suffix/`HandleTakenError`-retry loop from
   `opml.ts` into `service.subscribeByUrl`; mint from URL **host slug only, no
   request-time fetch**; collision-suffix against `users.handle UNIQUE`.
2. Exact migration version number (depends on `MIGRATIONS.length` at build time).
3. **`UNIQUE(feed_url)` precondition** — assert (and de-dup if needed) that no two
   existing rows share a `feed_url` before creating the index; `POST /users` never
   enforced it. Live fleet likely clean, but the plan must guard the index build.
4. Exact cap-count query (`countRemoteSubscriptions` = follows where target
   `kind='remote'`) and the `/admin/settings` endpoint/body shape.

## Rev 1 — clean-context security review, folded (2026-07-19)

Independent opus review; four decisions taken with the maintainer, plus verified corrections:
- **Cap (security headline):** self-serve was uncapped → a single account could
  create thousands of feeds and choke the serial 10s-timeout poll loop. Added a
  **per-user cap**, admin-configurable via a new `instance_settings` store.
- **Migration data-loss:** the blanket `→instance` backfill + follow-DELETE would
  have mislabeled and silently unfollowed users' OPML-imported webfeeds (the live
  fleet has ~2). Replaced with **data-driven classification** (`content_markdown`
  = Textcasting-peer signal) and **dropped the follow-DELETE** entirely; Personal
  river excludes instances at the query level instead.
- **Dedup race:** `feed_url` had no uniqueness → concurrent subscribes duplicate.
  Added `UNIQUE(feed_url)` (also backs the lookup; retired the low-value
  `feed_type` index).
- **Handle minting:** corrected — `addRemoteUser` mints nothing; the loop is
  inlined in `opml.ts` and must be extracted. Mint from host slug, **no
  request-time fetch** (the reviewer's "fetch for title" would add a synchronous
  SSRF surface).
- **Mounting** `authed, registeredOnly()`; **SSRF check at subscribe** (not just
  scheme); stale "post-SP3 revisions" wording fixed (`deleteUserCascade` clears
  them now); dangling-reply residual noted; the fold-follow-by-handle open detail
  dropped as noise.
