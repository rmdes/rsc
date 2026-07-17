# Textcaster — email flows design (verification, magic link, reset)

Date: 2026-07-17 (rev 2 — folds in
`docs/superpowers/reviews/2026-07-17-email-flows-spec-review.md`: F-1
guest-upgrade probe pass-condition + abandon test, F-2 gate registration
when mailer null, F-3 unverified-purge noted, magic-link-as-verify recovery)
Status: rev 2, ready to plan
Author: Ricardo (rmdes) with Claude Code

## The load-bearing constraint (why F-1 and F-2 are the same bug)

`repo.sweepAnonymousUsers` (server.ts:65) reclaims ONLY anonymous accounts.
So the instant a core row becomes **non-anonymous AND unverified**, nothing
can ever reclaim it and (under hard verification) nobody can ever sign into
it — permanent limbo. Every decision below exists to keep that state from
being created: never move a guest's posts onto an unverified account, and
never create an email account we can't send verification for.
Basis: better-auth milestone (4c88ed6..5cea86d): better-auth 1.6.23 mounted
on core at `/api/auth/*`, anonymous guests + email/password, session-authed
actions, web cookie relay (`session.ts`), `/register` `/login` `/settings`
pages. Today `emailAndPassword` works with NO mail anywhere: any string
registers instantly, `emailVerified` is never set or checked, magic link
does not exist, and password reset is IMPOSSIBLE (no `sendResetPassword`) —
a forgotten password permanently loses the account.

## Decisions (user-confirmed)

- **Hard verification**: `requireEmailVerification: true` — an unverified
  email+password account cannot sign in. "Otherwise it's not worth it."
- **Magic link is the friendly primary flow**; password remains available.
- **Password reset ships in the same slice** (it is the account-loss fix).
- **New dependency: `nodemailer`** (core only; approved) — no stdlib SMTP
  client exists and hand-rolled SMTP is the wrong cleverness.
- Deployment posture: production SMTP comes from Cloudron's mail addon;
  dev/self-host uses Mailpit. A future `textcaster-deploy` repo (docker,
  Mailpit, Cloudron manifest) is OUT of this spec's scope; this slice only
  has to be env-configurable so that repo can wire it.
- IndieAuth: later, fresh session; it mounts as another better-auth
  provider on this same foundation.

## Probed API facts (better-auth 1.6.23, 2026-07-17 — do not re-derive from memory)

- Verification: `emailAndPassword.requireEmailVerification: true` +
  `emailVerification: { sendOnSignUp: true, sendVerificationEmail: ({ user, url }) => … }`.
  Sign-in before verify → **403**; the verify-link is a **GET** returning 302.
- Magic link: `magicLink({ sendMagicLink: ({ email, url, token }) => … })`
  from `better-auth/plugins`; request endpoint `POST /sign-in/magic-link`
  `{ email }`; consuming the link (GET) yields a session AND sets
  `emailVerified=1` (the verified-invariant holds by DEFAULT — no manual
  flag). Adds NO new tables (reuses `verification`).
- Reset: `emailAndPassword.sendResetPassword: ({ user, url, token }) => …`;
  request endpoint is **`POST /request-password-reset`** `{ email, redirectTo }`
  — NOTE: `/forget-password` 404s in 1.6.23; completion is
  `POST /reset-password` `{ newPassword, token }`.
- No migration: all three flows reuse migration-8's `verification` table
  (probed — magicLink added no tables).

## The mailer seam

`core/src/mail.ts`:

```ts
export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>
}
export function createMailer(smtpUrl: string | null, from: string): Mailer | null
```

- `createMailer(null, …)` → `null`: auth still boots, but every
  email-dependent ROUTE is gated up front (see F-2 below) — the account is
  never created, so the callback-throws-after-creation limbo cannot happen.
  Guests keep working; only email accounts are unavailable.
- Config (`config.ts`): `TEXTCASTER_SMTP_URL` (optional; e.g.
  `smtp://localhost:1025` for Mailpit — no TLS/auth needed there;
  `smtps://user:pass@host:465` shapes must work for Cloudron),
  `TEXTCASTER_MAIL_FROM` (default `textcaster@<host of PUBLIC_URL or
  webOrigin>`).
