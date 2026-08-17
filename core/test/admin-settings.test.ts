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

// All PATCH bodies must include the numeric quartet (validated before tab fields).
const NUM = { maxSubsPerUser: 500, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, feedItemLimit: 50 }
type App = Awaited<ReturnType<typeof makeApp>>['app'] // avoids importing the Hono type
const patchTabs = (app: App, cookie: string, extra: Record<string, unknown>) =>
  app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ ...NUM, ...extra }),
  })

const NULL_TABS = {
  tabLabels: { local: null, federated: null, personal: null, public: null },
  tabSubtitles: { local: null, federated: null, personal: null, public: null },
}

test('GET /admin/settings: admin sees the seeded default', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/settings', { headers: { cookie } })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ maxSubsPerUser: 500, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, feedItemLimit: 50, ...NULL_TABS })
})

test('PATCH /admin/settings: admin updates the cap, GET reflects it, and it is enforced on the next subscribe', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)

  const patch = await app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ maxSubsPerUser: 1, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, feedItemLimit: 50 }),
  })
  expect(patch.status).toBe(200)

  const get = await app.request('/admin/settings', { headers: { cookie } })
  expect(await get.json()).toEqual({ maxSubsPerUser: 1, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, feedItemLimit: 50, ...NULL_TABS })

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
      body: JSON.stringify({ maxSubsPerUser, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0 }),
    })
    expect(res.status).toBe(400)
  }
  // untouched by the rejected attempts
  const get = await app.request('/admin/settings', { headers: { cookie } })
  expect(await get.json()).toEqual({ maxSubsPerUser: 500, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, feedItemLimit: 50, ...NULL_TABS })
})

test('PATCH /admin/settings: accepts zero (disables subscribing)', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ maxSubsPerUser: 0, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, feedItemLimit: 50 }),
  })
  expect(res.status).toBe(200)
  expect(await (await app.request('/admin/settings', { headers: { cookie } })).json()).toEqual({ maxSubsPerUser: 0, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, feedItemLimit: 50, ...NULL_TABS })
})

test('GET /admin/settings: includes the retention defaults (unlimited)', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/settings', { headers: { cookie } })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.maxRemoteItemsPerSource).toBe(0)
  expect(body.maxRemoteItemAgeDays).toBe(0)
})

test('PATCH /admin/settings: updates the retention caps, GET reflects it', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const patch = await app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ maxSubsPerUser: 500, maxRemoteItemsPerSource: 200, maxRemoteItemAgeDays: 90, feedItemLimit: 50 }),
  })
  expect(patch.status).toBe(200)
  const get = await app.request('/admin/settings', { headers: { cookie } })
  const body = await get.json()
  expect(body.maxRemoteItemsPerSource).toBe(200)
  expect(body.maxRemoteItemAgeDays).toBe(90)
})

test('PATCH /admin/settings: rejects non-integer or negative retention values', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  for (const bad of [{ maxRemoteItemsPerSource: -1 }, { maxRemoteItemsPerSource: 1.5 }, { maxRemoteItemAgeDays: -1 }, { maxRemoteItemAgeDays: 'ten' }]) {
    const res = await app.request('/admin/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ maxSubsPerUser: 500, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, ...bad }),
    })
    expect(res.status).toBe(400)
  }
})

test('PATCH /admin/settings: accepts 0 for both retention fields (means unlimited, not disabled)', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ maxSubsPerUser: 500, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, feedItemLimit: 50 }),
  })
  expect(res.status).toBe(200)
})

test('PATCH accepts and GET echoes a label + subtitle override', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const r = await patchTabs(app, cookie, { tabLabels: { personal: 'My feed' }, tabSubtitles: { public: 'All of it' } })
  expect(r.status).toBe(200)
  const g = await (await app.request('/admin/settings', { headers: { cookie } })).json()
  expect(g.tabLabels.personal).toBe('My feed')
  expect(g.tabSubtitles.public).toBe('All of it')
  expect(g.tabLabels.local).toBeNull()
})

test('PATCH: empty string clears a tab override', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  await patchTabs(app, cookie, { tabLabels: { personal: 'My feed' } })
  await patchTabs(app, cookie, { tabLabels: { personal: '' } })
  const g = await (await app.request('/admin/settings', { headers: { cookie } })).json()
  expect(g.tabLabels.personal).toBeNull()
})

test('PATCH: rejects an over-long label (25), over-long subtitle (121), newline, and unknown key', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  expect((await patchTabs(app, cookie, { tabLabels: { personal: 'x'.repeat(25) } })).status).toBe(400)
  expect((await patchTabs(app, cookie, { tabSubtitles: { local: 'x'.repeat(121) } })).status).toBe(400)
  expect((await patchTabs(app, cookie, { tabLabels: { local: 'a\nb' } })).status).toBe(400)
  expect((await patchTabs(app, cookie, { tabLabels: { bogus: 'x' } })).status).toBe(400)
})

test('admin settings round-trip feedItemLimit', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const patch = await app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ ...NUM, feedItemLimit: 25 }),
  })
  expect(patch.status).toBe(200)
  const get = await app.request('/admin/settings', { headers: { cookie } })
  expect((await get.json()).feedItemLimit).toBe(25)
})

test('admin settings reject feedItemLimit below 1', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ ...NUM, feedItemLimit: 0 }),
  })
  expect(res.status).toBe(400)
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
