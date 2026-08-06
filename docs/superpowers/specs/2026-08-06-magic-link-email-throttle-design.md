# Bounding magic-link mail abuse — Design

**Status: IMPLEMENTED 2026-08-06 (`a85c639`), deployed to all five instances on
`270d163`.** Shipped exactly rev 2's recommendation: the instance-wide cap alone
(20 mails/hour, module constants, a better-auth `hooks.before` plugin in
`core/src/auth.ts`). The per-recipient layer was NOT built — see the open
decision below, now closed as "no".

**⛔ Rev 2's section "Also fix: the existing per-IP rule contradicts our own
policy" is VOID.** It rested on `RSC_TRUST_CLIENT_IP`, a flag built on a false
premise and since removed entirely (`270d163`). Cloudron sets both `X-Real-IP`
and `X-Forwarded-For` to `$remote_addr` and discards the client's value, so the
per-IP `customRules` in `core/src/auth.ts:221` are fed a trustworthy address and
remain unconditional. Ignore every `trustClientIp` reference in this document;
they describe code that no longer exists. See memory `cloudron-networking-verified`.


**History:** Rev 2 (2026-08-06; clean-context ponytail review folded — 2 Criticals,
3 Importants, 4 Cuts). **Rev 1 was NOT READY and its central mechanism was
wrong**: it proposed a per-recipient throttle as the primary bound, which bounds
nothing in aggregate (C1) and manufactures a targeted-denial vector this repo's
own doctrine calls worse than no control at all (C2). Rev 2 makes an
**instance-wide cap** the bound. Authorizes no code (→ plan → SDD).

## Problem

`POST /api/auth/sign-in/magic-link` mails a login link to **any address given**,
and `magicLink()` runs with better-auth's default `disableSignUp: false`
(`core/src/auth.ts:28-33`; default confirmed in
`node_modules/better-auth/dist/plugins/magic-link/index.d.mts`), so an unknown
address also gets an account created — `core/test/auth.test.ts:276-289` proves
it: a fresh `m@b.test` ends up a `user` row with `emailVerified = 1`. The
instance is a mailer any anonymous caller can aim at a third party.

The only brake is better-auth's per-IP rule
(`core/src/auth.ts:221`, `/sign-in/magic-link` `{ window: 60, max: 5 }`).
**Corrected 2026-08-06:** rev 1/2 claimed that key was forgeable on Cloudron.
It is not — Cloudron sets `X-Forwarded-For` to `$remote_addr` and discards the
client's value (see memory `cloudron-networking-verified`), so the per-IP rule
works as intended. It still does not bound AGGREGATE volume, which is the real
gap and the reason the instance-wide cap below was built.

Consequences, in severity order:

1. **Third-party mail abuse** — unbounded login mail to addresses whose owners
   never gave them to us. Deliverability damage lands on the instance's domain.
2. **Unbounded account creation** — each such request also writes a user row.
3. **Targeted login denial** — a victim kept from requesting a link.

## What actually bounds this (rev 2 — C1)

**Volume is bounded only by a ceiling the caller cannot multiply.** Rev 1
proposed *3 per hour per recipient address*. That is not a bound: an attacker
supplies the address, and addresses are harvested target lists, not credentials —
3/hour × unlimited addresses is still unlimited mail and unlimited user rows, so
consequences #1 and #2 stayed wide open. This repo already refuted the identical
argument shape about IPs, in `core/src/api/logical-routes/public.ts:214-217`:

> *"A per-IP cap alone bounds nothing: addresses are free, so N attackers get
> N\*maxPerIp streams. This endpoint is anonymous, so the GLOBAL ceiling is the
> one that actually protects the process."*

**Primary control: an instance-wide magic-link mail cap per fixed window.**
Unforgeable by construction — it counts *messages sent*, not identities, so
nothing a caller supplies can inflate it or aim it. This is the direct analogue
of `maxConnectionsTotal` (`public.ts:217`) and it is what closes #1 and #2.