- Plain-text emails only (v1): subject + a URL. No templates, no HTML —
  YAGNI, and text mail survives every client.
- All emails' links point at the WEB origin (`webOrigin`), which proxies
  `/api/auth/*` to core — same path every browser flow already takes.

## better-auth wiring (core/src/auth.ts)

1. `emailAndPassword` gains:
   - `requireEmailVerification: true`
   - `sendResetPassword: ({ user, url }) => mailer.send(user.email,
     'Reset your Textcaster password', url)` (exact callback signature
     probed at plan time against installed 1.6.23 — never from memory)
2. `emailVerification`: `sendVerificationEmail` → mailer; auto-send on
   sign-up (better-auth option name probed at plan time;
   `sendOnSignUp`-shaped).
3. `magicLink()` plugin from `better-auth/plugins`:
   - `sendMagicLink: ({ email, url }) => mailer.send(...)`
   - Probe and PIN at plan time: whether a consumed magic link sets
     `emailVerified` (expected yes — the click is ownership proof). If it
     does not, the plan adds the flag in the plugin's callback per
     better-auth's documented option; the invariant is: after a magic-link
     login, the account behaves as verified.
   - Rate-limit rule for `/sign-in/magic-link` alongside the existing
     anonymous rule (same `{ window, max }` shape, e.g. 60s/5 — plan pins).
## F-2 (review): gate registration when `mailer === null` — do not fail after account creation

Auto-verifying without SMTP is REJECTED (it would let unverified accounts
sign in, gutting hard verification). Instead, when `mailer === null`, the
email-account routes are refused BEFORE any account row is created:

- Web `/register` and `/login`'s magic-link form and `/forgot`: when the
  layout/load sees mail is unconfigured, the form is replaced by a one-line
  "Email accounts aren't available on this instance — post as a guest"
  (guest flow unaffected). Surfaced via a `data.mailEnabled` boolean the
  layout load derives (a cheap core `GET /health`-style flag, or a config
  value the web reads — plan picks; do NOT create a limbo row to discover
  it).
- Core defense in depth: the email-register / magic-link / reset endpoints
  themselves refuse with a clear error when `mailer === null`, so a direct
  API call cannot create the limbo row either. The better-auth send
  callbacks still throw as a last backstop, but the gate means they are
  never reached on the normal path.

## The guest-upgrade interaction (the one subtle path)

Registering WHILE anonymous must not strand the guest session:

- Sign-up-while-anonymous still creates the account and sends the
  verification mail; the visitor REMAINS in their anonymous session (their
  guest identity keeps working) until the verification link is clicked.
- The `onLinkAccount` re-point (guest core row → new auth user) must NOT
  move the guest's posts onto an unverified account — that is the limbo the
  sweep can never reclaim (see load-bearing constraint). WHEN it fires
  relative to hard verification is a MANDATORY plan-time probe.

  **F-1 (review) — the probe's PASS-CONDITION is: linking fires at the first
  VERIFIED sign-in, not at sign-up. PROBED 2026-07-17 against installed
  better-auth 1.6.23 (requireEmailVerification + anonymous + sign-up-while-
  anon) — IT PASSES BY DEFAULT.** Observed, no deferral logic needed:
  - Sign-up-while-anon does NOT change the session cookie — the browser
    keeps the anonymous session (`isAnonymous=true`), so `ensureCoreUser`
    keeps resolving to the guest and NO limbo core row is minted for the
    unverified email user.
  - `onLinkAccount` does NOT fire at sign-up; it fires at VERIFICATION
    (the verify-link GET), with `newUser.emailVerified=true`, then the anon
    user is deleted. Sign-in before verify → 403.
  - Bonus observed: the verify-link GET completes the link even WITHOUT the
    anon cookie on that request (better-auth tracks the anon→new linkage
    server-side at sign-up-while-anon) — so the web flow need not carry the
    anon cookie onto the verification click; the link works cross-device.
  - Consequence for the plan: the existing `onLinkAccount` re-point
    (auth.ts:42-51) is already correctly timed under hard verification. The
    plan only ENABLES verification + wires the mailer; it does NOT add
    deferral logic. Still pin both invariant tests below — this probe is the
    reason to expect them green, not a substitute for them.
