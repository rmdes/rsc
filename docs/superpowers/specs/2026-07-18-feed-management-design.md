# Instance Feed Management — Design

**Status:** design
**Date:** 2026-07-18
**Milestone:** Instance admin & authorization (sub-project 2 of 4)

## Context

SP1 (authorization foundation) shipped: an email-derived `isAdmin` on the
session, a `requireAdmin` gate, and `isAdmin` on `GET /me`. SP2 uses that to
govern **instance feeds**.

**Two feed types** (clarified during brainstorming):
- **Instance feeds** — federation peers: `rss.chat`, another instance's
  firehose, etc. Instance-global (one add is visible to everyone). Today these
  are the "remote users" added via `POST /users`. **Admin-managed.** ← this SP.
- **Per-user feeds** — a user subscribes to their own feeds and reads them in
  their own timeline (Textcaster as a feed reader with a social layer). A
  data-model + timeline-scoping expansion. **Its own future milestone**, not SP2.

**Sequencing decision:** ship SP2 (admin-only instance feeds) now, accepting
that regular users temporarily cannot add feeds until the per-user feed-reader
milestone lands.

**Motivating problem:** `POST /users` is currently gated by `sessionOrToken`
(any registered user OR the ops token) — on a public instance that is an
unbounded polling-cost + content-injection vector — and there is **no removal
path at all** (`DELETE /me/follows` only drops a follow relationship, never the
polled remote-user record). This surfaced concretely as a duplicate
textcaster.app subscription on the live alice/bob instances that cannot be
undone through the API.

**SP1 footgun to fix here:** SP1 threads `adminEmails` per-route into
`sessionAuth`; a new admin route written with the usual 2-arg
`sessionAuth(deps.auth, deps.users)` would compute `isAdmin` against the default
empty set and 403 real admins. SP2 fixes this permanently (below).

## Goal

Make instance feeds admin-managed and removable: an `adminOrToken` gate on
add/remove, a `DELETE` that cleanly tears a feed down, a list endpoint, a web
admin page to drive it, and the live duplicate cleanup.

## Design

### Auth: `adminOrToken` + footgun fix

Add **`adminOrToken(token, auth, users, adminEmails)`** — mirrors the existing
`sessionOrToken` but swaps `registeredOnly` for `requireAdmin`: **ops bearer
token OR an admin session** (403 for a non-admin session, 401 for no session).

**Footgun fix (folded in):** in `createApp`, bind the session middleware once —
`const authed = sessionAuth(deps.auth, deps.users, adminEmails)` — and reuse
that instance on every route that currently constructs `sessionAuth(deps.auth,
deps.users)`. Every route then carries the real `adminEmails`, so `requireAdmin`
/ `adminOrToken` always evaluate correctly and no future admin route can
silently lock out admins. Small refactor, permanent fix.

### `POST /users` — re-gated

Change its gate from `sessionOrToken` to `adminOrToken`. Behavior otherwise
unchanged (same body, same 201). This is the accepted regular-user gap.

### `DELETE /users/:handle` — remove an instance feed

`adminOrToken`-gated. Removes a remote feed via a shared **`deleteUserCascade(id)`**
storage method — the anon-sweep's existing `coreCascade` closure
(`sqlite.ts`, inside `sweepAnonymousUsers`) **hoisted to one method that both the
sweep and this route call** (one source of truth — no twin-drift when a 5th FK
table is added later). It runs the four dependent deletes **in one transaction**
(there is no DB-level `ON DELETE CASCADE`; all FKs are plain
`REFERENCES users(id)`):

```
DELETE follows            WHERE follower_id = :id OR followed_id = :id
DELETE push_subscriptions WHERE user_id = :id
DELETE posts              WHERE author_id = :id
DELETE users              WHERE id = :id
```

- **404** if the handle is unknown.
- **409** (`{ error: 'not a remote feed' }`) if the handle resolves to a
  **local** user — this route removes remote feeds only, never local accounts.
- **200** `{ ok: true }` on success.
- **Cascade semantics:** the removed feed's federated posts are deleted with it
  ("unsubscribe removes its content"). Any **local reply** to one of those posts
  survives — `in_reply_to_post_id` is not a foreign key, so the reply's
  reference simply dangles and the existing threading model orphans it honestly
  (shows "in reply to ↗"). No local data loss, no FK violation.
- **Polling stops automatically** — the poller iterates remote users; the record
  is gone.
- **Push teardown** — deleting the `push_subscriptions` rows removes our local
  record; the remote hub's lease lapses when we stop renewing, and our
  `/websub/callback/:token` already ignores pings for unknown tokens. An
  *explicit* WebSub unsubscribe to the remote hub is **deferred** (YAGNI —
  self-heals on lease expiry).

### `GET /admin/feeds` — list instance feeds

