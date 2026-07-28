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
import { decodeCursor } from '../src/domain/source-repository.ts'

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

test('listUsers: registered locals + remote feeds, excludes guests', async () => {
  const { app, repo } = await makeApp()
  const reg = await registeredSession(app, 'reg@x.test', repo)
  await app.request('/me', { headers: { cookie: reg } })    // real mint → registered local core row (isAnonymous=0)
  const guest = await anonSession(app)
  await app.request('/me', { headers: { cookie: guest } })  // real mint → guest core row (isAnonymous=1)
  await repo.createRemoteUser({ handle: 'feed1', displayName: 'Feed', feedUrl: 'https://e/f.xml' })
  const users = repo.listUsers(undefined, 100).items
  const kinds = users.map((u) => u.kind).sort()
  expect(kinds).toEqual(['local', 'remote'])
  const remote = users.find((u) => u.kind === 'remote')!
  expect(remote.feedUrl).toBe('https://e/f.xml')
  expect(remote.emailVerified).toBeNull()
  const local = users.find((u) => u.kind === 'local')!
  expect(local.feedUrl).toBeNull()
  expect(typeof local.emailVerified).toBe('boolean')
})

test('listUsers: paginates stably — limit=1 returns exactly 1 item + nextCursor, and the union of all pages has no dupes/gaps', async () => {
  const { repo } = await makeApp()
  await repo.createRemoteUser({ handle: 'feedA', displayName: 'A', feedUrl: 'https://e/a.xml' })
  await repo.createRemoteUser({ handle: 'feedB', displayName: 'B', feedUrl: 'https://e/b.xml' })

  const first = repo.listUsers(undefined, 1)
  expect(first.items).toHaveLength(1)
  expect(first.nextCursor).not.toBeNull()

  const second = repo.listUsers(decodeCursor(first.nextCursor!), 1)
  expect(second.items).toHaveLength(1)
  expect(second.nextCursor).toBeNull()

  const handles = new Set([...first.items, ...second.items].map((u) => u.handle))
  expect(handles).toEqual(new Set(['feedA', 'feedB']))
})

test('GET /admin/users: admin 200 with the list; non-admin 403; anon 403; no session 401', async () => {
  const { app, repo } = await makeApp()
  await repo.createRemoteUser({ handle: 'shown', displayName: 'Shown', feedUrl: 'https://e/s.xml' })
  const admin = await registeredSession(app, 'boss@x.test', repo)
  const ok = await app.request('/admin/users', { headers: { cookie: admin } })
  expect(ok.status).toBe(200)
  expect((await ok.json()).items.some((u: { handle: string }) => u.handle === 'shown')).toBe(true)
  expect((await app.request('/admin/users', { headers: { cookie: await registeredSession(app, 'peon@x.test', repo) } })).status).toBe(403)
  expect((await app.request('/admin/users', { headers: { cookie: await anonSession(app) } })).status).toBe(403)
  expect((await app.request('/admin/users')).status).toBe(401)
})
