# Multi-session (account switching) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one browser hold several registered accounts on the same instance and switch the active one without re-login (admin + everyday account), via better-auth's `multiSession()` plugin driven server-side.

**Architecture:** Core adds `multiSession({ maximumSessions: 4 })` (one line, no migration). Web gets a `/accounts` page whose load lists the held sessions (filtering out the anonymous guest), and whose form actions switch/log-out through the existing `/api/auth/*` + cookie relay — no better-auth client SDK, all no-JS forms.

**Tech Stack:** better-auth `1.6.23` (`multiSession` from `better-auth/plugins`), Hono (core), SvelteKit (web), vitest.

**Spec:** `docs/superpowers/specs/2026-07-19-multi-session-design.md` (rev 3).

## Global Constraints

- **No new dependency.** `multiSession` ships in the already-installed `better-auth`.
- **All corrections from the spec review (M1–M10) are load-bearing:**
  - `list-device-sessions` is **GET**, not POST (M3).
  - The **guest is in the session set**; the web layer filters `isAnonymous` entries out of `/accounts` (M1). `maximumSessions: 4` (guest slot + up to 3 real).
  - `/accounts` guard tests **`me.isAnonymous`**, not `hasSession` alone (M4).
  - Forms submit an **opaque id, never a raw `sessionToken`** (M5); the action resolves the token server-side.
  - Per-account logout is **`set-active(chosen) then revoke(old)`** — never a bare `revoke` of the active token (M2), to avoid the plugin's arbitrary `validSessions[0]` auto-promote. When NO other registered account remains, use **`signOut` (revoke-all), not `revoke(active)`** — the latter would promote a lingering guest to active (R1).
  - Plugin-behavior tests live in **core** (real better-auth over `:memory:`); the web fetch-stub harness can't observe them (M6).
- **Node 22 native type-stripping:** vitest passes on type errors — after type changes run `npm run typecheck -w core` and `npm run check -w web`, not just the tests.
- **Web tests run in the web container:** `docker compose exec -T web env -u CORE_API_URL npm test -w web -- <filter>`.
- **Git:** shared checkout — **never `git add -A`**; stage explicit paths. End every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Do NOT push.
- **UI:** no-JS `<form>` actions; house `--color-*` tokens only; follow `design-system/textcaster/MASTER.md` (invoke `ui-ux-pro-max:ui-ux-pro-max` before writing the component).

## File Structure

- `core/src/auth.ts` — register `multiSession()` (Task 1).
- `core/test/auth-helper.ts` — add a `cookieJar()` helper (Task 1).
- `core/test/multi-session.test.ts` — new; core behavioral tests (Task 1).
- `web/src/lib/api.ts` — add `listDeviceSessions` / `getActiveAuthUserId` / `setActiveSession` / `revokeSession` (Task 2).
- `web/src/lib/api.test.ts` — stub tests for the new helpers (Task 2).
- `web/src/routes/accounts/+page.server.ts` — new; load + `switch`/`logoutOne`/`logoutAll` actions (Task 3).
- `web/src/routes/accounts/accounts.server.test.ts` — new; load/action tests (Task 3).
- `web/src/routes/accounts/+page.svelte` — new; the switcher UI (Task 4).
- `web/src/routes/settings/+page.svelte` — add a discovery link to `/accounts` (Task 4).

---

### Task 1: Core — register `multiSession` + core behavioral tests

**Files:**
- Modify: `core/src/auth.ts` (import + plugins array)
- Modify: `core/test/auth-helper.ts` (add `cookieJar`)
- Test: `core/test/multi-session.test.ts` (create)

**Interfaces:**
- Consumes: `makeAuth(repo, mailer?, authOpenApi?)`, `registeredSession(app, email, repo)`, `createApp(...)`, `uniqueIp()` (existing test helpers).
- Produces: `cookieJar()` → `{ absorb(res: Response): void; header(): string }` in `auth-helper.ts`.

- [ ] **Step 1: Write the failing test**

