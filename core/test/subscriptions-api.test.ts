import { test, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

// V1 retirement: every {url,type} test this file used to open with tested the
// deleted v1 subscribe handler. The v2 subscribe/refusal/cap/own-instance
// behaviours they covered live in source-capability-api.test.ts (which drives
// the same route with v2 bodies); what survives here is the v2-only
// unsubscribe/OPML/session-gate surface.

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, store)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo,
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { app, repo, service }
}

const V2_URL_A = 'https://203.0.113.40/f.xml'
const V2_URL_B = 'https://203.0.113.41/f.xml'

async function v2Subscribe(app: Hono, cookie: string, url: string, commandId: string) {
  const res = await app.request('/me/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ url, commandId }),
  })
  return (await res.json()).subscription.sourceId as string
}

function unsubscribe(app: Hono, cookie: string, sourceId: string, commandId: string) {
  return app.request(`/me/subscriptions/${sourceId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ commandId }),
  })
}

test('DELETE /me/subscriptions/:sourceId removes by stable id, replays, 404s unknown and 409s a reused command id', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'unsub@test.example', repo)
  const a = await v2Subscribe(app, cookie, V2_URL_A, 'sub-a')
  const b = await v2Subscribe(app, cookie, V2_URL_B, 'sub-b')

  const removed = await unsubscribe(app, cookie, a, 'del-1')
  expect(removed.status).toBe(200)
  expect(await removed.json()).toEqual({ ok: true })

  const replay = await unsubscribe(app, cookie, a, 'del-1')
  expect(replay.status).toBe(200)
  expect(await replay.json()).toEqual({ ok: true })

  const unknown = await unsubscribe(app, cookie, randomUUID(), 'del-2')
  expect(unknown.status).toBe(404)

  // Same command id, different source → the fingerprint changes → conflict.
  const conflict = await unsubscribe(app, cookie, b, 'del-1')
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({ error: 'idempotency conflict' })

  expect((await unsubscribe(app, cookie, b, 'del-3')).status).toBe(200)
  const view = await (await app.request('/me/following', { headers: { cookie } })).json()
  expect(view.sourceSubscriptions).toEqual([])
  repo.close()
})

test('POST /me/follows/opml (v2) imports under an x-rsc-command-id, replays it, and conflicts on a changed body', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'v2opml@test.example', repo)
  const opml = (url: string) => `<opml version="2.0"><body><outline type="rss" text="f" xmlUrl="${url}"/></body></opml>`
  const post = (body: string, commandId: string) =>
    app.request('/me/follows/opml', { method: 'POST', headers: { cookie, 'x-rsc-command-id': commandId }, body })

  const first = await post(opml(V2_URL_A), 'imp-1')
  expect(first.status).toBe(200)
  expect(await first.json()).toEqual({ localFollowed: 0, active: 1, pending: 0, unavailable: 0, notSubscribable: 0, capSkipped: 0 })

  const replay = await post(opml(V2_URL_A), 'imp-1')
  expect(replay.status).toBe(200)
  expect(await replay.json()).toEqual({ localFollowed: 0, active: 1, pending: 0, unavailable: 0, notSubscribable: 0, capSkipped: 0 })

  const conflict = await post(opml(V2_URL_B), 'imp-1')
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({ error: 'idempotency conflict' })
  repo.close()
})

test('v2 owner routes still require a session: 401 without one', async () => {
  const { app, repo } = await makeApp()
  expect((await app.request('/me/following')).status).toBe(401)
  expect((await unsubscribe(app, '', randomUUID(), 'x')).status).toBe(401)
  repo.close()
})

// The session gate on POST /me/subscriptions — carried over from the v1 tests
// this release deleted, re-pointed at the v2 body. Both answers come from
// authed/registeredOnly BEFORE any body validation, so nothing else covers them.
test('POST /me/subscriptions: 401 with no session, 403 with an anonymous one (registeredOnly)', async () => {
  const { app, repo } = await makeApp()
  const body = JSON.stringify({ url: V2_URL_A, commandId: 'gate-1' })
  const none = await app.request('/me/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  expect(none.status).toBe(401)
  const anon = await app.request('/me/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json', cookie: await anonSession(app) }, body })
  expect(anon.status).toBe(403)
  repo.close()
})
