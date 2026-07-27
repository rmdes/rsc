import { test, expect } from 'vitest'
import type { Hono } from 'hono'
import { createSqliteRepository, type SqliteRepository } from '../src/storage/sqlite.ts'
import { createApp } from '../src/api/app.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
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
  const auth = makeAuth(repo)
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, store)
  const app = createApp({
    service, bus, token: 'secret', auth, users: repo,
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
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
