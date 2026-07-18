# Spec review — authorization foundation (2026-07-18, 5e1b029)

Security-first (it's an authz keystone), then ponytail, grounded in the current
session middleware (`core/src/api/auth.ts`) and `GET /me` (`app.ts:113`).

**Verdict: ready to plan.** Well-scoped, correctly fail-closed, and the
verified-only derivation is exactly the right call. A few plan-time pins (all
already flagged as open details or minor), and direct answers to the three
questions you raised.

## Your three questions

- **Fail-closed default — keep it, strongly.** No `TEXTCASTER_ADMIN_EMAIL` →
  empty set → `isAdmin` always false → every `requireAdmin` route 403s for
  everyone. That's the correct posture for an authz gate: absent config denies,
  never silently grants. And for *this* sub-project it's harmless — SP1 ships no
  destructive admin action, only `/admin/status`, so a locked-out owner loses
  nothing but an introspection route until they opt in.
- **`/admin/status` inclusion — keep it, but for the right reason.** Its real
  value is **end-to-end gate validation**: a security gate needs one live
  `sessionAuth + requireAdmin` route to prove the composition (and ordering)
  actually works, which unit tests on the middleware alone can't. The "seed the
  future admin UI" justification is the weaker (YAGNI-ish) half — lean on the
  validation rationale. Returning `adminEmails` is safe: it's admin-only, and
  admins knowing the admin list is expected.
- **Sub-project boundaries — clean.** SP1 builds the keystone (`isAdmin` + the
  gate) and validates it *without applying it to anything*; re-gating `POST
  /users` is explicitly SP2. Note the consequence, so it isn't mistaken for a
  gap: **SP1 does not change the security posture** — any registered user can
  still add feeds until SP2. That's the correct decomposition (foundation →
  application), not an omission.

## Security — sound, and here's why

- **Verified-only is the linchpin, not a nicety.** `isAdmin = emailVerified ===
  true && adminEmails.has(email.toLowerCase())`. The email allowlist is only safe
  *because* hard verification means an attacker can't hold a session for an
  address they don't control — so they can't register an admin's email and
  inherit admin. Call this out in the spec as the reason the mechanism is safe,
  not just "belt-and-suspenders." (Magic-link sign-in also sets `emailVerified`,
  so an admin can arrive that way too — still gated on inbox control.)
- **Fails closed on shape surprises.** The strict `=== true` means a missing or
  renamed `emailVerified` on the resolved user resolves to `undefined === true`
  = false = not admin. Good — errs toward denial.
- **Anonymous never admin** by construction (no email → `typeof email ===
  'string'` false). Matches `sessionIsAnonymous` handling in `registeredOnly`.
- **Mis-composition fails closed.** `requireAdmin` reads `c.get('isAdmin')`,
  which only `sessionAuth` sets. If ever composed without `sessionAuth` first,
  `isAdmin` is undefined → 403. And on the **token** path of `sessionOrToken`,
  no session resolves → no `isAdmin` → 403: the ops token is never admin, which
  is correct. (Note for later sub-projects: `requireAdmin` is only meaningful
  after `sessionAuth`, never on the token path.)
- **No leak via `/me`:** it returns the caller's *own* `isAdmin`; a non-admin
  only ever learns they're not admin.

## Correctness — pins for the plan (mostly already flagged)

- **Thread `adminEmails` into the middleware (enumerate the deps change).**
  `sessionAuth` today is `(auth, users)`; computing `isAdmin` needs the admin set,
  so its signature/deps grow, and `sessionOrToken` (which composes `sessionAuth`
  manually) must pass it through. Small, but it touches every construction site —
  list them so none is missed. (This is the one mechanical ripple the spec
  understates slightly.)
- **Confirm `session.user.email` / `.emailVerified` shape** (open-detail #1) —
  the current middleware only reads `.id`/`.isAnonymous`. better-auth's user
  carries `email` + `emailVerified`, but confirm against installed 1.6.23 rather
  than memory. The strict `=== true` makes a wrong guess fail closed, so the risk
  is "admin can't get in," not "wrong person gets in."
- **Verified-session test helper** (open-detail #3) is real work — the existing
  suite mints *registered* sessions; the derivation needs `emailVerified: true`.
  Budget for it; it's the one non-trivial test-infra piece.

## Ponytail
Lean and disciplined: config parse + one derivation expression + one gate + a
field on `/me` + one validation route. No stored role, no migration, no UI, and
everything else explicitly deferred with dependency-ordered sub-projects. The
only faintly speculative element is `/admin/status`'s "seed the future UI"
framing — the route itself earns its place as gate validation. Nothing to cut.

## What to change before planning
Nothing blocking. Recommended: (1) reframe verified-only as the security linchpin
(not just defense-in-depth); (2) enumerate the `adminEmails` threading through
`sessionAuth`/`sessionOrToken` and their construction sites; (3) keep
`/admin/status`, framed as gate validation. Fail-closed, verified-only, and the
sub-project decomposition are all right as designed.
