# Broader Admin UI — Design

**Status:** design
**Date:** 2026-07-18
**Milestone:** Instance admin & authorization (sub-project 4 of 4)

## Context

SP1 gave an email-derived `isAdmin` + `requireAdmin` gate; SP2 shipped the
`/admin` feed-management page (list/add/remove instance feeds) + `DELETE
/users/:handle` (remote feeds only, 409 on local). SP4 grows the admin area
beyond feeds — but **read-only**: an instance overview and a "who's on this
instance" list. It adds **no destructive powers** (delete/suspend local accounts
is SP3/moderation territory) and **no runtime config editing** (config is
env-driven and immutable by design — see `core/src/config.ts`).

**Data-model facts this rests on** (verified):
- Anonymous guest ⇔ better-auth `user.isAnonymous = 1`; verified ⇔
  `user.emailVerified` (both on the better-auth `user` table in core's SQLite).
- Core `users` (kind `local`/`remote`) links to a better-auth account via
  `users.auth_user_id`; **remote feeds have `auth_user_id = NULL`**.
- `createApp`'s deps already carry `feeds { publicUrl, hubUrl, rssCloud }`,
  `mailEnabled`, `adminEmails`; it does **not** yet carry `pollSeconds`,
  the WebSub mode, or `pushIn` — SP4 threads those in for the overview.

## Goal

An admin can see the instance's shape at a glance (counts + federation/mail
status) and who has accounts or feeds on it — all read-only, behind a small
admin nav.

## Design

### Core: two read-only endpoints (both `authed` + `requireAdmin()`)

#### `GET /admin/overview`

Returns an instance snapshot:

```json
{
  "counts": { "registeredUsers": 12, "guests": 3, "remoteFeeds": 4, "posts": 210 },
  "federation": { "websub": "self", "rssCloud": true, "pushIn": true, "publicUrl": "https://…" },
  "mailEnabled": true,
  "adminEmails": ["rick@rmendes.net"],
  "pollSeconds": 60
}
```

- **`counts`** come from one new `repo.instanceStats()`:
  - `registeredUsers` = `COUNT(*) FROM user WHERE isAnonymous = 0 OR isAnonymous IS NULL` (better-auth accounts).
  - `guests` = `COUNT(*) FROM user WHERE isAnonymous = 1`.
  - `remoteFeeds` = `COUNT(*) FROM users WHERE kind = 'remote'`.
  - `posts` = `COUNT(*) FROM posts`.
- **`federation`/`mailEnabled`/`adminEmails`/`pollSeconds`** come from config, not
  queries. `feeds.rssCloud` + `feeds.publicUrl` + `mailEnabled` + `adminEmails`
  are already in `createApp` deps; SP4 adds `pollSeconds`, the WebSub `mode`
  string, and `pushIn` to deps (server.ts passes them from `config`).

#### `GET /admin/users`

Returns registered local accounts **and** remote feeds (anonymous guests
excluded — they surface as the `guests` count, not as rows):

```json
{ "users": [ { "handle": "alice", "displayName": "Alice", "kind": "local", "emailVerified": true, "createdAt": "…", "feedUrl": null }, … ] }
```

- One new `repo.listUsers()` — a single LEFT JOIN:
  ```sql
  SELECT u.handle, u.display_name, u.kind, u.created_at, u.feed_url, au.emailVerified
  FROM users u LEFT JOIN user au ON au.id = u.auth_user_id
  WHERE u.kind = 'remote'
     OR (u.kind = 'local' AND (au.isAnonymous = 0 OR au.isAnonymous IS NULL))
  ORDER BY u.created_at DESC
  ```
- Maps to `{ handle, displayName, kind, emailVerified: boolean | null, createdAt, feedUrl: string | null }` — `emailVerified` is null for remote feeds; `feedUrl` is null for locals.
- **No pagination** (YAGNI — instances are small; deferred).

### Web: sub-routes behind a shared admin layout

The `/admin` area grows from one page into a small section:

- **`web/src/routes/admin/+layout.server.ts`** — gates **all** `/admin/*`:
  `const { me } = await parent(); if (!me?.isAdmin) throw error(404)`. This moves
  the admin gate up from today's per-page load into one place. (Form actions on
  child pages are still independently protected by core's `requireAdmin`/
  `adminOrToken` — defense in depth, as SP2's review established — so the layout
  gate is for UI visibility, not the security boundary.)
- **`web/src/routes/admin/+layout.svelte`** — a small admin nav (`Overview` ·
  `Feeds` · `Users`) + `{@render children()}`.
- **`web/src/routes/admin/+page.server.ts` + `+page.svelte`** — the **new**
  overview dashboard (loads `GET /admin/overview`, renders the counts +
  federation/mail/admin/poll status).
- **`web/src/routes/admin/feeds/+page.server.ts` + `+page.svelte`** — the
  **existing SP2 feed-management page, moved here unchanged** (its `add`/`remove`
  actions + list). Its own load no longer needs the `isAdmin` gate (the layout
  covers it); it keeps forwarding the session to core.
- **`web/src/routes/admin/users/+page.server.ts` + `+page.svelte`** — the **new**
  read-only user list (loads `GET /admin/users`, renders the table).
- **`web/src/lib/api.ts`** — add `getAdminOverview(f)` and `listAdminUsers(f)`
  (mirroring `listAdminFeeds`'s style; server-side, forwarding the admin session
  via `authedFetch`).

**UI convention (required):** the overview, users, and nav MUST be built via the
`ui-ux-pro-max:ui-ux-pro-max` **and** `ui-ux-pro-max:ui-styling` skills, follow
`design-system/textcaster/MASTER.md` (tokens/typography/spacing; no raw hex —
colors from `web/src/app.css` `--color-*`), and consult the relevant
`svelte-skills` (`sveltekit-data-flow` for the loads, `svelte-runes` for state,
`svelte-template-directives` for `{@render children()}`). No-JS-functional
(plain server-rendered pages; no forms needed — everything is read-only).

## Error handling

- `/admin/overview` + `/admin/users`: `authed` + `requireAdmin()` → non-admin
  session (registered or anon) 403, no session 401 — matching SP2 rev 2 and
  `/admin/status`.
- Web layout load: non-admin / no `me` → `throw error(404)` (hide existence, no
  redirect leak — same as SP2's page gate).
- Empty instance (no users/feeds/posts): counts are 0, `users` is `[]` — pages
  render an empty state, not an error.

## Out of scope

- Any **destructive or user-management action** — delete/suspend/ban a local
  account (→ SP3 moderation; the `DELETE /users/:handle` 409-on-local boundary stays).
- **Runtime-editable instance settings** (config stays env-driven).
- **Guest-account listing** (guests are a count only).
- **Pagination** on the user list.
- App **version/build** display.

## Testing

**Core (in-process Hono, existing style):**
- `instanceStats()`: with N registered + M guests + K remote feeds + P posts
  seeded, returns exactly those counts (guests counted via `isAnonymous`, not
  listed).
- `listUsers()`: returns registered locals + remote feeds, **excludes anonymous
  guests**, `emailVerified` reflects the better-auth row (true/false for locals,
  null for remotes), `feedUrl` null for locals / set for remotes.
- `GET /admin/overview` + `GET /admin/users`: admin session → 200 with the
  expected shape; non-admin registered → 403; anon session → 403; no session → 401.

**Web:** the `/admin` layout load is admin-gated (non-admin → 404); the overview
page renders the counts/status from a stubbed `/admin/overview`; the users page
renders rows from a stubbed `/admin/users`; the nav links to all three; the moved
feeds page still works at `/admin/feeds`.
