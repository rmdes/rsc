# Multi-session (account switching) — design

**Date:** 2026-07-19
**Status:** approved (design, rev 3); ready for implementation plan
**Revisions:**
- rev 1 (2026-07-19) — folded cold ponytail-review
  (`…-multi-session-review.md`): `maximumSessions` rationale; `/accounts` page
  kept over the fold-into-/settings option.
- rev 2 (2026-07-19) — folded the high-effort spec review
  (`docs/superpowers/reviews/2026-07-19-multi-session-spec-review.md`, M1–M10,
  every claim verified against the installed 1.6.23 source). Corrects two
  central claims that don't survive contact with the plugin: guests DO enter the
  session set (M1 → web-layer `isAnonymous` filter + slot accounting) and
  `revoke` auto-promotes `validSessions[0]` arbitrarily (M2 → deterministic
  `set-active(next)` then `revoke(old)` — **rev 1's single-`/revoke` logout was
  itself wrong**). Plus M3 (list is GET), M4 (guard on `isAnonymous`), M5 (no raw
  tokens in forms), M6 (behavioral tests belong in core), M7 (CSRF rests on
  SameSite=Lax), M8 (no active flag), M9 (core typecheck is green), M10 (re-mint
  only on writes).
- rev 3 (2026-07-19) — folded the rev-2 re-review's residual R1: the "no
  registered account remains" logout branch must call `signOut` (revoke-all),
  NOT `revoke(activeToken)` — the latter hits the very `validSessions[0]`
  auto-promote M2 documents and would promote a **lingering guest** to active
  (routine here: hard email-verify mints the session on the verify-click GET,
  not a `/sign-in/*` route, so the anonymous plugin's guest-deletion hook never
  fires on sign-up — the guest `_multi-` cookie survives). Decision 1 softened
  accordingly.
**Building block:** better-auth `multiSession()` plugin (promoted from `ideas.md`
2026-07-19 audit)

## Goal

Let one browser hold several **registered** accounts on the same instance and
switch the active one without logging out. Concrete use case: the instance
admin keeps a separate everyday account and switches between the admin identity
and their normal one (registered ↔ registered).

## Decisions (from brainstorm)

1. **Registered-only (enforced at the web layer).** The anonymous-guest flow
   (first-visit auto-mint + `onLinkAccount` carry-over) is untouched. But the
   plugin's after-hook matcher is `() => true`, so it DOES mint a `_multi-`
   cookie for the guest — a guest is present in `listDeviceSessions` (M1). We
   keep it out of the *switcher*, not out of the set: the `/accounts` load
   filters `isAnonymous` entries, and `maximumSessions` is sized to leave room
   for a lingering guest slot. Combined with the deterministic logout
   (decision 3), the guest is never rendered and **never promotable by our
   flows** — the only revoke-of-the-active-session we ever issue is `signOut`
   (revoke-all), which has no promote path; every other switch/logout targets a
   chosen *registered* session. So the `onLinkAccount` collision never arises.
   (A guest routinely lingers in the set: hard email-verify mints the session on
   the verify-click GET, not a `/sign-in/*` route, so the anonymous plugin's
   guest-deletion hook never fires on sign-up.)
2. **Server-driven, no client SDK.** Driven through the existing `/api/auth/*`
   proxy + SvelteKit form actions — **not** better-auth's `multiSessionClient`.
   The client SDK would require JS and break both the no-client-SDK architecture
   and no-JS-first.
3. **Per-account logout + explicit log-out-all.** "Log out" switches to a chosen
   *registered* held account then revokes the old one (deterministic — see M2 in
   the Web section); if none remain, it falls back to the normal signed-out
   state. A separate "Log out of all accounts" revokes everything (Gmail-style
   switcher).
4. **UI:** a dedicated `/accounts` page (near `/settings`), server-rendered,
   no-JS form actions — not a per-page header menu.

## Architecture

### Core (`core/src/auth.ts`) — one line

Add `multiSession({ maximumSessions: 4 })` to the plugins array. Cap of 4 (not
the default 5, not 3): the guest's `_multi-` cookie (M1) can occupy one slot, so
4 leaves up to ~3 real accounts alongside a lingering guest for the
admin+everyday case. This registers the server endpoints that ride the existing
`app.on(['GET','POST'], '/api/auth/*', …)` mount:

- `GET  /api/auth/multi-session/list-device-sessions` — **GET**, not POST (M3);
  returns `{ session, user }[]` (no `isActive` field — M8)