Add to `core/test/auth-helper.ts` (a jar that accumulates every Set-Cookie across requests — multi-session mints several; the existing helpers keep only one):
```ts
export function cookieJar() {
  const jar = new Map<string, string>()
  return {
    absorb(res: Response) {
      for (const sc of res.headers.getSetCookie()) {
        const pair = sc.split(';')[0]
        const eq = pair.indexOf('=')
        if (eq < 1) continue
        const name = pair.slice(0, eq).trim()
        const value = pair.slice(eq + 1).trim()
        if (value === '') jar.delete(name)
        else jar.set(name, value)
      }
    },
    header() {
      return [...jar.entries()].map(([n, v]) => `${n}=${v}`).join('; ')
    },
  }
}
```

Create `core/test/multi-session.test.ts`:
```ts
import { test, expect } from 'vitest'
import type { Hono } from 'hono'
import { createSqliteRepository, type SqliteRepository } from '../src/storage/sqlite.ts'
import { createApp } from '../src/api/app.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { makeAuth, cookieJar, uniqueIp } from './auth-helper.ts'

const ORIGIN = 'http://web.test'

// Sign up + verify + sign in `email`, carrying (and absorbing into) `jar`.
// With multiSession, a sign-in while jar already holds a session ADDS a session.
async function addAccount(app: Hono, repo: SqliteRepository, jar: ReturnType<typeof cookieJar>, email: string) {
  const up = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': uniqueIp(), cookie: jar.header() },
    body: JSON.stringify({ email, password: 'password123', name: email }),
  })
  jar.absorb(up)
  repo.raw.prepare('UPDATE user SET emailVerified = 1 WHERE email = ?').run(email.toLowerCase())
  const si = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': uniqueIp(), cookie: jar.header() },
    body: JSON.stringify({ email, password: 'password123' }),
  })
  if (si.status !== 200) throw new Error(`sign-in ${email} failed: ${si.status}`)
  jar.absorb(si)
}

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus, null)
  const auth = makeAuth(repo)
  const app = createApp({ service, bus, token: 'secret', auth, users: repo })
  return { repo, auth, app }
}

async function listSessions(app: Hono, jar: ReturnType<typeof cookieJar>) {
  // GET, not POST (M3)
  const res = await app.request('/api/auth/multi-session/list-device-sessions', {
    headers: { origin: ORIGIN, cookie: jar.header() },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Array<{ session: { token: string }; user: { id: string; email?: string; isAnonymous?: boolean } }>
}

test('set-active switches which account getSession returns', async () => {
  const { repo, auth, app } = await makeApp()
  const jar = cookieJar()
  await addAccount(app, repo, jar, 'a@example.com')
  await addAccount(app, repo, jar, 'b@example.com') // B is active (last sign-in)

  const list = await listSessions(app, jar)
  const a = list.find((s) => s.user.email === 'a@example.com')!
  expect(a).toBeTruthy()

  const setA = await app.request('/api/auth/multi-session/set-active', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: jar.header() },
    body: JSON.stringify({ sessionToken: a.session.token }),
  })
  expect(setA.status).toBe(200)
  jar.absorb(setA)

  const active = await auth.api.getSession({ headers: new Headers({ cookie: jar.header() }) })
  expect(active?.user.email).toBe('a@example.com')
})

test('deterministic logout: set-active(other) then revoke(old) leaves the chosen account active', async () => {
  const { repo, auth, app } = await makeApp()
  const jar = cookieJar()
  await addAccount(app, repo, jar, 'a@example.com')
  await addAccount(app, repo, jar, 'b@example.com') // active = B

  const list = await listSessions(app, jar)
  const a = list.find((s) => s.user.email === 'a@example.com')!
  const bActive = await auth.api.getSession({ headers: new Headers({ cookie: jar.header() }) })
  const bToken = list.find((s) => s.user.email === 'b@example.com')!.session.token

  // switch to A first
  jar.absorb(await app.request('/api/auth/multi-session/set-active', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: jar.header() },
    body: JSON.stringify({ sessionToken: a.session.token }),
  }))
  // then revoke the old (B) — B is no longer active, so no arbitrary auto-promote
  jar.absorb(await app.request('/api/auth/multi-session/revoke', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: jar.header() },
    body: JSON.stringify({ sessionToken: bToken }),
  }))

  const active = await auth.api.getSession({ headers: new Headers({ cookie: jar.header() }) })
  expect(active?.user.email).toBe('a@example.com')
  const remaining = await listSessions(app, jar)
  expect(remaining.some((s) => s.user.email === 'b@example.com')).toBe(false)
  expect(bActive?.user.email).toBe('b@example.com') // sanity: B had been active
})

test('R1 mechanism: signOut clears ALL held sessions (no promote to a survivor)', async () => {
  const { repo, auth, app } = await makeApp()
  const jar = cookieJar()
  await addAccount(app, repo, jar, 'a@example.com')
  await addAccount(app, repo, jar, 'b@example.com') // A + B held, B active
  jar.absorb(await app.request('/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: jar.header() },
    body: '{}',
  }))
  const active = await auth.api.getSession({ headers: new Headers({ cookie: jar.header() }) })
  expect(active).toBeNull() // everything cleared — signOut has no promote path (R1)
})

test('regression: anonymous first-visit still mints a guest, and it appears in the session set (M1)', async () => {
  const { app } = await makeApp()
  const jar = cookieJar()
  const anon = await app.request('/api/auth/sign-in/anonymous', {
    method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': uniqueIp() },
  })
  expect(anon.status).toBe(200)
  jar.absorb(anon)
  const list = await listSessions(app, jar)
  expect(list.length).toBe(1)
  expect(list[0].user.isAnonymous).toBe(true) // the guest IS in the set — the web layer must filter it
})

test('regression: a second sign-in ADDS a session rather than replacing', async () => {
  const { repo, app } = await makeApp()
  const jar = cookieJar()
  await addAccount(app, repo, jar, 'a@example.com')
  await addAccount(app, repo, jar, 'b@example.com')
  const list = await listSessions(app, jar)
  const emails = list.map((s) => s.user.email).sort()
  expect(emails).toEqual(['a@example.com', 'b@example.com'])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w core -- multi-session.test.ts`
