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

async function renameTo(app: Awaited<ReturnType<typeof makeApp>>['app'], cookie: string, handle: string, displayName: string) {
  await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ handle, displayName }) })
}

test('last unfollow of a webfeed cascades; earlier unfollow does not', async () => {
  const { app, repo } = await makeApp()
  const alice = await registeredSession(app, 'alice@test.example', repo)
  await renameTo(app, alice, 'alice', 'Alice')
  const bob = await registeredSession(app, 'bob@test.example', repo)
  await renameTo(app, bob, 'bob', 'Bob')
  const feed = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml', feedType: 'webfeed' })
  await repo.insertPost({
    id: 'p1', authorId: feed.id, source: 'remote', guid: 'g1', title: null, content: 'hi',
    url: 'https://ex.com/post/1', publishedAt: '2026-07-19T00:00:00Z', createdAt: '2026-07-19T00:00:00Z',
    inReplyTo: null, inReplyToPostId: null, threadRootId: null,
  })

  await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: alice }, body: JSON.stringify({ handle: 'news' }) })
  await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: bob }, body: JSON.stringify({ handle: 'news' }) })

  // alice unfollows — bob still follows, row must survive
  const r1 = await app.request('/me/follows/news', { method: 'DELETE', headers: { cookie: alice } })
  expect(r1.status).toBe(200)
  expect(await repo.getUserByHandle('news')).toBeTruthy()

  // bob unfollows — last follower gone, self-serve feed cascade-deleted
  const r2 = await app.request('/me/follows/news', { method: 'DELETE', headers: { cookie: bob } })
  expect(r2.status).toBe(200)
  expect(await repo.getUserByHandle('news')).toBeUndefined()
  const remoteHandles = (await repo.listRemoteUsers()).map((u) => u.handle)
  expect(remoteHandles).not.toContain('news')
  expect((await repo.getTimeline(50)).find((e) => e.id === 'p1')).toBeUndefined()
})

test('unfollowing the sole follower of an instance keeps the row', async () => {
  const { app, repo } = await makeApp()
  const alice = await registeredSession(app, 'alice@test.example', repo)
  await renameTo(app, alice, 'alice', 'Alice')
  await repo.createRemoteUser({ handle: 'peer-instance', displayName: 'Peer Instance', feedUrl: 'https://ex.com/instance.xml', feedType: 'instance' })

  await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: alice }, body: JSON.stringify({ handle: 'peer-instance' }) })
  const r = await app.request('/me/follows/peer-instance', { method: 'DELETE', headers: { cookie: alice } })
  expect(r.status).toBe(200)
  expect(await repo.getUserByHandle('peer-instance')).toBeTruthy()
})

test('unfollowing a local user never cascades', async () => {
  const { app, repo } = await makeApp()
  const alice = await registeredSession(app, 'alice@test.example', repo)
  await renameTo(app, alice, 'alice', 'Alice')
  const bob = await registeredSession(app, 'bob@test.example', repo)
  await renameTo(app, bob, 'bob', 'Bob')

  await app.request('/me/follows', { method: 'POST', headers: { 'content-type': 'application/json', cookie: alice }, body: JSON.stringify({ handle: 'bob' }) })
  const r = await app.request('/me/follows/bob', { method: 'DELETE', headers: { cookie: alice } })
  expect(r.status).toBe(200)
  expect(await repo.getUserByHandle('bob')).toBeTruthy()
})