- `POST /api/auth/multi-session/set-active` `{ sessionToken }` — **no** session
  middleware; needs only the target's `_multi-` cookie
- `POST /api/auth/multi-session/revoke` `{ sessionToken }` — has session
  middleware; auto-promotes `validSessions[0]` when the revoked token is active

**No migration** (the plugin adds no tables). **Session resolution is
unchanged:** `sessionAuth` → `auth.api.getSession({ headers })` returns the
*active* session, so the timeline, posting, and admin gating always act as the
active account. No core route or middleware change beyond registering the
plugin.

### Web — `/accounts` page + actions

All operations are server-side fetches from web to core through the existing
cookie relay (`authedFetch`/`cookieHeader`/`relaySetCookies` in
`web/src/lib/server/session.ts`); every mutation is a no-JS `<form>` action.

- **List (load):** GET core `…/multi-session/list-device-sessions` with the
  browser cookie → **filter out `isAnonymous` entries** (M1) → render the
  registered held accounts **by email** — the better-auth user's email; the
  list carries no Textcaster @handle, and mapping to one needs a new core lookup
  (out of scope, and email matches the login mental model — P5). Mark the active
  one by comparing against `/me` (`getSession`) — there is no `isActive` field in
  the list (M8).
- **Switch (action):** the form submits an **opaque index/user-id, never the raw
  `sessionToken`** (M5 — the token lives only in httpOnly cookies; don't re-emit
  it into HTML). The action re-fetches `list-device-sessions` server-side,
  resolves the chosen entry's token, POSTs core `/set-active { sessionToken }`,
  relays the changed active cookie, and `redirect(303, '/accounts')`.
- **Add account:** a link to `/login`. Signing in while already signed in
  *adds* a session (plugin behavior); the existing login action's cookie relay
  already carries the new cookie. No new login code — but a regression test
  confirms a second sign-in adds rather than replaces.
- **Log out (this account) (action):** **deterministic order (M2, corrects
  rev 1):** if another *registered* held account remains, `set-active` to that
  chosen one FIRST, then `revoke` the old token. Because the old token is no
  longer active, `revoke`'s `if (active === revoked)` auto-promote branch is
  skipped — no arbitrary `validSessions[0]` pick (which could otherwise promote
  the hidden guest). If NO registered account remains, call **`signOut`
  (revoke-all)** — **not** `revoke(activeToken)`, which would hit that same
  auto-promote and hand the browser to the lingering guest (R1). `signOut` has
  no promote path, so it clears everything (guest included) and the browser
  falls to signed-out; the guest is re-minted only on the next **write action**
  (`ensureSessionFetch`), not on plain navigation (M10). *(rev 3 — R1)*
- **Log out of all (action):** the existing `signOut` (revokes all).

### Cookie relay — no change (resolved)

`relaySetCookies` and `cookieHeader` already relay/forward **all** cookies
generically, so the plugin's per-account cookies flow with no code change. The
naming concern resolves favorably (verified against 1.6.23): the multi cookie is
`${sessionTokenName}_multi-<token>`, which contains `session_token`, so
`hasSession()` stays true and `ensureSessionFetch` does not spuriously mint an
anon session — **no predicate change needed** (keep it as a test, not an open
probe). `set-active`/`revoke` rewrite the main session cookie via
`setSessionCookie`, which the relay carries back.

## UI