- Pin BOTH invariant tests: (a) register while guest → verify → sign in →
  the guest's pre-registration posts are attributed to the account; (b)
  register while guest → ABANDON (never verify) → the guest stays anonymous
  and is reclaimed by the normal sweep, leaving NO orphaned core row.
- Magic-link-while-anonymous follows the same invariant (link click =
  login = onLinkAccount fires per the probed "fires on ANY sign-in/sign-up
  with an anon session" behavior).

## Web surface

- `/register`: on success, show "check your inbox to verify" state instead
  of redirecting as-if-logged-in; unverified login attempts surface
  better-auth's error as "verify your email first (check spam / resend)".
  A resend-verification action if better-auth exposes one (probe; if not
  exposed, re-triggering signup's send path or omitting resend in v1 —
  plan decides from the probe, omission is acceptable v1).
- `/login`: gains the magic-link form (email only, "Email me a login
  link") beside the password form; success state = "check your inbox".
- `/forgot` (new): email form → reset mail; `/reset` landing (better-auth
  serves token validation; the web page posts the new password to the
  better-auth endpoint with cookie/origin relay like every other auth
  call).
- Identity bar / login-blocked state: a user stuck on an unverified
  password registration sees a "verify your email" nudge whose concrete
  action is **"email me a login link"** (F-1/Concern-3 recovery): a
  consumed magic link proves ownership and marks the account verified, so
  it is the unblock path — no separate resend-verification flow needed.
- All pages: plain SSR forms, existing `.auth-form`/`fail`-error patterns,
  tokens only. UI work invokes ui-ux-pro-max per project rule.

## F-3 (review, LOW — noted, likely YAGNI now)

Abandoned-but-verified-never registrations leave a non-anonymous
better-auth `user` row the anonymous-only sweep never touches. Under the
F-1 correct ordering NO posts attach to it (the re-point waited for
verification), so this is dead-row accumulation, not data loss. Pre-release
it's negligible. The fix, if it ever matters: a symmetric "purge
non-anonymous accounts with `emailVerified = 0` older than N days" pass
beside `sweepAnonymousUsers`. Deferred, not built.

## What does NOT change

- Anonymous guest flow (act-first, lazy mint, TTL sweep) — untouched.
- Session middleware, `/me` surface, route auth — untouched.
- The bearer token's ops-only role — untouched.
- No new tables expected: better-auth's `verification` table (migration 8)
  already exists for these tokens. If the magic-link plugin's CLI schema
  demands more, that is a NEW migration entry, appended — probed at plan
  time, never assumed.

## Testing

- Mailer: unit tests with a capturing fake (`send` recorded); one nodemailer
  transport-construction test (smtp:// and smtps:// URL shapes parse).
- Auth flows (core, supertest-style like auth.test.ts): register →
  verification mail captured, link URL parses, login BLOCKED before
  verification (401/403 per better-auth), works after GET-ing the link;
  magic link → mail captured, consuming the link yields a session AND the
  verified invariant; reset → mail captured, new password works, old one
  does not.
- `mailer === null` gating (F-2): the email-register / magic-link / reset
  endpoints refuse BEFORE creating any row — assert the account count is
  unchanged after a rejected registration (no limbo row), not merely that
  it errored.
- Guest-upgrade invariants (F-1), BOTH paths: (a) register→verify→sign-in
  attributes the guest's prior posts to the account; (b)
  register-then-abandon leaves the guest anonymous and sweepable with no
  orphan core row. Structure per the probe's pinned ordering.
- Web action tests: register shows check-inbox state; magic-link request
  action relays cookies; forgot/reset actions map errors inline.
- Human click-check: full loop against local Mailpit (register → Mailpit →
  verify → login; magic link; reset), both themes.
- RUNNING.md: TEXTCASTER_SMTP_URL / TEXTCASTER_MAIL_FROM, Mailpit
  one-liner (`docker run -p 1025:1025 -p 8025:8025 axllent/mailpit`), the
  hard-verification behavior, Cloudron note (mail addon env → SMTP URL).

## Sequencing

1. Mailer seam + config + tests.
2. better-auth wiring (verification, magic link, reset) + core flow tests
   incl. the guest-upgrade invariant (probes first).
3. Web pages/actions + RUNNING.md.
4. Mailpit click-check.
