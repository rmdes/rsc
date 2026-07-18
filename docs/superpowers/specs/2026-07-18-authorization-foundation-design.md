# Authorization Foundation — Design

**Status:** design
**Date:** 2026-07-18
**Milestone:** Instance admin & authorization (sub-project 1 of 4)

## Context

Textcaster is now public (textcaster.app is live). Its identity layer is
better-auth (1.6.23: `anonymous` + `magicLink` + email/password), but there
are **no roles, no instance admin, and no access control** — every API gate is
either `sessionAuth` (any registered session) or `sessionOrToken`. So today any
confirmed account can add remote feeds (a standing polling cost + content
vector), and there is no owner concept. This sub-project establishes the
authorization keystone the rest of the admin milestone builds on.

**The milestone decomposes into four sub-projects** (each its own spec → plan →
build), dependency-ordered:

1. **Authorization foundation** — roles + instance admin + the gate *(this spec)*.
2. **Feed management + rights** — re-gate who can add/remove remote feeds;
   includes the missing "remove remote feed" endpoint and the duplicate-sub
   cleanup discovered during federation testing.
3. **Moderation** — admin removing users/posts, banning *(likely later; YAGNI
   until needed)*.
4. **Admin UI** — web surface for the above.

**Decisions locked during brainstorming:**
- Granularity: **admin + user**, built so fine-grained permissions can be added
  later via better-auth access-control without rework.
- Bootstrap: **env admin email(s)** — `TEXTCASTER_ADMIN_EMAIL`.
- Mechanism: **email-derived at session** — no stored role.

## Goal

Give core an `isAdmin` signal derived from a configurable admin-email allowlist,
a `requireAdmin` gate, and expose admin status to clients — without a stored
role, a migration, or a web admin UI. Core-only.

## Design

### Config

`TEXTCASTER_ADMIN_EMAIL` — a comma-separated list of admin email addresses.
Parsed in `core/src/config.ts` into a normalized `Set<string>` (each entry
lowercased + trimmed; empty entries dropped). Unset or empty → an **empty set**
(the instance has no admins; see fail-closed below). It is optional (unlike
`TEXTCASTER_TOKEN`/`TEXTCASTER_AUTH_SECRET`, which throw when missing).

### Derivation (the heart)

Core already resolves the authenticated better-auth user and the linked core
user in its session-auth middleware (the one that sets `coreUser` /
`sessionIsAnonymous` on the Hono context and backs `sessionAuth`). Extend it to
also compute and attach:

```
isAdmin = emailVerified === true
          && typeof email === 'string'
          && adminEmails.has(email.toLowerCase())
```

- `email` / `emailVerified` come from the resolved better-auth user.
- **Verified-only:** an account whose email matches an admin address but is not
  verified is NOT admin (belt-and-suspenders over hard email verification).
- **Anonymous sessions are never admin** (they have no email → `isAdmin` false).
- Attached to context as `isAdmin` (e.g. `c.set('isAdmin', …)`), alongside the
  existing `coreUser`.

### Gate + exposure

- **`requireAdmin` middleware** — composed after `sessionAuth`; returns
  `403 { error: 'admin only' }` when `isAdmin` is false. This is the reusable
  gate the later sub-projects apply to admin-only routes.
- **`GET /me`** gains `isAdmin` in its JSON: `{ user, isAnonymous, isAdmin }`.
  Web's layout load already fetches `/me` into `data.me`, so web becomes
  admin-aware with **no web code change** in this sub-project.
- **`GET /admin/status`** (`sessionAuth` + `requireAdmin`) — the first
  admin-gated route, both to validate the gate end-to-end and to seed the future
  admin UI. Returns `{ ok: true, adminEmails: string[] }` (the configured admin
  addresses — safe to return on an admin-only route). 200 for an admin, 403
  otherwise.

### Fail-closed default

No admin emails configured → `adminEmails` is empty → `isAdmin` is always false
→ every `requireAdmin` route returns 403 for everyone (including the owner).
This is deliberate: an instance with no configured admin has no admin surface,
rather than silently granting it. The operator opts in by setting
`TEXTCASTER_ADMIN_EMAIL`.

### Extensibility

`isAdmin` is the coarse gate for v1. Fine-grained permissions later layer on via
better-auth **access-control** (define permission statements such as `feed:add`,
`user:ban`; check `hasPermission`), with an admin implicitly holding all
permissions — the email-derived `isAdmin` remains the super-gate. This is purely
additive: no change to the derivation or the config designed here.

## API changes

| Method | Route | Auth | Change |
|---|---|---|---|
| GET | `/me` | `sessionAuth` | response gains `isAdmin: boolean` |
| GET | `/admin/status` | `sessionAuth` + `requireAdmin` | **new** → `{ ok, adminEmails }` (200 admin / 403 else) |
| — | `requireAdmin` middleware | — | **new**, reusable |

No changes to `POST /users` or any existing gate in this sub-project.

## Out of scope (deferred)

- **Re-gating `POST /users`** (feed-add policy) — sub-project 2.
- The **remove-remote-feed endpoint** + live duplicate-sub cleanup — sub-project 2.
- **Moderation** (ban/impersonate/remove) — sub-project 3.
- **Web admin UI** — sub-project 4 (web already receives `isAdmin` via `/me`).
- **Stored roles / fine-grained permissions** — future, via better-auth
  access-control; not built now.

## Testing

**Unit:**
- Admin-email parse: comma-separated, surrounding whitespace, mixed case all
  normalize to a lowercased set; unset/empty → empty set.
- `isAdmin` derivation: verified admin-email → true; unverified admin-email →
  false; verified non-admin → false; anonymous → false; empty config → false;
  multiple configured emails each resolve.

**Integration (in-process Hono, existing test style):**
- `GET /me` for an admin session includes `isAdmin: true`; for a non-admin
  registered session `isAdmin: false`; for an anonymous session `isAdmin: false`.
- `GET /admin/status` → 200 `{ ok, adminEmails }` for an admin; 403 for a
  non-admin registered session; 403 for an anonymous session; 403 when no admin
  emails are configured.

## Open details resolved in the plan

1. Exact location of the session-auth middleware and how it reads the better-auth
   user's `email` + `emailVerified` (confirm the resolved-user shape).
2. Where `requireAdmin` is defined and composed (middleware ordering after
   `sessionAuth`).
3. Test helper for minting a *verified email* session in the in-process suite
   (the derivation needs `emailVerified: true`, not just a registered user).
4. `RUNNING.md` env documentation for `TEXTCASTER_ADMIN_EMAIL`.