Expected: FAIL — `multiSession` isn't registered, so `/api/auth/multi-session/*` 404s (list returns non-200) and the sign-ins don't accumulate.

- [ ] **Step 3: Register the plugin**

In `core/src/auth.ts`, add `multiSession` to the plugins import (line 2):
```ts
import { anonymous, magicLink, multiSession, openAPI } from 'better-auth/plugins'
```
Add it as an **unconditional** element of the `plugins` array (it is a product feature, always on — not flag-gated), after the `anonymous({...})` entry and before the `if (deps.authOpenApi)` line:
```ts
    multiSession({ maximumSessions: 4 }),
  ]
  if (deps.authOpenApi) plugins.push(openAPI())
```
(The array element goes inside the `[...]`; only `openAPI` stays conditional.)

- [ ] **Step 4: Run the tests + full suite + typecheck**

Run: `npm test -w core -- multi-session.test.ts`
Expected: PASS (5/5).
Run: `npm test -w core && npm run typecheck -w core`
Expected: whole core suite green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add core/src/auth.ts core/test/auth-helper.ts core/test/multi-session.test.ts
git commit -m "$(printf 'core(auth): register multiSession plugin (maximumSessions 4)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 2: Web — API client helpers

**Files:**
- Modify: `web/src/lib/api.ts` (add 4 functions near `getMe`)
- Test: `web/src/lib/api.test.ts` (append)

**Interfaces:**
- Consumes: `base()`, `errorMessage(res, fallback)` (existing module-privates in `api.ts`).
- Produces:
  - `DeviceSession = { session: { token: string }; user: { id: string; email: string; name: string; isAnonymous?: boolean } }`
  - `listDeviceSessions(f: typeof fetch): Promise<DeviceSession[]>`
  - `getActiveAuthUserId(f: typeof fetch): Promise<string | null>`
  - `setActiveSession(f: typeof fetch, sessionToken: string): Promise<Response>`
  - `revokeSession(f: typeof fetch, sessionToken: string): Promise<Response>`

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/api.test.ts`:
```ts
import { listDeviceSessions, getActiveAuthUserId, setActiveSession, revokeSession } from './api.ts'

test('listDeviceSessions GETs the multi-session list endpoint', async () => {
  const rows = [{ session: { token: 't1' }, user: { id: 'u1', email: 'a@x', name: 'a@x' } }]
  const f = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }))
  const out = await listDeviceSessions(f as unknown as typeof fetch)
  expect(out).toEqual(rows)
  const [url, init] = f.mock.calls[0] as [string, RequestInit | undefined]
  expect(url).toContain('/api/auth/multi-session/list-device-sessions')
  expect(init?.method ?? 'GET').toBe('GET')
})

