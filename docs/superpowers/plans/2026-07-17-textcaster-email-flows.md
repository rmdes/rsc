# Email Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish better-auth's email story: real hard email verification, magic-link sign-in, and password reset — over a pluggable SMTP mailer (Mailpit in dev, Cloudron in prod), with no unverifiable/unsweepable limbo accounts ever created.

**Architecture:** A `Mailer | null` seam (`core/src/mail.ts`, nodemailer) is handed to `createAuth`; better-auth's verification / magic-link / reset callbacks send through it. `requireEmailVerification: true` makes verification hard. When the mailer is null, a Hono guard refuses the email-account sub-routes BEFORE better-auth can create a row. The guest→registered upgrade is unchanged: probed, `onLinkAccount` fires at verification (not sign-up), so no limbo row is minted.

**Tech Stack:** better-auth@1.6.23 (magicLink plugin), nodemailer (new, exact-pinned), Hono, SvelteKit form actions, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-textcaster-email-flows-design.md` (rev 2, with the probed API facts + F-1 probe result). It wins on ambiguity.
- **Probed API facts (better-auth 1.6.23, do not re-derive):** verification via `emailAndPassword.requireEmailVerification` + `emailVerification.{ sendOnSignUp, sendVerificationEmail({user,url}) }`, sign-in-before-verify → 403, verify link is a GET. Magic link: `magicLink({ sendMagicLink({email,url,token}) })`, request `POST /sign-in/magic-link {email}`, consuming sets `emailVerified=1` (verified invariant holds by default), no new tables. Reset: `emailAndPassword.sendResetPassword({user,url,token})`, request **`POST /request-password-reset {email,redirectTo}`** (NOT `/forget-password` — 404s), completion `POST /reset-password {newPassword,token}`.
- **F-1 (probed):** `onLinkAccount` fires at VERIFICATION, not sign-up; sign-up-while-anon keeps the anon session; NO limbo core row. The existing `onLinkAccount` (auth.ts:42-51) is already correctly timed — do NOT add deferral logic. Still write both invariant tests.
- **F-2:** when `mailer === null`, refuse email-account routes up front — never create then fail. Hard verification stays unconditional (never auto-verify).
- **No migration:** all flows reuse migration-8's `verification` table (probed).
- New dep `nodemailer` (+ `@types/nodemailer`) in **core only**, exact-pinned. Plain-text emails only.
- Existing anonymous-guest, session-middleware, `/me`, and bearer-ops-token behavior: untouched. Existing tests pass unmodified unless they exercise a route whose auth contract this plan changes.
- Shared checkout: stage EXPLICIT paths only (never `git add -A`). Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- UI work (Task 3) invokes `ui-ux-pro-max:ui-ux-pro-max` first; tokens only, no raw hex, plain SSR forms that work without JS.

---

### Task 1: Mailer seam + config

**Files:**
- Create: `core/src/mail.ts`
- Modify: `core/package.json` (deps)
- Modify: `core/src/config.ts` (+ `smtpUrl`, `mailFrom`, `mailEnabled`)
- Test: Create `core/test/mail.test.ts`; extend `core/test/config.test.ts`

**Interfaces:**
- Produces: `interface Mailer { send(to: string, subject: string, text: string): Promise<void> }`; `createMailer(smtpUrl: string | null, from: string): Mailer | null`; config fields `smtpUrl: string | null`, `mailFrom: string`, `mailEnabled: boolean` (`=== smtpUrl !== null`).

- [ ] **Step 1: Install the dependency**

```bash
cd /home/rmdes/textcaster
npm install -w core --save-exact nodemailer
npm install -w core --save-dev --save-exact @types/nodemailer
```

Verify both appear in `core/package.json` with exact versions (no `^`).

- [ ] **Step 2: Config — failing tests first**

Append to `core/test/config.test.ts` (match its env-object style; every existing `loadConfig` fixture already carries `TEXTCASTER_AUTH_SECRET`):

```ts
test('mail config: absent SMTP url disables mail; present enables it', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's' })
  expect(c.smtpUrl).toBeNull()
  expect(c.mailEnabled).toBe(false)
  expect(c.mailFrom).toMatch(/@/) // has a sane default
  const c2 = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_SMTP_URL: 'smtp://localhost:1025', TEXTCASTER_MAIL_FROM: 'hi@ex.test' })
  expect(c2.smtpUrl).toBe('smtp://localhost:1025')
  expect(c2.mailEnabled).toBe(true)
  expect(c2.mailFrom).toBe('hi@ex.test')
})
```

Implement in `config.ts` (near `webOrigin`):

```ts
  const smtpUrl = env.TEXTCASTER_SMTP_URL ?? null
  // From-address default derives from the public origin's host, else webOrigin's.
  const mailHost = new URL(publicUrl ?? webOrigin).host
  const mailFrom = env.TEXTCASTER_MAIL_FROM ?? `textcaster@${mailHost}`