`sessionAuth` + `requireAdmin`. Returns the instance feeds for the admin UI:
`{ feeds: [{ handle, displayName, feedUrl }] }` — the remote users. No per-feed
post count (YAGNI — add it if an admin actually needs to see volume). Consistent
with SP1's `GET /admin/status`.

### Web: `/admin` — feed-management page

A new admin-only web route:
- **Load** (`+page.server.ts`): 404/redirect unless `data.me.isAdmin`; fetches
  `GET /admin/feeds` from core server-side, forwarding the admin's session
  cookie (the existing web→core `authedFetch` pattern).
- **UI:** lists each instance feed (handle, feed URL, post count) with a
  **remove** button, and an **add-feed** form (feed URL + optional handle/display
  name). Form actions proxy to core `POST /users` / `DELETE /users/:handle`,
  forwarding the session; use `fail()`/`redirect()` per SvelteKit conventions.
- **`/admin` is one plain page** (list feeds + add/remove) — not a section/panel
  container pre-built for future siblings (there's no admin scaffolding in `web/`
  yet). It grows into a section trivially when SP3/SP4 add a second thing.
  Non-admins never see it.

**UI convention (required):** this page MUST be built via the
`ui-ux-pro-max:ui-ux-pro-max` skill **and** the `ui-ux-pro-max:ui-styling`
skill, follow `design-system/textcaster/MASTER.md` (tokens/typography/spacing;
no raw hex — colors from `web/src/app.css` `--color-*`), and consult the
relevant `svelte-skills` (`sveltekit-data-flow` for the load/actions,
`svelte-runes` for any state). No bolted-on raw markup.

### Live duplicate cleanup

After SP2 deploys to the instances, remove the redundant narrow `main`
guest-feed subscription on **alice** and **bob** via `DELETE /users/main`,
keeping the firehose `textcaster` (`/users/rss.xml`) subscription — resolving the
duplicate that motivated this SP.

## Out of scope

- **Per-user feeds / feed reader** — the next milestone (data-model + per-user
  timeline scoping).
- **Explicit remote-hub WebSub/rssCloud unsubscribe** — deferred; lease expiry +
  callback-ignores self-heals.
- **Moderation** (SP3), **broader admin UI** (SP4).

## Error handling

- `adminOrToken`: token path unchanged; session path → 401 (no session) / 403
  (non-admin). Fail-closed (SP1: no admins configured → every admin path 403s).
- `DELETE`: 404 unknown handle, 409 local user, wrapped in a transaction so a
  mid-cascade failure rolls back (no half-deleted feed).
- Web admin page: non-admin load → redirect to `/` (or 404); action failures →
  `fail()` with a message shown inline.

## Testing

**Core (in-process Hono, existing style):**
- `adminOrToken`: bearer token → allowed; admin session → allowed; non-admin
  registered session → 403; anonymous → 401; no auth → 401.
- `POST /users` now requires admin/token (a plain registered session → 403).
- `DELETE /users/:handle`: removes the remote user and cascades (its posts,
  its `push_subscriptions`, follows to/from it all gone; the user gone);
  **404** unknown handle; **409** when the handle is a local user; a **local
  reply** to a removed feed's post still exists afterward (orphaned).
- `GET /admin/feeds`: admin → 200 with the feed list; non-admin → 403; anon → 401.

**Web:** the `/admin` load is admin-gated (non-admin → redirect/404); add and
remove form actions call the right core endpoints with the forwarded session.

## Open details resolved in the plan

1. Exact `adminOrToken` composition (mirror `sessionOrToken`'s manual
   `viaSession → requireAdmin` chaining, including the Hono `next` propagation
   note already documented in `auth.ts`).
2. The full list of `sessionAuth(...)` call sites to convert to the bound
   `authed` instance.
3. The `deleteUserCascade(id)` hoist from `sweepAnonymousUsers`' `coreCascade`
   closure, and the `GET /admin/feeds` repo query (list remote users).
4. Web route file layout (`web/src/routes/admin/+page.server.ts` + `+page.svelte`)
   and the `authedFetch` calls to core.
5. Whether the ops-token path on `adminOrToken` should also mark the request
   admin (it currently sets no `isAdmin`; the token routes don't read it — the
   plan confirms).

## Revisions

**Rev 1 (2026-07-18)** — folded a ponytail over-engineering review (3 cuts, all accepted):
- **Reuse over mirror:** `DELETE` now calls a hoisted `deleteUserCascade(id)`
  storage method shared with `sweepAnonymousUsers`, instead of a hand-copied
  cascade (kills the twin-drift hazard).
- **Dropped `postCount`** from `GET /admin/feeds` (YAGNI — the goal is
  list/add/remove; no `COUNT` query/column).
- **Dropped the "dedicated admin section / SP3-SP4 panels" framing** — `/admin`
  is one plain page that grows later; no premature layout abstraction.
Everything else confirmed lean (adminOrToken reuse, the footgun de-dup, the 409
local-guard trust boundary, all deferrals).