Proposed default: **20 magic-link mails per hour instance-wide**, a module
constant. Rationale: a healthy small instance sends a handful of login links a
day; 20/hour is far above organic use and far below anything that damages a
sending domain. On reaching the cap the route answers 429 without sending.

**Accepted cost, stated plainly:** a global cap is exhaustible, so a determined
attacker can spend it and deny magic-link login to *everyone* for the rest of the
window. That is strictly better than the alternatives — the damage is undirected
(no victim can be singled out), it is self-healing at the window boundary, and
`/register` + password login remain unaffected. It is the same trade the firehose
already accepts.

## The per-recipient layer — OPEN DECISION (rev 2 — C2)

Rev 1's per-address throttle is **not** reinstated as the bound. Whether it
survives at all as a secondary fairness layer is an open decision for the
operator, because it carries a cost this project has already ruled on:

- **Against.** The email is caller-supplied, and unlike an IP it is the victim's
  real, publicly-known identifier — no guessing, no rotation. Three requests for
  `victim@example.com` deny that person magic-link login for the whole window.
  The rule this project applied at the time — *a limit fed caller-supplied
  input that lets anyone lock out a chosen victim is worse than having no
  limit* — was written into `config.ts`/`RUNNING.md` alongside the since-removed
  `RSC_TRUST_CLIENT_IP` flag; those citations no longer resolve, but the
  principle stands and is why this layer was not built. A passwordless user
  (one who never set a password) has no escape hatch during that window.
- **For.** Without it, the whole global budget can be aimed at one inbox.
- **If kept, it must be cheap and short:** 3 per **15 minutes** per address, not
  per hour — the window length *is* the lockout duration. That still caps one
  address at 12 mails/hour (useless for flooding) while cutting the denial from
  60 minutes to 15.

**Recommendation: ship the global cap alone first.** It closes the severe
consequences, adds no denial vector, and is the smaller change. Add the
per-recipient layer only if a real inbox-flooding incident shows the global cap
insufficient — at which point the tradeoff is being paid for a measured reason
rather than a hypothetical one.

## Placement — core, via a better-auth `hooks.before` plugin (rev 2 — I1)

There are **two** independent paths to this route and only core sees both
(verified):

- `web/src/routes/login/+page.server.ts:33` fetches
  `${base()}/api/auth/sign-in/magic-link` **directly**, bypassing the
  `/api/auth/[...path]` proxy.
- `web/src/routes/api/auth/[...path]/+server.ts` relays the same path.

A web-side gate would miss the primary path. **The gate lives in core.**

**Seam: a third `hooks.before` plugin in `core/src/auth.ts`**, matching the two
existing precedents (`reject-anon-api-key-create` at `auth.ts:128-141`,
`reject-non-admin-admin-key` at `auth.ts:172-181`). Matcher:
`ctx.path === '/sign-in/magic-link'`; rejection is one line —
`throw new APIError('TOO_MANY_REQUESTS', …)` → 429.

**Rev 1 preferred the `MAIL_GATED` handler (`core/src/api/app.ts:259-263`) and
that was wrong.** Reading the body there means `c.req.json()`, which resolves via
`cachedBody('text') → raw.text()` (`node_modules/hono/dist/request.js:103,118`)
and **consumes `c.req.raw`'s body**, so the subsequent
`deps.auth.handler(c.req.raw)` receives an unusable request unless explicitly
`.clone()`d. It would also need path discrimination (`MAIL_GATED` covers three
paths) and hand-validation of untrusted JSON. The `hooks.before` seam has none of
those problems: `ctx.body` is already parsed. Rev 1's stated reasons for
preferring `MAIL_GATED` (no `getSessionFromCtx`, no in-process discrimination)
do not apply — a volume cap needs no session, and there is no in-process
magic-link caller.

## Mechanism

In the `hooks.before` handler, before better-auth processes the request:

