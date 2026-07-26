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
  const service = createService(repo, bus)
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo,
    adminEmails: new Set(adminEmails), mailEnabled: true,
    feeds: { publicUrl: 'https://x.test', hubUrl: null, rssCloud: true },
    websub: 'self', pushIn: true,
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { app, repo }
}

test('instanceStats(false) counts registered/guests/remoteFeeds/posts from the v1 tables', async () => {
  const { app, repo } = await makeApp()
  await registeredSession(app, 'a@x.test', repo)      // 1 registered local
  await anonSession(app)                               // 1 guest
  await repo.createRemoteUser({ handle: 'f1', displayName: 'F1', feedUrl: 'https://e/f.xml' })
  const s = repo.instanceStats(false)
  expect(s.registeredUsers).toBe(1)
  expect(s.guests).toBe(1)
  expect(s.remoteFeeds).toBe(1)
  expect(s.posts).toBe(0)
})

test('instanceStats(true) counts remote_sources_v2 as remoteFeeds and folds v2 remote logical items into posts, without double-counting local logical items', async () => {
  const { repo } = await makeApp()
  const raw = repo.raw
  const NOW = '2026-07-25T00:00:00.000Z'
  // A v1 remote user must NOT be counted under v2 — remote feeds live in remote_sources_v2 now.
  await repo.createRemoteUser({ handle: 'f1', displayName: 'F1', feedUrl: 'https://e/f.xml' })
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES ('u1', 'local', 'u1', 'U1', NULL, ?)`).run(NOW)
  raw.prepare(
    `INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at)
     VALUES ('p1', 'u1', 'local', 'p1', NULL, 'c', NULL, ?, ?)`,
  ).run(NOW, NOW)
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES ('s1', 'https://feed.test/f', 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
  ).run(NOW)
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, created_at) VALUES ('li-remote', 'remote', ?, 'none', ?)`,
  ).run(NOW, NOW)
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, created_at) VALUES ('li-local', 'local', ?, 'none', ?)`,
  ).run(NOW, NOW)
  const s = repo.instanceStats(true)
  expect(s.remoteFeeds).toBe(1) // only the v2 source, not the v1 remote user
  expect(s.posts).toBe(2) // 1 local posts row + 1 v2 remote logical item; the local logical item is not double-counted
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
