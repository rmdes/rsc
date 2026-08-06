# Per-recipient magic-link throttle — Design

**Status:** Rev 1 (2026-08-06). Root-caused and measured against live Cloudron
instances (evidence below). Authorizes no code (→ clean-context spec review →
plan → SDD).

## Problem

`POST /api/auth/sign-in/magic-link` mails a login link to **any address given**,
and `magicLink()` runs with better-auth's default `disableSignUp: false`
(`core/src/auth.ts`), so an unknown address also gets an account created
(`core/test/auth.test.ts:276` proves this: a fresh `m@b.test` ends up a verified
user row). The instance is therefore a mailer that any anonymous caller can aim
at an arbitrary third party.

The only brake today is better-auth's per-IP rate limit
(`customRules: { '/sign-in/magic-link': { window: 60, max: 5 } }`,
`core/src/auth.ts:221`), and **on Cloudron that key is attacker-controlled.**
Measured 2026-08-06 (see [[cloudron-client-ip-untrustworthy]] and
`RSC_TRUST_CLIENT_IP`): Cloudron's proxy runs `real_ip` trusting the caller's
`X-Forwarded-For` and stamps both XFF and `X-Real-IP` with it, so rotating that
header gives unlimited fresh buckets — and spending 5 requests under a victim's
address locks *that victim* out of requesting a login link. The limit thus fails
in both directions at once.

Consequences, in severity order:

1. **Third-party mail abuse** — unbounded login mail sent to addresses their
   owners never gave us. Deliverability/reputation damage lands on the
   instance's domain, not the attacker's.
2. **Unbounded account creation** — each such request also writes a user row.
3. **Targeted login denial** — a victim can be kept from requesting a link.

## Decision (why not the alternatives)

- **NOT `disableSignUp: true`.** It would close (1) and (2) outright, but
  magic-link is currently a real passwordless signup path — the login form
  creates accounts for unknown addresses today. Removing that is a product
  decision the operator declined; and it would trade the problem for **account
  enumeration** (unknown address starts erroring, `/login` surfaces the message),
  requiring a uniform-response change to be safe.
- **NOT "fix the IP".** No `XFF_DEPTH` helps on Cloudron: index 0 is the
  caller's claim and the only other entry is the docker bridge, identical for
  everyone. The platform has no trusted-proxy setting (Cloudron staff: open
  feature request).
- **Throttle on the RECIPIENT instead.** The target email is supplied by the
  caller but is not a *credential they can rotate for free* — rotating it
  changes who gets mailed, which is precisely the thing being bounded. Unlike
  the IP it needs no trust in any proxy, so it behaves identically on every
  deploy topology.

## Placement — core, not web (load-bearing)

There are **two** independent paths to this route and only core sees both:

- `web/src/routes/login/+page.server.ts:33` fetches
  `${base()}/api/auth/sign-in/magic-link` **directly**, bypassing the
  `/api/auth/[...path]` proxy entirely.
- `web/src/routes/api/auth/[...path]/+server.ts` relays the same path for any
  client that posts to it.

A web-side throttle would therefore miss the primary path. **The throttle must
live in core.**

Core already intercepts this exact route: `MAIL_GATED`
(`core/src/api/app.ts:258-262`) is a `Set` containing
`/api/auth/sign-in/magic-link`, handled by an `app.on('POST', [...MAIL_GATED])`
that short-circuits with 503 when no mailer is configured and otherwise delegates
to `deps.auth.handler`. That handler is the natural seam: it already owns
"should this mail-sending route proceed at all", and it runs before better-auth.

The alternative seam — a third better-auth `hooks.before` plugin, matching the
two existing ones (`reject-anon-api-key-create`,
`reject-non-admin-admin-key`) — is also viable and closer to those precedents.
**Open for the plan:** pick one, do not build both. The `MAIL_GATED` handler is
preferred because it needs no `getSessionFromCtx`, no `ctx.request`/`ctx.headers`
in-process discrimination, and keeps the mail-abuse rules in one place.

