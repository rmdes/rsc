import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

async function makeApp(adminEmails: string[] = ['boss@x.test']) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, store)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo, adminEmails: new Set(adminEmails),
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { app, repo }
}

// checkCallbackUrl runs real DNS for hostnames; the test sandbox has no
// network, so subscribe-cap URLs use public IP literals (TEST-NET-3,
// RFC 5737 — reserved for docs) which checkCallbackUrl accepts without DNS.
const FEED_1 = 'https://203.0.113.10/one.xml'
const FEED_2 = 'https://203.0.113.11/two.xml'

test('GET /admin/settings: admin sees the seeded default', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/settings', { headers: { cookie } })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ maxSubsPerUser: 500 })
})

test('PATCH /admin/settings: admin updates the cap, GET reflects it, and it is enforced on the next subscribe', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)

  const patch = await app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ maxSubsPerUser: 1 }),
  })
  expect(patch.status).toBe(200)

  const get = await app.request('/admin/settings', { headers: { cookie } })
  expect(await get.json()).toEqual({ maxSubsPerUser: 1 })

  // v2 subscribe body: {url, commandId} — no `type` field (P4).
  const alice = await registeredSession(app, 'alice@x.test', repo)
  const first = await app.request('/me/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ url: FEED_1, commandId: 'cap-1' }),
  })
  expect(first.status).toBe(201)

  const second = await app.request('/me/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ url: FEED_2, commandId: 'cap-2' }),
  })
  expect(second.status).toBe(429)
})

test('PATCH /admin/settings: rejects non-integer and negative values', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  for (const maxSubsPerUser of [-1, 1.5, 'ten', null, undefined]) {
    const res = await app.request('/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ maxSubsPerUser }),
    })
    expect(res.status).toBe(400)
  }
  // untouched by the rejected attempts
  const get = await app.request('/admin/settings', { headers: { cookie } })
  expect(await get.json()).toEqual({ maxSubsPerUser: 500 })
})

test('PATCH /admin/settings: accepts zero (disables subscribing)', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ maxSubsPerUser: 0 }),
  })
  expect(res.status).toBe(200)
  expect(await (await app.request('/admin/settings', { headers: { cookie } })).json()).toEqual({ maxSubsPerUser: 0 })
})

test('GET/PATCH /admin/settings gate: non-admin 403, anon 403, no session 401', async () => {
  const { app, repo } = await makeApp()
  const peon = await registeredSession(app, 'peon@x.test', repo)
  const guest = await anonSession(app)

  expect((await app.request('/admin/settings', { headers: { cookie: peon } })).status).toBe(403)
  expect((await app.request('/admin/settings', { headers: { cookie: guest } })).status).toBe(403)
  expect((await app.request('/admin/settings')).status).toBe(401)

  const patchInit = (cookie?: string) => ({
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ maxSubsPerUser: 10 }),
  })
  expect((await app.request('/admin/settings', patchInit(peon))).status).toBe(403)
  expect((await app.request('/admin/settings', patchInit(guest))).status).toBe(403)
  expect((await app.request('/admin/settings', patchInit())).status).toBe(401)
})