test('getActiveAuthUserId reads /get-session user id, null when signed out', async () => {
  const f1 = vi.fn(async () => new Response(JSON.stringify({ session: {}, user: { id: 'u9' } }), { status: 200 }))
  await expect(getActiveAuthUserId(f1 as unknown as typeof fetch)).resolves.toBe('u9')
  const f2 = vi.fn(async () => new Response('null', { status: 200 }))
  await expect(getActiveAuthUserId(f2 as unknown as typeof fetch)).resolves.toBeNull()
})

test('setActiveSession POSTs the token as JSON and returns the response for cookie relay', async () => {
  const res = new Response('{}', { status: 200 })
  const f = vi.fn(async () => res)
  const out = await setActiveSession(f as unknown as typeof fetch, 'tok')
  expect(out).toBe(res)
  const [url, init] = f.mock.calls[0] as [string, RequestInit]
  expect(url).toContain('/api/auth/multi-session/set-active')
  expect(init.method).toBe('POST')
  expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  expect(JSON.parse(String(init.body))).toEqual({ sessionToken: 'tok' })
})

test('revokeSession POSTs the token to the revoke endpoint', async () => {
  const res = new Response('{}', { status: 200 })
  const f = vi.fn(async () => res)
  const out = await revokeSession(f as unknown as typeof fetch, 'old')
  expect(out).toBe(res)
  const [url, init] = f.mock.calls[0] as [string, RequestInit]
  expect(url).toContain('/api/auth/multi-session/revoke')
  expect(JSON.parse(String(init.body))).toEqual({ sessionToken: 'old' })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- api.test`
Expected: FAIL — the four functions are not exported.

- [ ] **Step 3: Implement the helpers**

Add to `web/src/lib/api.ts` (after `getMe`). These take a pre-wrapped `f` (the caller passes `authedFetch(fetch, url.origin, cookieHeader(cookies))`, which injects cookie + Origin):
```ts
export interface DeviceSession {
  session: { token: string }
  user: { id: string; email: string; name: string; isAnonymous?: boolean }
}

// GET (M3). f already carries cookie + Origin.
export async function listDeviceSessions(f: typeof fetch): Promise<DeviceSession[]> {
  const res = await f(`${base()}/api/auth/multi-session/list-device-sessions`)
  if (!res.ok) throw new Error(await errorMessage(res, `sessions ${res.status}`))
  return (await res.json()) as DeviceSession[]
}

// The active auth user id (better-auth's /get-session); null when signed out.
export async function getActiveAuthUserId(f: typeof fetch): Promise<string | null> {
  const res = await f(`${base()}/api/auth/get-session`)
  if (!res.ok) return null
  const body = (await res.json()) as { user?: { id?: string } } | null
  return body?.user?.id ?? null
}

// POST; caller relays the Set-Cookie the plugin returns.
export async function setActiveSession(f: typeof fetch, sessionToken: string): Promise<Response> {
  const res = await f(`${base()}/api/auth/multi-session/set-active`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionToken }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, `set-active ${res.status}`))
  return res
}

