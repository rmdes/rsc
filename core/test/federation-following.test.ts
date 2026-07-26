import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'

// checkCallbackUrl runs real DNS for hostnames and the sandbox has no network,
// so both feeds are TEST-NET-3 literals (RFC 5737) — public without a DNS trip.
const FEED_A = 'https://203.0.113.80/f.xml'
const FEED_B = 'https://203.0.113.81/b.xml'

async function instance(publicUrl: string | null) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, publicUrl, store)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo,
    feeds: { publicUrl, hubUrl: null, rssCloud: false },
    sources: { service: createSourceService(repo, publicUrl), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { repo, service, app }
}

// The v2 rewrite of the OPML federation loop. v1 seeded through
// service.addRemoteUser and imported through importFollowingOpml; both are
// deleted, so the round trip now runs entirely on the source-control plane:
// subscribe → export → import → public projection.
test('OPML round-trip: instance 1 export → instance 2 import recreates the source subscriptions', { timeout: 30000 }, async () => {
  const one = await instance('https://one.example')
  const aliceCookie = await registeredSession(one.app, 'alice@test.example', one.repo)
  await one.app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: aliceCookie }, body: JSON.stringify({ handle: 'alice', displayName: 'Alice' }) })
  for (const [url, commandId] of [[FEED_A, 'sub-a'], [FEED_B, 'sub-b']]) {
    const res = await one.app.request('/me/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json', cookie: aliceCookie }, body: JSON.stringify({ url, commandId }) })
    expect(res.status).toBe(201)
  }

  const opml = await (await one.app.request('/users/alice/following.opml')).text()
  expect(opml).toContain(FEED_A)

  const two = await instance('https://two.example')
  const importerCookie = await registeredSession(two.app, 'importer@test.example', two.repo)
  await two.app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: importerCookie }, body: JSON.stringify({ handle: 'importer', displayName: 'Importer' }) })
  const res = await two.app.request('/me/follows/opml', { method: 'POST', headers: { cookie: importerCookie, 'x-rsc-command-id': 'imp-1' }, body: opml })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ localFollowed: 0, active: 2, pending: 0, unavailable: 0, notSubscribable: 0, capSkipped: 0 })

  const list = await (await two.app.request('/users/importer/follows')).json()
  expect(list.following.map((f: { url: string }) => f.url).sort()).toEqual([FEED_A, FEED_B].sort())
  expect(list.following.every((f: { kind: string }) => f.kind === 'source')).toBe(true)
  one.repo.close()
  two.repo.close()
})