`/accounts` is guarded on **`me.isAnonymous`** (M4 — `hasSession` alone admits
guests; mirror `admin/+layout.server.ts`'s `isAdmin` gate: an anon/guest request
redirects to `/`). It lists the **registered** held accounts (`isAnonymous`
filtered out), each with a **Switch** button (submitting an opaque index, not a
token — M5); plus **Add account** (→ `/login`), **Log out (this account)**, and
**Log out of all accounts**. Because a further sign-in past the
`maximumSessions` cap is a silent non-add (new session becomes active but isn't
stored), render a **static** one-line hint (e.g. "up to 3 accounts on this
browser") — no dynamic count/load change needed (P2). Follows
`design-system/textcaster/MASTER.md` (invoke
`ui-ux-pro-max:ui-ux-pro-max` at implementation); house `--color-*` tokens only;
no new deps; works with JS off (plain forms). A small link to `/accounts` from
`/settings` for discovery.

## Security

- **CSRF rests on SameSite=Lax (M7).** The auth proxy overwrites `Origin` with
  the trusted web origin on every forwarded request, so better-auth's origin
  check always passes for a `POST /api/auth/multi-session/*` reached *directly*
  (not via our form action). What actually stops a cross-site POST is that the
  relayed session cookies are SameSite=Lax. That holds today; the plan must not
  assume core origin-checks these mutations. (Optional hardening, out of scope
  here: scope the proxy's `Origin` injection to the emailed-link GET paths it
  exists for.)
- **No raw session tokens in HTML (M5).** Forms submit an opaque index/user-id;
  the action resolves the token server-side from `list-device-sessions`.

## Testing

Plugin behaviors are only observable against real better-auth, so they go in
**core** tests (`:memory:` sqlite, the `auth.test.ts` shape) — the web
`auth.actions.test.ts` harness stubs core with canned `vi.fn()` Responses and
would only assert the stub (M6). The existing auth helpers keep one cookie
(`setCookie.split(';')[0]`); multi-session tests need a small **multi-cookie
jar** helper.

- **core** (`core/test/`):
  - **behavioral (not config-echo):** after `set-active(B)`, `getSession`
    returns B (act-as switches) — replaces the tautological "plugin registered"
    check (M6).
  - deterministic logout: `set-active(B)` then `revoke(A)` leaves B active and A
    gone.
  - R1 mechanism (core): from A+B held, `signOut` clears **all** held sessions
    (`getSession` → null) — it has no promote path (P1). The guest-specific case
    (the action choosing `signOut` when only a guest would remain) is asserted at
    the **web** layer, because a lingering guest can't be reproduced through the
    `/sign-in` test path without `onLinkAccount` deleting it — the guest only
    lingers via the verify-click GET.
  - **regression guard:** the anonymous first-visit flow is unchanged — a guest
    is still minted, and a signed-in second login *adds* a session rather than
    replacing (both plugin behaviors, hence core — M6).
  - guest slot: an `isAnonymous` session appears in `listDeviceSessions` (M1) —
    proves the web filter is load-bearing.
- **web** (`web/src/routes/…`, what the fetch-stub harness *can* observe):
  - `/accounts` load filters `isAnonymous` entries and renders only registered
    accounts; the guard redirects an anon/guest request (M4);
  - switch action resolves the opaque index → token server-side and redirects.
- Run `tsc --noEmit -w core` + `npm run check -w web` (type-stripping hides type
  errors from vitest).

## Out of scope

- Anonymous guest in the multi-session set (decided out).
- Cross-device / cross-instance session sharing (better-auth is per-instance).
- better-auth's `multiSessionClient` / any browser-side auth SDK.
- Changing `maximumSessions` per-user or exposing it as config (fixed at 4).

## Grounding

- `core/src/auth.ts` — plugins array (`magicLink`, `anonymous`, `openAPI` when
  flagged); where `multiSession()` is added.
- `core/src/api/auth.ts` — `sessionAuth` → `getSession` returns the active
  session (unchanged).
- `web/src/lib/server/session.ts` — `hasSession`/`cookieHeader`/
  `relaySetCookies`/`ensureSessionFetch` (the relay the actions reuse; the
  `hasSession` predicate to probe).
- `web/src/routes/api/auth/[...path]/+server.ts` — the proxy the multi-session
  endpoints flow through (no change needed).
- better-auth `multiSession()` **source** (`node_modules/better-auth/dist/plugins/
  multi-session/index.mjs`, 1.6.23): `list-device-sessions` is GET; after-hook
  matcher `() => true`; `set-active` has no session middleware; `revoke`
  auto-promotes `validSessions[0]` when the revoked token is active; `signOut`
  revokes all; default `maximumSessions` 5. Verified: `getFields` merges plugin
  schemas and `isAnonymous` has no `returned: false`, so `listDeviceSessions`
  DOES return `user.isAnonymous` — the web filter (M1) has a field to key on.
- **Lingering-guest precondition (R1):** hard email-verify creates the session on
  the verify-click GET, not a `/sign-in/*` route, so the anonymous plugin's
  guest-deletion hook doesn't fire on sign-up — a guest `_multi-` cookie
  routinely survives in the set.
- `docs/superpowers/reviews/2026-07-19-multi-session-spec-review.md` — the M1–M10
  review (folded into rev 2) + residual R1 (folded into rev 3).

## Implementation note

Core's typecheck is **green on HEAD** (the parallel per-user-feeds work is
implemented with tests) — M9 retracts the earlier stale red-base warning. Land
multi-session on HEAD; coordinate only to avoid touching the same files.