export async function revokeSession(f: typeof fetch, sessionToken: string): Promise<Response> {
  const res = await f(`${base()}/api/auth/multi-session/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionToken }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, `revoke ${res.status}`))
  return res
}
```

- [ ] **Step 4: Run the tests + svelte-check**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- api.test`
Expected: PASS.
Run: `docker compose exec -T web npm run check -w web`
Expected: svelte-check clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/api.test.ts
git commit -m "$(printf 'web(api): multi-session client helpers (list/active/set-active/revoke)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 3: Web — `/accounts` load + actions

**Files:**
- Create: `web/src/routes/accounts/+page.server.ts`
- Test: `web/src/routes/accounts/accounts.server.test.ts`

**Interfaces:**
- Consumes: Task 2's `listDeviceSessions` / `getActiveAuthUserId` / `setActiveSession` / `revokeSession`; existing `authedFetch` / `cookieHeader` / `relaySetCookies` (`$lib/server/session`); the parent layout's `me` (`{ user, isAnonymous } | null`).
- Produces: `load` → `{ accounts: { id: string; email: string; active: boolean }[] }`; actions `switch` (field `id`), `logoutOne`, `logoutAll`.

- [ ] **Step 1: Write the failing test**

Create `web/src/routes/accounts/accounts.server.test.ts`:
```ts
import { test, expect, vi } from 'vitest'
import { load, actions } from './+page.server.ts'

function ctx(over: Record<string, unknown> = {}) {
  return {
    fetch: vi.fn(),
    cookies: { getAll: () => [{ name: 'textcaster.session_token', value: 's' }], set: vi.fn(), delete: vi.fn() },
    url: new URL('http://x/accounts'),
    getClientAddress: () => '203.0.113.1',
    parent: async () => ({ me: { user: { handle: 'admin' }, isAnonymous: false } }),
    ...over,
  }
}

test('load redirects a guest/anon to / (M4)', async () => {
  const event = ctx({ parent: async () => ({ me: { user: { handle: 'g' }, isAnonymous: true } }) })
  await expect(load(event as never)).rejects.toMatchObject({ status: 303, location: '/' })
})

test('load redirects when signed out entirely', async () => {
  const event = ctx({ parent: async () => ({ me: null }) })
  await expect(load(event as never)).rejects.toMatchObject({ status: 303, location: '/' })
})

test('load lists registered accounts, filters the guest, marks active (M1/M8)', async () => {
  const list = [
    { session: { token: 't1' }, user: { id: 'u1', email: 'admin@x', name: 'admin@x' } },
    { session: { token: 't2' }, user: { id: 'u2', email: 'me@x', name: 'me@x' } },
    { session: { token: 'tg' }, user: { id: 'ug', email: 'guest', name: 'guest', isAnonymous: true } },
  ]
  const fetch = vi.fn(async (url: string) =>
    url.includes('get-session')
      ? new Response(JSON.stringify({ user: { id: 'u2' } }), { status: 200 })
      : new Response(JSON.stringify(list), { status: 200 })
  )
  const out = await load(ctx({ fetch }) as never)
  expect(out.accounts).toEqual([
    { id: 'u1', email: 'admin@x', active: false },
    { id: 'u2', email: 'me@x', active: true },
  ])
})

test('switch resolves the opaque id → token server-side and relays cookies (M5)', async () => {
  const list = [{ session: { token: 't1' }, user: { id: 'u1', email: 'a@x', name: 'a@x' } }]
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('list-device-sessions')) return new Response(JSON.stringify(list), { status: 200 })
    if (url.includes('set-active')) {
      expect(JSON.parse(String(init?.body))).toEqual({ sessionToken: 't1' }) // token resolved server-side, not from the form
      return new Response('{}', { status: 200, headers: { 'set-cookie': 'textcaster.session_token=t1; Path=/; HttpOnly' } })
    }
    throw new Error(`unexpected ${url}`)
  })
  const cookies = { getAll: () => [{ name: 'textcaster.session_token', value: 's' }], set: vi.fn(), delete: vi.fn() }
  const form = new URLSearchParams({ id: 'u1' })
  const event = ctx({ fetch, cookies, request: new Request('http://x/accounts?/switch', { method: 'POST', body: form }) })
  await expect(actions.switch(event as never)).rejects.toMatchObject({ status: 303, location: '/accounts' })
  expect(cookies.set).toHaveBeenCalledWith('textcaster.session_token', 't1', expect.objectContaining({ path: '/' }))
})

test('logoutOne switches to another registered account THEN revokes the old (M2 order)', async () => {
  const list = [
    { session: { token: 'tActive' }, user: { id: 'u1', email: 'a@x', name: 'a@x' } },
    { session: { token: 'tOther' }, user: { id: 'u2', email: 'b@x', name: 'b@x' } },
  ]
  const calls: string[] = []
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('get-session')) return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 })
    if (url.includes('list-device-sessions')) return new Response(JSON.stringify(list), { status: 200 })
    if (url.includes('set-active')) { calls.push('set-active'); return new Response('{}', { status: 200 }) }
    if (url.includes('revoke')) { calls.push('revoke'); return new Response('{}', { status: 200 }) }
    throw new Error(`unexpected ${url}`)
  })
  const event = ctx({ fetch, request: new Request('http://x/accounts?/logoutOne', { method: 'POST', body: new URLSearchParams() }) })
  await expect(actions.logoutOne(event as never)).rejects.toMatchObject({ status: 303 })
  expect(calls).toEqual(['set-active', 'revoke']) // order is load-bearing (M2)
})

