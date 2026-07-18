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
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, adminEmails: new Set(adminEmails) })
  return { app, repo }
}

test('listUsers: registered locals + remote feeds, excludes guests', async () => {
  const { app, repo } = await makeApp()
  await registeredSession(app, 'reg@x.test', repo)   // registered local
  await anonSession(app)                              // guest (excluded)
  await repo.createRemoteUser({ handle: 'feed1', displayName: 'Feed', feedUrl: 'https://e/f.xml' })
  const users = repo.listUsers()
  const kinds = users.map((u) => u.kind).sort()
  expect(kinds).toEqual(['local', 'remote'])
  const remote = users.find((u) => u.kind === 'remote')!
  expect(remote.feedUrl).toBe('https://e/f.xml')
  expect(remote.emailVerified).toBeNull()
  const local = users.find((u) => u.kind === 'local')!
  expect(local.feedUrl).toBeNull()
  expect(typeof local.emailVerified).toBe('boolean')
})

test('GET /admin/users: admin 200 with the list; non-admin 403; anon 403; no session 401', async () => {
  const { app, repo } = await makeApp()
  await repo.createRemoteUser({ handle: 'shown', displayName: 'Shown', feedUrl: 'https://e/s.xml' })
  const admin = await registeredSession(app, 'boss@x.test', repo)
  const ok = await app.request('/admin/users', { headers: { cookie: admin } })
  expect(ok.status).toBe(200)
  expect((await ok.json()).users.some((u: { handle: string }) => u.handle === 'shown')).toBe(true)
  expect((await app.request('/admin/users', { headers: { cookie: await registeredSession(app, 'peon@x.test', repo) } })).status).toBe(403)
  expect((await app.request('/admin/users', { headers: { cookie: await anonSession(app) } })).status).toBe(403)
  expect((await app.request('/admin/users')).status).toBe(401)
})
