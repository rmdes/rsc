import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

async function makeApp(adminEmails: string[] = ['boss@x.test']) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo,
    adminEmails: new Set(adminEmails), mailEnabled: true,
    feeds: { publicUrl: 'https://x.test', hubUrl: null, rssCloud: true },
    websub: 'self', pushIn: true,
  })
  return { app, repo }
}

test('instanceStats counts registered/guests/remoteFeeds/posts', async () => {
  const { app, repo } = await makeApp()
  await registeredSession(app, 'a@x.test', repo)      // 1 registered local
  await anonSession(app)                               // 1 guest
  await repo.createRemoteUser({ handle: 'f1', displayName: 'F1', feedUrl: 'https://e/f.xml' })
  const s = repo.instanceStats()
  expect(s.registeredUsers).toBe(1)
  expect(s.guests).toBe(1)
  expect(s.remoteFeeds).toBe(1)
  expect(s.posts).toBe(0)
})

test('GET /admin/overview: admin 200 with counts + federation + adminEmails', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/overview', { headers: { cookie } })
  expect(res.status).toBe(200)
  const b = await res.json()
  expect(b.counts.registeredUsers).toBe(1)
  expect(b.federation).toEqual({ websub: 'self', rssCloud: true, pushIn: true, publicUrl: 'https://x.test' })
  expect(b.adminEmails).toEqual(['boss@x.test'])
  expect(b.mailEnabled).toBe(true)
})

test('GET /admin/overview gate: non-admin 403, anon 403, no session 401', async () => {
  const { app, repo } = await makeApp()
  expect((await app.request('/admin/overview', { headers: { cookie: await registeredSession(app, 'peon@x.test', repo) } })).status).toBe(403)
  expect((await app.request('/admin/overview', { headers: { cookie: await anonSession(app) } })).status).toBe(403)
  expect((await app.request('/admin/overview')).status).toBe(401)
})