test('logoutOne with no OTHER registered account signs out ALL, never revoke(active) (R1)', async () => {
  const list = [
    { session: { token: 'tActive' }, user: { id: 'u1', email: 'a@x', name: 'a@x' } },
    { session: { token: 'tg' }, user: { id: 'ug', email: 'guest', name: 'guest', isAnonymous: true } },
  ]
  const calls: string[] = []
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('get-session')) return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 })
    if (url.includes('list-device-sessions')) return new Response(JSON.stringify(list), { status: 200 })
    if (url.includes('sign-out')) { calls.push('sign-out'); return new Response('{}', { status: 200 }) }
    if (url.includes('revoke')) { calls.push('revoke'); return new Response('{}', { status: 200 }) }
    throw new Error(`unexpected ${url}`)
  })
  const event = ctx({ fetch, request: new Request('http://x/accounts?/logoutOne', { method: 'POST', body: new URLSearchParams() }) })
  await expect(actions.logoutOne(event as never)).rejects.toMatchObject({ status: 303, location: '/' })
  expect(calls).toEqual(['sign-out']) // R1: only registered account left → signOut, NOT revoke(active)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- accounts.server`
Expected: FAIL — `./+page.server.ts` doesn't exist yet.

- [ ] **Step 3: Implement `+page.server.ts`**

Create `web/src/routes/accounts/+page.server.ts`:
```ts
import type { PageServerLoad, Actions } from './$types'
import { redirect, type Cookies } from '@sveltejs/kit'
import { authedFetch, cookieHeader, relaySetCookies } from '$lib/server/session'
import { listDeviceSessions, getActiveAuthUserId, setActiveSession, revokeSession } from '$lib/api'

// Registered-only (M4): a guest/anon or signed-out visitor never sees the switcher.
function guard(me: { isAnonymous?: boolean } | null): asserts me is { isAnonymous?: boolean } {
  if (!me || me.isAnonymous) throw redirect(303, '/')
}

export const load: PageServerLoad = async ({ fetch, cookies, url, parent }) => {
  const { me } = await parent()
  guard(me)
  const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
  const [sessions, activeId] = await Promise.all([listDeviceSessions(f), getActiveAuthUserId(f)])
  const accounts = sessions
    .filter((s) => !s.user.isAnonymous) // M1: hide the guest slot
    .map((s) => ({ id: s.user.id, email: s.user.email, active: s.user.id === activeId }))
  return { accounts }
}

// Resolve an opaque auth-user id → its session token, server-side (M5: never
// trust a token from the form). Returns null if the id isn't a held registered
// session.
async function tokenForId(f: typeof fetch, id: string): Promise<string | null> {
  const sessions = await listDeviceSessions(f)
  const hit = sessions.find((s) => s.user.id === id && !s.user.isAnonymous)
  return hit?.session.token ?? null
}

// signOut = revoke-ALL held sessions (verified: needs JSON content-type + a
// body). Used for "log out of all" AND the "no registered account left" logout
// branch (R1) — we never revoke(active) there, because revoke of the active
// token auto-promotes validSessions[0], which would hand the browser to a
// lingering guest. signOut has no promote path.
async function signOutAll(fetch: typeof globalThis.fetch, cookies: Cookies, url: URL): Promise<void> {
  const cookie = cookieHeader(cookies)
  if (!cookie) return
  const res = await fetch(`${env_base()}/api/auth/sign-out`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url.origin, cookie },
    body: '{}',
  })
  relaySetCookies(cookies, res)
}

export const actions = {
  switch: async ({ request, fetch, cookies, url }) => {
    const id = String((await request.formData()).get('id') ?? '')
    const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
    const token = await tokenForId(f, id)
    if (token) relaySetCookies(cookies, await setActiveSession(f, token))
    throw redirect(303, '/accounts')
  },

  // M2: switch to another registered account FIRST, then revoke the old active
  // token — so revoke never hits its arbitrary validSessions[0] auto-promote.
  logoutOne: async ({ fetch, cookies, url }) => {
    const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
    const [sessions, activeId] = await Promise.all([listDeviceSessions(f), getActiveAuthUserId(f)])
    const active = sessions.find((s) => s.user.id === activeId)
    if (!active) throw redirect(303, '/accounts') // no identifiable active session → bail, don't switch-without-revoke (P4)
    const next = sessions.find((s) => s.user.id !== activeId && !s.user.isAnonymous)
    if (next) {
      relaySetCookies(cookies, await setActiveSession(f, next.session.token))
      // re-wrap f with the NEW cookies so revoke runs as `next`, with `active`
      // no longer the active session
      const f2 = authedFetch(fetch, url.origin, cookieHeader(cookies))
      if (active) relaySetCookies(cookies, await revokeSession(f2, active.session.token))
      throw redirect(303, '/accounts')
    }
    // No other registered account: signOut (revoke-ALL) — NOT revoke(active),
    // which would auto-promote a lingering guest to active (R1). Clears
    // everything incl. the guest → signed-out.
    await signOutAll(fetch, cookies, url)
    throw redirect(303, '/')
  },

  logoutAll: async ({ fetch, cookies, url }) => {
    await signOutAll(fetch, cookies, url)
    throw redirect(303, '/')
  },
} satisfies Actions
```
And add the `env_base` import at the top (mirror `login/+page.server.ts`):
```ts
import { env } from '$env/dynamic/private'
const env_base = () => env.CORE_API_URL ?? 'http://localhost:8787'
```