## Mechanism

On `POST /api/auth/sign-in/magic-link`, before delegating to better-auth:

- Read the JSON body's `email`; normalize (trim + lowercase) as the bucket key.
  A body without a usable string email is left to better-auth's own validation —
  this gate never invents a 400 that the auth layer would answer differently.
- Fixed-window counter per key. **Proposed defaults: 3 per hour per address**,
  operator-overridable. Rationale: a real person requesting a login link needs
  one, occasionally two (mail delayed, link expired); three per hour is generous
  for humans and useless for flooding. Deliberately *stricter* than the existing
  per-IP `5/60s`, because this bound is the one that actually holds.
- Over the limit → `429` with a neutral body. **The response must be identical
  whether or not the address has an account**, so this cannot become the
  enumeration oracle that `disableSignUp` would have been.
- Window eviction must have a real path: sweep expired entries, throttled to at
  most once per window (NOT once per request — an unthrottled sweep turns an
  O(1) rejection into an O(n) scan on exactly the flood path being defended;
  this is the `sweepExpiredConnectionAttempts` lesson from the firehose,
  `logical-routes/public.ts`).
- **ponytail:** single-process in-memory Map, reset on deploy/restart — the same
  accepted ceiling, and the same named upgrade path (a shared store if an
  instance ever runs multiple replicas), as the firehose counters and the
  api-key caps.

## Explicit non-goals

- **Not** changing `disableSignUp`, the login form's UX, or the recovery
  invariant that consuming a magic link marks an account verified
  (`core/test/auth.test.ts:284`) — a user stuck behind hard verification must
  keep that escape hatch.
- **Not** removing better-auth's per-IP `customRules`. They remain as a
  best-effort layer; on a topology where the address IS trustworthy
  (`RSC_TRUST_CLIENT_IP=on`, e.g. the bundled Caddy compose) they still add
  value. This spec adds a bound that holds *everywhere*.
- **Not** touching `/sign-in/anonymous` (10/60s) or
  `/request-password-reset`. Password reset mails only existing users and does
  not create accounts; anonymous sign-in sends no mail. Both inherit the same
  poisoned IP key and are worth a follow-up, but neither is a third-party mail
  vector.
- No new dependencies.

## Testing / acceptance

- **Bound holds:** N+1 requests for the same address within the window → the
  first N delegate to better-auth, the rest `429`, and **no mail is sent** for
  the rejected ones (assert against the mailer stub, not just the status).
- **Per-address, not global:** a second, different address is unaffected while
  the first is throttled — the bug being fixed is precisely a limiter that
  collapses onto one bucket.
- **Case/whitespace folding:** `A@B.test`, `a@b.test ` share one bucket.
- **No enumeration:** the 429 body/status for a throttled *existing* account and
  a throttled *unknown* address are byte-identical.
- **Window expiry:** after the window, the address is allowed again (fake timers,
  as in `logical-firehose-sse.test.ts`).
- **Mailer-off precedence:** with no mailer configured the route still answers
  503, unchanged — the throttle must not mask that.
- **Recovery invariant intact:** the existing magic-link → verified test still
  passes.
- **Completion gate:** core Vitest, `tsc`, web Vitest, `svelte-check`.

## Files (expected)

- `core/src/api/app.ts` — the `MAIL_GATED` handler gains the per-recipient check
  (or `core/src/auth.ts` if the plan picks the `hooks.before` seam instead).
- `core/src/config.ts` — optional operator knob for the limit/window, following
  the `RSC_*` validation style.
- `core/test/auth.test.ts` (or a sibling) — the cases above.
- `docs/superpowers/documentation/RUNNING.md` — the knob, if added.

## Sequencing

Spec → clean-context spec review (fold as revs) → `writing-plans` → clean-context
plan review → `subagent-driven-development` → merge. No code authorized by this
document.