- A single fixed window: `let windowEnd`, `let sent`. If `now >= windowEnd`,
  reset (`sent = 0; windowEnd = now + WINDOW`). If `sent >= MAX`, throw 429.
  Otherwise increment.
- **No sweep machinery** (rev 2 — Cut). Rev 1 reproduced the firehose's
  per-key `windowStart` + `sweepExpired*` + `lastSweep` apparatus. A single
  global fixed window needs none of it: two integers, reset on rollover. The
  firehose needed per-key windows because each IP's window starts on first
  sight; nothing here does. (If the per-recipient layer is ever added, a
  `Map` cleared wholesale on rollover — not per-entry sweeping — is sufficient.)
- **ponytail:** single-process in-memory counter, reset on deploy/restart — the
  same accepted ceiling and the same named upgrade path (a shared store if an
  instance ever runs multiple replicas) as the firehose caps and api-key caps.
- **No operator knob** (rev 2 — Cut). Module constants, matching the hardcoded
  literal at `auth.ts:221` and the firehose's constructor defaults. Add an
  `RSC_*` var when an operator actually asks.

## ~~Also fix: the existing per-IP rule contradicts our own policy (rev 2 — I2)~~ ⛔ VOID

**This entire section is void — never implemented, premise false.** It rested on
`RSC_TRUST_CLIENT_IP`, removed in `270d163`. Cloudron supplies a trustworthy
client address, so the per-IP `customRules` stay unconditional. Kept only as a
record of the wrong turn.

`config.ts:90` computes `trustClientIp` but `server.ts:103` wires it to the
firehose **only**; `auth.ts:221` applies its per-IP limits unconditionally, on
input `config.ts:76-79` documents as forgeable. Under this project's own rule
that such a limit is worse than none, set
`customRules['/sign-in/magic-link'] = false` when `!trustClientIp` — one line,
`customRules` accepts `false` — removing an existing targeted-denial vector
rather than preserving it. (Rev 1 waved this away as a non-goal without noticing
the contradiction.) `/sign-in/anonymous` is in the same position and should get
the same treatment; it sends no mail, so it is not otherwise in scope here.

## Explicit non-goals

- **Not** changing `disableSignUp`, the login form's UX, or the recovery
  invariant that consuming a magic link marks an account verified
  (`core/test/auth.test.ts:284-289`).
- **Not** `trustedProxies`. It exists in better-auth 1.6.23
  (`@better-auth/core/dist/types/init-options.d.mts:196-210`) and walks the XFF
  chain right-to-left skipping trusted hops — but on Cloudron the only
  non-claim hop is the shared docker bridge, so it still lands on the attacker's
  value. Conclusion unchanged.
- **Not** `/request-password-reset` (mails only existing users, creates no
  accounts).
- No new dependencies.

## Testing / acceptance (rev 2 — trimmed)

- **The bound holds:** MAX+1 requests within the window → the first MAX delegate
  to better-auth, the rest 429, and **no mail is sent** for the rejected ones
  (assert the mailer stub, not just the status). Fold the window-expiry assert
  into this test (fake timers, as in `logical-firehose-sse.test.ts`).
- **Distinct addresses do not evade it:** MAX+1 requests each to a *different*
  address still 429s — this is the C1 regression, the exact thing rev 1 got
  wrong, and it must be pinned.
- **Mailer-off precedence:** with no mailer, the route still answers 503
  unchanged (`app.ts:259-263`); the cap must not mask it.
- **Recovery invariant intact:** the existing magic-link → verified test passes.
- **Completion gate:** core Vitest, `tsc`, web Vitest, `svelte-check`.

## Files (expected)

- `core/src/auth.ts` — the `hooks.before` plugin + the `!trustClientIp`
  `customRules` change; module constants for MAX/WINDOW.
- `core/test/auth.test.ts` (or a sibling) — the cases above.

## Sequencing

Spec → `writing-plans` → clean-context plan review → `subagent-driven-development`
→ merge. No code authorized by this document.