> Note on `switch`'s cookie relay in the test: `relaySetCookies` sets `cookies` from the response's Set-Cookie. The test asserts `cookies.set('textcaster.session_token', 't1', …)`. If `relaySetCookies` also needs `cookies.getAll` between the two `setActiveSession`/`revokeSession` calls in `logoutOne`, that already works because SvelteKit's `cookies` object reflects prior `.set()`s within the same request — but in the unit test the stub's `getAll` is static; `logoutOne`'s second `cookieHeader(cookies)` re-read is exercised in the core test's deterministic-logout path, not asserted here.

> **Action-level guard (P4):** the `me.isAnonymous` guard is on `load` only; a direct POST to an action skips it. Safe by construction — `switch`/`logoutOne` resolve targets only from the caller's OWN held sessions (`listDeviceSessions`/`tokenForId`, filtered to `!isAnonymous`), so a guest POST can't switch into or revoke a registered session it doesn't hold; at worst it signs itself out.

- [ ] **Step 4: Run the tests + svelte-check**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- accounts.server`
Expected: PASS (6/6).
Run: `docker compose exec -T web npm run check -w web`
Expected: svelte-check clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/accounts/+page.server.ts web/src/routes/accounts/accounts.server.test.ts
git commit -m "$(printf 'web(accounts): /accounts load + switch/logout actions (server-driven multi-session)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

### Task 4: Web — `/accounts` UI + settings discovery link

**Files:**
- Create: `web/src/routes/accounts/+page.svelte`
- Modify: `web/src/routes/settings/+page.svelte` (add a link to `/accounts`)

**Interfaces:**
- Consumes: Task 3's `load` data `{ accounts: { id, email, active }[] }` and the actions `?/switch` (field `id`), `?/logoutOne`, `?/logoutAll`.

**BEFORE writing the component:** invoke the `ui-ux-pro-max:ui-ux-pro-max` skill and follow `design-system/textcaster/MASTER.md` (and `design-system/textcaster/pages/*.md` if an `accounts` or `settings` page override exists). Match the existing `settings/+page.svelte` shell (`.lens`, `.masthead`, `ThemeToggle`, `.auth-form`, house `--color-*` tokens). No raw hex, no new deps, works with JS off.

- [ ] **Step 1: Write the component**

Create `web/src/routes/accounts/+page.svelte` (structure — apply MASTER.md styling/tokens; every mutation is a plain `<form method="POST">`, no client JS):
```svelte
<script lang="ts">
  import type { PageData } from './$types'
  import ThemeToggle from '$lib/ThemeToggle.svelte'
  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>Accounts — Textcaster</title></svelte:head>

<div class="lens">
  <header class="masthead">
    <a href="/">Textcaster</a>
    <ThemeToggle />
  </header>

  <h1>Accounts</h1>
  <p class="field-hint">Switch between accounts signed in on this browser.</p>

  <ul class="accounts">
    {#each data.accounts as account (account.id)}
      <li class:active={account.active}>
        <span class="account-email">{account.email}</span>
        {#if account.active}
          <span class="badge">current</span>
          <form method="POST" action="?/logoutOne"><button>Log out</button></form>
        {:else}
          <form method="POST" action="?/switch">
            <input type="hidden" name="id" value={account.id} />
            <button>Switch</button>
          </form>
        {/if}
      </li>
    {/each}
  </ul>

  <div class="account-actions">
    <a class="button" href="/login">Add account</a>
    <form method="POST" action="?/logoutAll"><button class="danger-link">Log out of all accounts</button></form>
  </div>

  <p class="field-hint">You can keep up to 3 accounts signed in on this browser.</p>
</div>

<style>
  /* Use house --color-* tokens per MASTER.md; no raw hex. Fill in per the
     design system during implementation. */