```

Add `smtpUrl`, `mailFrom`, and `mailEnabled: smtpUrl !== null` to the `Config` interface and the returned object.

- [ ] **Step 3: `core/src/mail.ts` — failing test first**

`core/test/mail.test.ts`:

```ts
import { test, expect } from 'vitest'
import { createMailer } from '../src/mail.ts'

test('createMailer returns null when smtpUrl is null', () => {
  expect(createMailer(null, 'from@ex.test')).toBeNull()
})

test('createMailer builds a mailer for smtp:// and smtps:// urls', () => {
  expect(createMailer('smtp://localhost:1025', 'from@ex.test')).not.toBeNull()
  expect(createMailer('smtps://u:p@mail.ex:465', 'from@ex.test')).not.toBeNull()
})
```

Implement:

```ts
import nodemailer from 'nodemailer'

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>
}

// null when no SMTP is configured — callers gate on this (a mailer-less
// instance refuses email-account routes rather than creating limbo accounts).
export function createMailer(smtpUrl: string | null, from: string): Mailer | null {
  if (!smtpUrl) return null
  const transport = nodemailer.createTransport(smtpUrl) // parses smtp:// and smtps:// (auth, port, TLS) from the URL
  return {
    async send(to, subject, text) {
      await transport.sendMail({ from, to, subject, text })
    },
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npm test -w core -- config mail && npm run typecheck -w core
git add core/package.json package-lock.json core/src/mail.ts core/src/config.ts core/test/mail.test.ts core/test/config.test.ts
git commit -m "core: SMTP mailer seam (nodemailer) + mail config

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: better-auth wiring — verification, magic link, reset, null-mailer gate

**Files:**
- Modify: `core/src/auth.ts` (`AuthDeps` + `createAuth` config)
- Modify: `core/src/api/app.ts` (mount-time null-mailer guard)
- Modify: `core/src/server.ts` (build + pass the mailer)
- Test: extend `core/test/auth.test.ts`; extend the test `makeAuth`/`makeApp` helpers

**Interfaces:**
- Consumes: `Mailer` (Task 1); existing `createAuth`, `sessionAuth`, `anonSession`/`registeredSession` test helpers.
- Produces: `createAuth(deps)` where `AuthDeps` gains `mailer: Mailer | null`; the app refuses `POST /api/auth/sign-up/email`, `/api/auth/sign-in/magic-link`, `/api/auth/request-password-reset` with 503 when `mailer === null`.

- [ ] **Step 1: Wire the callbacks + plugin in `core/src/auth.ts`**

`AuthDeps` gains `mailer: Mailer | null`. Add to the imports: `import { anonymous, magicLink } from 'better-auth/plugins'`. In the `betterAuth({...})` config:

```ts
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true, // hard verification (spec decision)
      sendResetPassword: async ({ user, url }) => {
        if (!deps.mailer) throw new Error('email is not configured on this instance')
        await deps.mailer.send(user.email, 'Reset your Textcaster password', `Reset your password: ${url}`)
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        if (!deps.mailer) throw new Error('email is not configured on this instance')
        await deps.mailer.send(user.email, 'Verify your Textcaster email', `Verify your email: ${url}`)
      },
    },
```

Add to `plugins` (keep the existing `anonymous({...})` block unchanged):

```ts
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          if (!deps.mailer) throw new Error('email is not configured on this instance')
          await deps.mailer.send(email, 'Your Textcaster login link', `Log in: ${url}`)
        },
      }),
```

Add a rate-limit rule beside the existing anonymous one:

```ts
    rateLimit: { enabled: true, customRules: { '/sign-in/anonymous': { window: 60, max: 10 }, '/sign-in/magic-link': { window: 60, max: 5 } } },
```

- [ ] **Step 2: Null-mailer route guard in `core/src/api/app.ts`**

`createApp` deps already carry `auth`; add the mailer flag. Right BEFORE the `app.on(['GET','POST'], '/api/auth/*', …)` mount, insert:

```ts
  // F-2: without a configured mailer, refuse the routes that would create an
  // unverifiable account (or send mail we cannot send) — up front, so no
  // limbo row is ever written. GET flows (verify/reset links) are unaffected.
  const MAIL_GATED = new Set(['/api/auth/sign-up/email', '/api/auth/sign-in/magic-link', '/api/auth/request-password-reset'])
  app.on('POST', [...MAIL_GATED], (c) => {
    if (deps.mailEnabled) return deps.auth.handler(c.req.raw)
    return c.json({ error: 'email accounts are not available on this instance' }, 503)
  })
```

(Register these specific POST routes BEFORE the wildcard `/api/auth/*` so they win; the wildcard still handles everything else. Add `mailEnabled: boolean` to `createApp`'s deps; `server.ts` passes `config.mailEnabled`, test helpers pass `true` unless a test targets the gate.)

- [ ] **Step 3: `server.ts` builds the mailer**

```ts
import { createMailer } from './mail.ts'
// after repo/config:
const mailer = createMailer(config.smtpUrl, config.mailFrom)
const auth = createAuth({ /* existing */, mailer })
// createApp({ …, mailEnabled: config.mailEnabled })
```

Every test `makeAuth` helper gains `mailer`. Add a shared capturing fake in `core/test/auth-helper.ts`:

```ts
export function fakeMailer() {
  const sent: Array<{ to: string; subject: string; text: string }> = []
  return { sent, mailer: { send: async (to: string, subject: string, text: string) => void sent.push({ to, subject, text }) } }
}
```

`makeAuth`/`makeApp` accept an optional mailer (default: a fresh `fakeMailer().mailer`) and an optional `mailEnabled` (default true). Extract the emailed link with `/(https?:\/\/\S+)/.exec(text)![1]`.

- [ ] **Step 4: Failing flow tests (`core/test/auth.test.ts`)**

```ts
test('hard verification: login blocked until the emailed link is visited', async () => {
  const { app, mail } = await makeApp() // makeApp exposes the capturing fake
  const su = await app.request('/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test' }, body: JSON.stringify({ email: 'a@b.test', password: 'password123', name: 'a' }) })
  expect(su.status).toBe(200)
  const verifyUrl = /(https?:\/\/\S+)/.exec(mail.sent.find((m) => /verify/i.test(m.subject))!.text)![1]
  const before = await app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test' }, body: JSON.stringify({ email: 'a@b.test', password: 'password123' }) })
  expect(before.status).toBe(403)
  await app.request(verifyUrl, { headers: { origin: 'http://web.test' } })
  const after = await app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test' }, body: JSON.stringify({ email: 'a@b.test', password: 'password123' }) })
  expect(after.status).toBe(200)
})

test('magic link logs in and marks the account verified', async () => {
  const { app, mail } = await makeApp()
  const r = await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test' }, body: JSON.stringify({ email: 'm@b.test' }) })
  expect(r.status).toBe(200)
  const link = /(https?:\/\/\S+)/.exec(mail.sent.find((m) => /log in/i.test(m.subject))!.text)![1]
  const consume = await app.request(link, { headers: { origin: 'http://web.test' } })
  expect((consume.headers.get('set-cookie') ?? '')).toContain('session_token')
})

test('password reset: request emails a link, reset changes the password', async () => {
  const { app, mail } = await makeApp()
  // create + verify a user first (reuse the verification flow helper)
  // … sign-up + visit verify link …
  const rp = await app.request('/api/auth/request-password-reset', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test' }, body: JSON.stringify({ email: 'a@b.test', redirectTo: 'http://web.test/reset' }) })
  expect(rp.status).toBe(200)
  expect(mail.sent.some((m) => /reset/i.test(m.subject))).toBe(true)
  // token is in the link's query; POST /reset-password { newPassword, token } → 200, then old password fails / new works
})

test('mailer null gates email routes with 503 and creates NO account row', async () => {
  const { app, repo } = await makeApp({ mailEnabled: false, mailer: null })
  const before = repo.raw.prepare('SELECT COUNT(*) n FROM user').get() as { n: number }
  const su = await app.request('/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test' }, body: JSON.stringify({ email: 'a@b.test', password: 'password123', name: 'a' }) })
  expect(su.status).toBe(503)
  const after = repo.raw.prepare('SELECT COUNT(*) n FROM user').get() as { n: number }
  expect(after.n).toBe(before.n) // no limbo row
})
```

- [ ] **Step 5: Guest-upgrade invariants (F-1), both paths**

```ts
test('guest upgrade: register while anon, verify, sign in — prior posts keep their identity', async () => {
  const { app, mail, service } = await makeApp()
  const anon = await anonSession(app)
  await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: anon }, body: '{"content":"guest post"}' })
  const guest = (await (await app.request('/me', { headers: { cookie: anon } })).json()).user
  await app.request('/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie: anon }, body: JSON.stringify({ email: 'g@b.test', password: 'password123', name: 'g' }) })
  const verifyUrl = /(https?:\/\/\S+)/.exec(mail.sent.find((m) => /verify/i.test(m.subject))!.text)![1]
  await app.request(verifyUrl, { headers: { origin: 'http://web.test' } })
  const signedIn = await app.request('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test' }, body: JSON.stringify({ email: 'g@b.test', password: 'password123' }) })
  const cookie = /(?:^|,)\s*([^,;]*session_token[^;]*)/.exec(signedIn.headers.get('set-cookie') ?? '')![1]
  const me = (await (await app.request('/me', { headers: { cookie } })).json()).user
  expect(me.id).toBe(guest.id) // SAME core user — the guest's posts stayed put
  const timeline = (await (await app.request('/timeline')).json()).timeline
  expect(timeline.some((e: { content: string }) => e.content === 'guest post')).toBe(true)
})

test('guest upgrade abandoned: register but never verify — guest stays anonymous and is swept', async () => {
  const { app, repo } = await makeApp()
  const anon = await anonSession(app)
  const guest = (await (await app.request('/me', { headers: { cookie: anon } })).json()).user
  await app.request('/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://web.test', cookie: anon }, body: JSON.stringify({ email: 'x@b.test', password: 'password123', name: 'x' }) })
  // still anonymous: /me over the anon cookie is still the guest, still isAnonymous
  const me = await (await app.request('/me', { headers: { cookie: anon } })).json()
  expect(me.isAnonymous).toBe(true)
  expect(me.user.id).toBe(guest.id)
  // age the anon session past TTL and sweep — the guest core row is reclaimed, no orphan
  const old = new Date(Date.now() - 8 * 86400_000).toISOString()
  repo.raw.prepare('UPDATE session SET updatedAt = ? WHERE userId = ?').run(old, guest.authUserId)
  repo.raw.prepare('UPDATE user SET createdAt = ? WHERE id = ?').run(old, guest.authUserId)
  const { swept } = repo.sweepAnonymousUsers(7)
  expect(swept).toBeGreaterThanOrEqual(1)
  expect(await repo.getUserByHandle(guest.handle)).toBeUndefined()
})
```

(These lean on the probe: `onLinkAccount` fires at verification, so path (a) shows same-id and path (b) leaves the guest anonymous. If either fails, the probe assumption broke — STOP and report, don't paper over.)

- [ ] **Step 6: Run + commit**

```bash
npm test -w core && npm run typecheck -w core
git add core/src/auth.ts core/src/api/app.ts core/src/server.ts core/test/auth.test.ts core/test/auth-helper.ts
git commit -m "core: hard email verification, magic link, password reset over the mailer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Web surface — pages, actions, mail gate, docs

**REQUIRED FIRST:** invoke `ui-ux-pro-max:ui-ux-pro-max`; follow `design-system/textcaster/MASTER.md` (tokens, no raw hex, plain SSR forms).

**Files:**
- Modify: `web/src/routes/+layout.server.ts` (expose `mailEnabled`)
- Modify: `web/src/routes/register/+page.server.ts` + `+page.svelte` (check-inbox state, gate)
- Modify: `web/src/routes/login/+page.server.ts` + `+page.svelte` (magic-link form, gate)
- Create: `web/src/routes/forgot/+page.server.ts` + `+page.svelte`; `web/src/routes/reset/+page.server.ts` + `+page.svelte`
- Modify: `web/src/routes/+layout.svelte` (verify nudge → "email me a login link")
- Modify: `docs/superpowers/documentation/RUNNING.md`
- Test: extend `web/src/routes/auth.actions.test.ts`

**Interfaces:**
- Consumes: core routes from Task 2; `cookieHeader`/`relaySetCookies`/`authedFetch` from `session.ts`.
- Produces: the user-facing email UX. `data.mailEnabled` from the layout.

- [ ] **Step 1: Layout exposes `mailEnabled`.** Core adds a tiny public flag to an existing surface — reuse `GET /health` to return `{ ok: true, mailEnabled }` (one-line change in app.ts's health route), and `+layout.server.ts` reads it once (fail-soft to `false`). Return `{ me, mailEnabled }`.

- [ ] **Step 2: Register → check-inbox.** In `register/+page.server.ts`, on a 200 from `/sign-up/email`, DON'T redirect as logged-in — return `{ checkInbox: true, email }`. On 503 (mail gated) return `fail(503, { error: 'Email accounts are not available on this instance — post as a guest instead.' })`. `+page.svelte`: when `form?.checkInbox`, replace the form with "Check your inbox — we sent a verification link to {email}." When `!data.mailEnabled`, render the gate message instead of the form.

- [ ] **Step 3: Login gains magic link.** Add a `magic` action posting `/api/auth/sign-in/magic-link { email }` (relay cookies; success → `{ magicSent: true }` → "Check your inbox for a login link"). `+page.svelte`: a second form "Email me a login link" beside the password form, both hidden behind `{#if data.mailEnabled}` (password login still shown, but a passwordless-only instance is not a thing here — keep password form visible; gate only the magic-link + register links when mail is off).

- [ ] **Step 4: `/forgot` + `/reset`.** `/forgot`: email form → `POST /api/auth/request-password-reset { email, redirectTo: <origin>/reset }`; always show "If that email exists, we sent a reset link" (no account enumeration). `/reset`: reads `token` from the query, posts `{ newPassword, token }` to `/api/auth/reset-password`; success → redirect `/login` with a flash; error → inline. Gate both behind `data.mailEnabled`.

- [ ] **Step 5: Verify nudge.** In `+layout.svelte`, a registered-but-unverified user (reachable if a session ever resolves unverified — else this branch is dormant, which is fine) sees "Verify your email — [email me a login link]" linking `/login` (the magic-link route is the unblock, per spec). Keep it one line, tokens only.

- [ ] **Step 6: RUNNING.md.** `TEXTCASTER_SMTP_URL` / `TEXTCASTER_MAIL_FROM`; Mailpit one-liner `docker run -p 1025:1025 -p 8025:8025 axllent/mailpit` (UI at :8025); hard-verification behavior (accounts can't log in until verified; magic link both logs in and verifies; without SMTP, email accounts are unavailable and guests are the path); Cloudron note (its mail addon's env → `TEXTCASTER_SMTP_URL`).

- [ ] **Step 7: Action tests** (`web/src/routes/auth.actions.test.ts`, mocked-event pattern): register success → checkInbox state (NOT a redirect); register under 503 → gate error; magic action relays cookies + magicSent; forgot action posts to request-password-reset and always returns the neutral message; reset action maps token+newPassword.

- [ ] **Step 8: Gates + commit**

```bash
npm test -w web && cd web && npm run check && cd ..
git add web/src/routes/+layout.server.ts web/src/routes/+layout.svelte web/src/routes/register web/src/routes/login web/src/routes/forgot web/src/routes/reset docs/superpowers/documentation/RUNNING.md web/src/routes/auth.actions.test.ts core/src/api/app.ts
git commit -m "web: email UX — verify/magic-link/reset pages, mail-gated, docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Live Mailpit click-check (human-run, documented)

**Files:** none (verification only; findings noted in the final review).

- [ ] **Step 1:** Start Mailpit (`docker run -p 1025:1025 -p 8025:8025 axllent/mailpit`), set `TEXTCASTER_SMTP_URL=smtp://localhost:1025` in core's env, restart both servers.
- [ ] **Step 2:** Against the live stack, both themes: register → the account can't log in yet → Mailpit (:8025) shows the verification mail → click → log in works. Request a magic link → Mailpit → click → logged in and verified. Forgot password → Mailpit → reset → new password works, old fails. With `TEXTCASTER_SMTP_URL` unset, register/magic-link/forgot show the "not available" gate and guests still work.

(This task is the human gate; the controller records the outcome and does not dispatch a subagent for it.)

---

## Plan self-review notes (done at write time)

- Spec coverage: mailer seam + config (T1), hard verification + magic link + reset wiring (T2), null-mailer gate F-2 with no-limbo-row assertion (T2 Step 2/4), guest-upgrade invariants F-1 both paths (T2 Step 5), magic-link-verifies invariant (T2 Step 4), verify-nudge-as-magic-link recovery (T3 Step 5), web pages/gates (T3), RUNNING.md incl. Mailpit + Cloudron (T3 Step 6), F-3 (spec-noted, deferred — no task, correct), human Mailpit loop (T4).
- Probe-derived simplifications baked in: no deferral logic (F-1 fires at verification by default); no `emailVerified` flag on magic link (set by default); reset endpoint is `/request-password-reset` not `/forget-password`; no migration (verification table reused).
- Type consistency: `Mailer`/`createMailer(smtpUrl,from)`, `mailEnabled`, `AuthDeps.mailer`, `createApp({…mailEnabled})`, `fakeMailer()` used identically across tasks.
- Two web test blocks (T2's reset completion, T3 actions) name assertions over existing harnesses that better-auth reshaped — implementers wire setup with the file's helpers; NEEDS_CONTEXT is the escape hatch, not invention.
