# Spec review — multi-session / account switching (2026-07-19)

## Re-review of rev 2: one residual — the last-registered logout still trips the auto-promote

All ten folds verified faithful, and the M1 mechanism's precondition **holds
against the source**: `getFields` merges every plugin's schema fields
(`db/schema.mjs:17-20`) and the anonymous plugin's `isAnonymous` has no
`returned: false` (`plugins/anonymous/schema.mjs`), so
`listDeviceSessions`' `parseUserOutput` **does return `user.isAnonymous`** —
the web filter has something to key on. Worth adding that verified fact to
Grounding. M2's ordering, the GET verb, the `isAnonymous` guard, opaque form
index, core-test placement + multi-cookie jar, the Security section, cap 4
with the silent-non-add hint, and the retracted M9 note all check out.

**R1 — the "no registered account remains" logout branch contradicts the
spec's own M2 finding.** It says "`revoke` the active token and let the
browser fall to signed-out" — but revoking the ACTIVE token is exactly the
case where the plugin auto-promotes `validSessions[0]`
(`multi-session/index.mjs:99-113`, quoted in this spec's own endpoint note).
With a lingering guest in the set, the browser does NOT fall to signed-out —
the guest becomes **active**, contradicting decision 1's "never active,
never promotable" and falsifying the core test bullet "with no registered
account left, the session clears". And the lingering guest is not rare here:
Textcaster's hard email-verify means fresh registration creates the session
on the verify click, not via `/sign-in/*`, so the anonymous plugin's
guest-deletion after-hook (matcher on sign-in routes) does not fire on that
path — the guest's `_multi-` cookie survives sign-up.
**Fix (one line):** the last-registered logout calls **`signOut`** (revoke
all — the existing log-out-all machinery) instead of `revoke(token)`; with no
registered account left, clearing everything including the guest IS the
intended signed-out state, and no auto-promote branch can run. Update the
test bullet to assert signOut behavior, and soften decision 1's "never
promotable" to "never promotable by our flows (the only revoke-of-active we
issue is signOut, which has no promote path)".

Parallel-session high-effort review (4 finder angles; every better-auth claim
verified against the **installed 1.6.23 source**, not docs-from-memory; repo
claims verified file:line). Distinct from the cold ponytail review
(`2026-07-19-multi-session-review.md`).

**Verdict: the architecture is right (server-driven, no client SDK, proxy
reuse) but the spec needs a rev before planning — its central invariant is
false by plugin behavior, and the logout flow misreads a plugin that already
does the promotion itself.**

## Findings (ranked)

### M1 — "A guest never joins the multi-session set" is false: the plugin has no such notion

**CONFIRMED (3 independent finders).** The multiSession after-hook matcher is
`() => true` and fires on ANY `newSession`
(`multi-session/index.mjs:116-145`); anonymous sign-in calls
`setSessionCookie` → `setNewSession` (`anonymous/index.mjs:58`,
`cookies/index.mjs:130`), so **every auto-minted guest gets a
`_multi-<token>` cookie**, appears in `listDeviceSessions` (no `isAnonymous`
filter), and **consumes one of the 3 `maximumSessions` slots** before any real
login. Partial incidental mitigation: on sign-in into an *existing* account
the anonymous plugin deletes the guest user+sessions (`anonymous/index.mjs:
155-158`), and dead sessions are filtered from the list — but on the
fresh-registration path core's `onLinkAccount` **deliberately throws** to
abort that deletion (`core/src/auth.ts:38-40`), preserving the guest session
in the set. Decision 1 is currently a wish, not a mechanism.
**Fix (spec must choose):** (a) filter `isAnonymous` sessions out of the
`/accounts` list at the web layer AND size `maximumSessions` accounting for
the guest slot (e.g. 4), documenting that the set may *contain* a guest that
is never *rendered*; or (b) a small custom hook wrapping/conditioning the
plugin's — more code, true enforcement. Either way, spell it out.

### M2 — Per-account logout misreads the plugin: `revoke` already auto-promotes, nondeterministically

**CONFIRMED (3 finders).** The spec's flow is `revoke {activeToken}` then a
manual `set-active` to the next session. But when the revoked token IS the
active session, the revoke endpoint itself scans remaining `_multi-` cookies
and calls `setSessionCookie(ctx, validSessions[0])`
(`multi-session/index.mjs:99-113`) — an **arbitrary** pick that, combined
with M1, **can promote the surviving guest session to active**, silently
dropping the user into the guest identity the spec says is impossible. The
manual follow-up either double-fires (two rewrites, last-relay-wins) or never
runs (the "no session remains" branch). Also: the ordering worry is inverted —
`set-active` has **no sessionMiddleware** (needs only the httpOnly `_multi-`
cookie), so the deterministic design is **`set-active(next)` FIRST, then
`revoke(oldToken)`** — one rewrite, chosen target, no race.

### M3 — `list-device-sessions` is GET, not POST

**CONFIRMED.** `createAuthEndpoint('/multi-session/list-device-sessions',
{ method: 'GET', requireHeaders: true }, …)` (`multi-session/index.mjs:
23-26`). The spec's endpoint table (and its MCP-sourced grounding) carries
the wrong verb; a POSTing load renders zero held accounts. `set-active` and
`revoke` are POST `{sessionToken}` as stated.

### M4 — "/accounts guarded: signed-in only" is under-specified — guests pass that guard

**CONFIRMED.** The only existing page guard pattern is
`if (!hasSession(cookies)) redirect(303,'/')` (`settings/+page.server.ts:7`),
and `hasSession` matches any `session_token` cookie — **anonymous guests
included**. For a registered-only feature the guard must test
`me.isAnonymous` (mirror `admin/+layout.server.ts:6`'s `isAdmin` pattern).
Say so explicitly.

### M5 — Raw session tokens in HTML forms are a new disclosure surface

**CONFIRMED (fact), judgment on the fix.** Switch/revoke need
`{sessionToken}` — the raw DB token, which today lives only in
**httpOnly signed** cookies (value = `token.signature`), unreadable by page
JS. Server-rendering it into hidden fields defeats that httpOnly protection
(any XSS reads the DOM). Not a bearer credential alone (set-active also
requires the victim's own `_multi-` cookie; no bearer plugin), so severity is
moderate — but the cheap fix is to never emit tokens: the form submits an
opaque index (or the target user id), and the action re-fetches
`list-device-sessions` server-side and resolves the token there.

### M6 — Two web test bullets are unwritable in the web harness

**CONFIRMED.** `web/src/routes/auth.actions.test.ts` stubs core with
`vi.fn()` canned Responses — it never runs better-auth. "Per-account logout
promotes the next session" and "second login adds rather than replaces" are
plugin behaviors, unobservable through fetch stubs; written there they
degrade to asserting the stub. **Move both to core tests** (real better-auth
over `:memory:` sqlite — `auth.test.ts` already has the shape). Two harness
notes for that: the helpers (`auth-helper.ts:31,52`) keep only
`setCookie.split(';')[0]` — one cookie — so multi-session tests need a small
multi-cookie jar; and the "multiSession registered / api methods present"
bullet is tautological config-echo — replace it with the behavioral
`set-active → getSession returns the new active` test.

### M7 — CSRF on the directly-proxied mutations rests solely on SameSite=Lax

**CONFIRMED (hardening note).** The auth proxy overwrites `Origin` with the
trusted web origin on **every** forwarded request
(`api/auth/[...path]/+server.ts:29`), so better-auth's origin check always
passes for `POST /api/auth/multi-session/set-active|revoke` reached directly
(not via form actions). What actually stops a cross-site POST is only that
the relayed cookies are SameSite=Lax. That holds today — but the spec's
implicit "core origin-checks these POSTs" is void behind the proxy. Cheap
hardening: scope the proxy's Origin injection to the emailed-link GET paths
it exists for, or note the Lax dependency explicitly in the spec.

### M8 — "Compare against /me or the list's active flag": there is no active flag

**CONFIRMED.** `listDeviceSessions` returns `{session, user}` pairs via
`parseSessionOutput` — no `isActive` field (`multi-session/index.mjs:32-39`).
Only the `/me`/getSession comparison exists; drop the phantom option. (The
raw `token` IS in the output — the form actions' input is available.)

### M9 — The implementation note about a red core typecheck is stale

**CONFIRMED.** `npm run typecheck -w core` is currently green and the
per-user-feeds repo methods are implemented with tests on HEAD. Drop or
reword the note — as written it sends the implementer hunting for a green
base they are already on.

### M10 — "Next request re-mints a guest" overstates when the mint fires

**CONFIRMED.** There is no hooks.server.ts; the layout load returns `me:null`
without minting. `ensureSessionFetch` runs **only in write actions**
(compose/reply/follow/edit) — plain navigation after log-out-all stays
signed out until a write. Consistent with today's behavior, but reword so the
fallback isn't read as any-request re-mint.

## Verified clean (for the record)

- **Version pin real:** installed better-auth is exactly 1.6.23.
- **No migration:** the plugin returns no `schema` — no tables. ✓
- **Cookie probe resolves favorably:** multi cookie =
  `${sessionTokenName}_multi-<token>` → contains `session_token` →
  `hasSession` stays true; no predicate change needed (keep the probe as a
  test). `relaySetCookies` iterates `getSetCookie()` so multiple Set-Cookies
  relay; its attribute-flattening (path=/, Lax, httpOnly) is harmless here
  (no `__Host-`/custom-Path cookies at 1.6.23).
- **set-active rewrites the main session cookie** via `setSessionCookie`. ✓
- **signOut revokes all** multi cookies + sessions (sign-out after-hook). ✓
- **Second sign-in adds** (de-dup is same-user only). Overflow at
  `maximumSessions` is a **silent non-add** (new session active but not in
  the set — no revoke-oldest, no error): worth one UX sentence at cap 3.
- **sessionAuth/getSession per-request** — no token/id caching anywhere in
  core; admin gating re-derives from the active session after a switch. ✓
- **SSE stream unaffected** — `/timeline/stream` forwards no cookies and is a
  global broadcast; switching mid-stream leaks nothing. ✓
- **Proxy passes `/multi-session/*`** (only `reference`/`open-api*` are
  blocked); method+body forwarded. ✓
- **Docs layout, MASTER.md/ui-skill citations** ✓; hono skill only weakly
  implicated (no new route) — the core tests ride the existing
  `app.request` auth-test shape.