</style>
```
(The `<style>` block must be completed against MASTER.md tokens — spacing, the `.badge`, `.active` treatment, `.account-actions` layout. **P3: `.button`, `.badge`, and `.danger-link` are net-new here** — `.danger-link` is component-scoped elsewhere (not a global class), and `.button`/`.badge` don't exist; define all three in this component's `<style>` per MASTER.md tokens. Don't assume global reuse.)

- [ ] **Step 2: Add the discovery link in settings**

In `web/src/routes/settings/+page.svelte`, add after the `</form>` (inside `.lens`):
```svelte
  <p class="field-hint"><a href="/accounts">Manage accounts on this browser →</a></p>
```

- [ ] **Step 3: Verify it renders and drives (no-JS)**

Run: `docker compose exec -T web npm run check -w web`
Expected: svelte-check clean.
Then drive it in the running dev stack (per the `run` skill): sign in as two verified accounts in one browser at <http://localhost:5173>, open <http://localhost:5173/accounts>, confirm both emails list with the active one marked `current`, click **Switch** (a plain form POST), and confirm the masthead/identity reflects the other account after reload. Confirm a guest (no registered account) visiting `/accounts` is redirected to `/`.

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/accounts/+page.svelte web/src/routes/settings/+page.svelte
git commit -m "$(printf 'web(accounts): /accounts switcher UI + settings discovery link\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Self-Review

**Spec coverage:**
- Core `multiSession({maximumSessions:4})`, no migration → Task 1. ✓
- M1 guest-in-set + web filter + slot → Task 1 (guest-in-list test) + Task 3 (`isAnonymous` filter). ✓
- M2 deterministic `set-active` then `revoke` → Task 1 (core test) + Task 3 (`logoutOne` order test). ✓
- M3 list is GET → Task 1 `listSessions` + Task 2 helper (method GET). ✓
- M4 guard on `me.isAnonymous` → Task 3 `guard` + tests. ✓
- M5 opaque id, token resolved server-side → Task 3 `tokenForId` + switch test. ✓
- M6 behavioral tests in core → Task 1; web tests only cover stub-observable logic. ✓
- M7 CSRF=Lax → documented (no code); no task builds a bypass. ✓ (noted in spec Security)
- M8 no active flag → Task 3 resolves active via `getActiveAuthUserId`. ✓
- M10 re-mint on writes → unchanged; `logoutOne` no-registered-left path calls `signOut` (R1) then redirects to `/`. ✓
- R1 (never bare revoke-of-active): `logoutOne`'s no-next branch and `logoutAll` both go through `signOutAll` → Task 3 action + the R1 web test. ✓
- `/accounts` UI, no-JS, MASTER.md → Task 4. ✓
- log-out-all via `signOut` → Task 3 `logoutAll`. ✓

**Placeholder scan:** the Task 4 `<style>` block is intentionally completed against MASTER.md at implementation (a design-system requirement, not a code placeholder — the skill mandates the ui-ux pass); every logic step has complete code.

**Type consistency:** `DeviceSession` (Task 2) shape `{ session:{token}, user:{id,email,name,isAnonymous?} }` used consistently in Task 3; action field `id` matches between `+page.svelte` hidden input (Task 4) and `switch` action (Task 3); `accounts` load shape `{id,email,active}` matches Task 4's `{#each}`.

## Execution Handoff

Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks.
2. **Inline Execution** — batch execution in this session with checkpoints.
