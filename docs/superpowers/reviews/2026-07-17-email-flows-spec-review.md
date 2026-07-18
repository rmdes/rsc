# Spec review — email flows (verification, magic link, reset) (2026-07-17, 34ffef9)

Security-first (auth/email milestone). Grounded in the *current* landed auth
wiring (`core/src/auth.ts`, `server.ts` sweep, `config.ts`) and a live check of
the installed better-auth 1.6.23 — not just the spec's assumptions.

**Verdict: strong, security-conscious spec — ready to plan after sharpening the
guest-upgrade probe (F-1) and the null-mailer failure shape (F-2).** All three
flagged concerns are handled with the right instinct (pin the invariant, mandate
the probe). My additions make two failure modes concrete and grounded.

## Concern 1 (guest-upgrade × hard verification) — the spec is right to probe; here is the exact failure to rule out

The re-point is already wired: `onLinkAccount` (auth.ts:42-51) re-points the
guest core row to the new auth user on fresh registration, abandons the guest on
login-into-existing, and its throw-aborts-deletion ordering was probed **during
the better-auth milestone — without `requireEmailVerification`.** Hard
verification changes the flow, so that probe does not cover this case; the spec
correctly re-mandates it.

**F-1 — HIGH: name the limbo, because the sweep makes it permanent.** The sweep is
`repo.sweepAnonymousUsers(config.anonTtlDays)` (server.ts:65) — **anonymous-only**
(grounded). So the probe is not merely "when does `onLinkAccount` fire" — it must
rule out this specific outcome:

- If linking fires at **sign-up** (before verification): the guest's core row +
  posts move onto the new account, which is now **non-anonymous and unverified**.
  That account (a) can't sign in (hard verification), and (b) is invisible to
  `sweepAnonymousUsers`. If the user never verifies, the guest's posts are
  stranded on it **forever** — no path reclaims it. And the anon record's
  deletion strands the guest's active session, breaking the spec's own intent
  (line 82: "the visitor REMAINS in their anonymous session… until the
  verification link is clicked").
- If linking fires only at the first **verified sign-in**: correct by
  construction — guest stays anonymous through the verify-wait, keeps posting,
  and is swept normally if the registration is abandoned.

So the probe's pass condition is "linking fires at verified sign-in, not
sign-up." If better-auth links at sign-up, the plan must **defer** the
re-point/deletion until verification (or keep the anon session alive). Pin the
invariant test for BOTH paths: (a) verify → sign in → guest posts attributed to
the account; (b) register-then-abandon → guest stays anonymous, gets swept, no
orphaned core row. The spec pins (a); add (b).

## Concern 2 (mailer === null) — the posture is right; do NOT soften security, but fix the failure shape

The honest-failure design is correct, and I would **not** add a softer
*security* fallback: auto-verifying when `mailer === null` would let unverified
accounts sign in, contradicting the "hard verification, otherwise it's not worth
it" decision. Keep hard verification unconditional.

**F-2 — MED: gate registration when `mailer === null`, don't fail after account
creation.** As specced, a no-SMTP instance lets registration create the account
and *then* throws in `sendVerificationEmail`. That leaves an unverified,
unverifiable, non-anonymous (sweep-immune) account row behind on **every**
registration attempt — the F-1 limbo, but guaranteed and repeatable. Cleaner:
when `mailer === null`, gate the email-register route/form up front ("email
accounts aren't available on this instance — post as a guest"), so no account
row is created and the failure is honest *and* upfront. That is a softer
*failure UX*, not softer security. (Magic-link and reset are naturally gated the
same way — no mailer, form disabled.)

## Concern 3 (magic-link-verifies invariant) — sound, and it doubles as the recovery path

The pin ("after a magic-link login, the account behaves as verified") and the
probe-don't-assume discipline are exactly right. Confirmed the `magicLink`
plugin and its `sendMagicLink` callback exist in installed better-auth 1.6.23
(not misremembered). One addition worth wiring: because a consumed magic link
proves ownership, it is *also* a verification-recovery path — a user blocked by
an unverified password registration can unblock by requesting a magic link (same
email, `emailVerified` is per-user). So the "verify your email" nudge (spec
line 110) should offer "email me a login link" as the concrete verify action.
Coherent and free.

## F-3 — LOW (note): abandoned *unverified* registrations are never cleaned up

The sweep is anonymous-only. A registered-but-never-verified account is
non-anonymous, so it is never swept — its better-auth `user` row lingers even
after its `verification` token expires. Not data loss (no posts attached in the
correct F-1 ordering), just accumulating dead rows. Pre-release it's negligible;
note it as an accept-or-address decision (a symmetric "purge unverified accounts
older than N" sweep is the fix if it ever matters — likely YAGNI now).

## Verified sound
- `magicLink`/`sendMagicLink` exist in better-auth 1.6.23; the plugin/option
  choices are real, not from memory.
- `onLinkAccount` (auth.ts:42-51) already handles fresh-registration re-point vs
  login-into-existing-abandon correctly for the non-verification case; the spec
  re-probes for verification, as it must.
- Mailer seam (`Mailer | null` + factory) is minimal and clean; `nodemailer` is
  the right dependency (no stdlib SMTP; hand-rolling it is the wrong cleverness).
- Plain-text-only emails, links at `webOrigin` (matches the existing
  `session.ts` proxy path), verification table already present (migration 8) —
  all consistent with the landed foundation.

## Ponytail
Disciplined and minimal — one mailer interface + factory, no templates
(correctly YAGNI'd), one justified dependency, and "probe at plan time, never
from memory" applied throughout for the auth surface. Nothing to cut.

## What to change before planning
Sharpen F-1 (probe pass-condition = link at verified sign-in; test the
abandon-before-verify path too) and F-2 (gate registration when mailer is null
rather than failing post-creation). Note F-3. Fold the magic-link-as-verify
recovery path into the nudge. The hard-verification decision and the
honest-failure mailer posture are sound; keep the security hard.
