# Plan review — multi-session implementation plan (2026-07-19)

High-effort correctness pass on `docs/superpowers/plans/2026-07-19-multi-session.md`
(3 finder angles; every assumption verified against installed @sveltejs/kit
2.70.0, better-auth 1.6.23, and the repo). **Verdict: fold one small rev
(P1–P6 are all plan-text edits, no architecture change), then execute.**

## The two named concerns — both resolve favorably, with proof

- **The mid-request cookie re-read in `logoutOne` is CORRECT.** SvelteKit's
  `cookies.getAll()` starts from the request header, then overlays every
  cookie set via `.set()` this request — the mid-request value wins
  (`kit/src/runtime/server/cookie.js:121-146`; `set_internal` stores into the
  same `new_cookies` map the getter reads). `relaySetCookies` sets
  `path:'/'`, which `path_matches('/accounts','/')` accepts. So `f2` carries
  the NEW active cookie, and the plugin's revoke guard
  (`if (!(ctx.context.session?.session.token === sessionCookie)) return` —
  `multi-session/index.mjs:99`) early-returns without ever reaching the
  `validSessions[0]` auto-promote. The M2/R1 design is sound end-to-end.
- **The get-session shape assumption is CORRECT.** `/get-session` accepts
  GET; signed-in returns `{session, user}` with `user.id`; signed-out returns
  HTTP 200 with body `null` (better-call serializes a raw `null` to
  `"null"`), which `getActiveAuthUserId` handles.

**Harness realism (the third concern): fully verified.** `makeAuth`'s
`webOrigin: 'http://web.test'` is the trusted origin the sketch uses;
`repo.raw` exists and the `UPDATE user SET emailVerified` line is
byte-for-byte the existing `registeredSession` pattern; all factory
signatures match; `x-forwarded-for`/`uniqueIp` matches the rate-limit
config; the jar flow genuinely produces add-not-replace (the after-hook
de-dups same-user only), and no anonymous-plugin hook fires on
registered→registered sign-ins. Whole-suite impact: benign — the only
Set-Cookie assertions in core tests are substring checks the extra `_multi-`
cookie can't flip; prediction is Step 4's full run stays green.

## Findings

### P1 — The R1 behavioral test is missing at the core level

The spec files "signOut clears everything including the guest — it does NOT
promote" under **core** testing (M6: plugin behavior is only observable
against real better-auth). Task 1's four tests cover set-active,
deterministic logout, guest-in-set, add-not-replace — but not this one. The
web R1 test only proves the action *issued* `/sign-out`; it cannot observe
non-promotion. **Fix:** add a fifth core test — guest + one registered
account, POST `/api/auth/sign-out`, assert `listDeviceSessions` is empty and
`getSession` is null. (The sign-out after-hook that expires all `_multi-`
cookies is verified real — `multi-session/index.mjs:146-165` — this test pins
it.)

### P2 — The spec's cap-hint UI line has no home in Task 4

Spec: "At the `maximumSessions` cap a further sign-in is a silent non-add —
surface a one-line hint." The component sketch has no hint and `load`
returns only `{accounts}` — no count/cap signal to key on. **Fix:** load
returns `atCap: accounts.length >= 3` (registered cap = 4 minus guest slot —
or simply pass the raw count) and the component renders one `.field-hint`
line near "Add account" when at cap.

### P3 — Nonexistent CSS classes presented as reuse

`.button` and `.badge` exist nowhere in web/src (app.css has only
`.badge-kind`), and `.danger-link` is NOT in app.css — it's a
component-scoped style duplicated in `+page.svelte` and
`post/[id]/+page.svelte`. The plan's "Reuse `.danger-link` if present in
app.css" sends the implementer hunting. **Fix:** name the truth: the three
classes are net-new work for the component's `<style>` block (copy the
existing `.danger-link` scoped style from the timeline component; define
`.badge`/`.button` per MASTER.md tokens or drop them for existing idioms).

### P4 — `logoutOne` leaks the old session when get-session fails, and the actions are unguarded

If `getActiveAuthUserId` returns null (transient failure), `active` is
undefined → `set-active(next)` runs but revoke is skipped — the "logged out"
session silently stays in the set. Also the `guard` runs only in `load`;
`switch`/`logoutOne`/`logoutAll` are POSTable directly with no guard (no
privilege issue — a guest's jar holds no registered token to resolve — but
the plan's "guard makes this unreachable" reasoning doesn't cover actions).
**Fix (small):** in `logoutOne`, bail (redirect with no mutation) when
`activeId` is null instead of proceeding; optionally note the actions'
effective safety comes from `tokenForId`'s registered-only filter, not the
guard.

### P5 — Identity: spec says handle/display, plan renders better-auth emails

The list's `user` is better-auth's (email+name), and Task 3/4 render
`account.email` — diverging from the spec's "handle/display" and from how
every other page identifies users (`@handle`), while leaking email addresses
into HTML. **Fix:** either resolve handles (join against `/me`-style core
lookup per auth user — heavier) or amend the spec to say the switcher shows
the account **email** (honest, matches the login mental model, one line).
Recommend the spec amendment — emails are what the user typed to log in.

### P6 — Stale spec pointer (again)

Plan header says "Spec: … (rev 2)"; the spec is rev 3. The body implements
rev 3 (R1/signOut), so it's only the pointer — but this exact failure class
was flagged on the reply-context plan too. **Fix:** point at rev 3.

## Notes (no action required)

- The web unit tests' static cookie stub can't exercise the mid-request
  re-read; the core deterministic-logout test is the **only** regression
  guard for M2's ordering — the plan's line 572 note is accurate; keep that
  core test pinned through any refactor.
- Latent, currently-safe fragility: `auth-helper`'s `split(';')[0]` and
  auth.test.ts:323's session-token regex rely on the primary cookie being
  emitted before the `_multi-` cookie (true today: handler emits primary,
  after-hook appends). Only a better-auth reordering would break them; not
  worth pre-hardening.
