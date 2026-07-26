import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { makeAuth, anonSession } from './auth-helper.ts'
import { DomainError, HandleTakenError } from '../src/domain/types.ts'
import type { Repository } from '../src/domain/repository.ts'

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  return { repo, bus, svc: createService(repo, bus) }
}

test('createLocalPost stores, emits, and appears in the timeline', async () => {
  const { repo, bus, svc } = await setup()
  await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }) // remote coexists
  const seen = vi.fn()
  bus.onNewPost(seen)
  await svc.createLocalPostAs('alice', 'Alice', 'hello world')
  expect(seen).toHaveBeenCalledTimes(1)
  const tl = await svc.getTimeline()
  expect(tl.map((e) => e.content)).toContain('hello world')
  expect(tl[0].author.kind).toBe('local')
})

test('handles are lowercased, so posting as Alice then alice is one user', async () => {
  const { svc } = await setup()
  await svc.createLocalPostAs('Alice', 'Alice', 'first')
  await svc.createLocalPostAs('alice', 'Alice', 'second')
  const tl = await svc.getTimeline()
  const authorIds = new Set(tl.map((e) => e.authorId))
  expect(authorIds.size).toBe(1)
  expect(tl[0].author.handle).toBe('alice')
})

test('a first post that loses the create race retries the lookup and succeeds', async () => {
  const repo = await createSqliteRepository(':memory:')
  await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' }) // the "winner" of the race
  let firstLookup = true
  const racy: Repository = Object.assign(Object.create(repo), {
    getUserByHandle: async (h: string) => {
      if (firstLookup) { firstLookup = false; return undefined } // simulate pre-race view
      return repo.getUserByHandle(h)
    },
  })
  const svc = createService(racy, createEventBus())
  const entry = await svc.createLocalPostAs('alice', 'Alice', 'raced post')
  expect(entry.author.handle).toBe('alice')
})

test('addFollow requires a local follower and is idempotent', async () => {
  const { repo, svc } = await setup()
  const alice = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const news = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  await svc.addFollow(alice, news)
  await svc.addFollow(alice, news) // idempotent
  expect((await svc.listFollowing(alice.id)).map((u) => u.handle)).toEqual(['news'])
  await expect(svc.addFollow(news, alice)).rejects.toBeInstanceOf(DomainError) // remote follower rejected
})

test('followed lens passes the filter through', async () => {
  const { repo, svc } = await setup()
  const me = await repo.createLocalUser({ handle: 'me', displayName: 'Me' })
  const x = await repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://ex.com/x.xml' })
  await svc.addFollow(me, x)
  await repo.insertPost({ id: 'x1', authorId: x.id, source: 'remote', guid: 'x1', title: null, content: 'x1', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const tl = await svc.getTimeline(10, undefined, { followedBy: me.id })
  expect(tl.map((e) => e.id)).toEqual(['x1'])
})

test('local posts get a permalink url when publicUrl is configured', async () => {
  const repo = await createSqliteRepository(':memory:')
  const service = createService(repo, createEventBus(), 'https://tc.example')
  const entry = await service.createLocalPostAs('alice', 'Alice', 'hello')
  expect(entry.url).toBe(`https://tc.example/post/${entry.id}`)
})

test('local posts keep url null without publicUrl (existing behavior)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const service = createService(repo, createEventBus())
  const entry = await service.createLocalPostAs('alice', 'Alice', 'hello')
  expect(entry.url).toBeNull()
})

test('replies to permalinked posts reference the permalink, not the guid', async () => {
  const repo = await createSqliteRepository(':memory:')
  const service = createService(repo, createEventBus(), 'https://tc.example')
  const parent = await service.createLocalPostAs('alice', 'Alice', 'root')
  const parentPost = await repo.getPost(parent.id)
  const reply = await service.createLocalPostAs('bob', 'Bob', 'reply', parentPost!)
  expect(reply.inReplyTo).toBe(`https://tc.example/post/${parent.id}`)
  expect(reply.threadRootId).toBe(parent.id)
})

// ── permanent handle reservation (V4 Task 5) ─────────────────────────────
// A converted legacy remote handle can never be registered again — the
// impersonation guard (cutover spec §3.5). ONE check in the repository, where
// every caller routes: service ensureLocalUser, the direct createLocalUser, and
// auth's guest allocation. It surfaces as the EXISTING collision-shaped error
// (HandleTakenError) so no reserved-vs-taken oracle leaks.

function reserve(repo: Awaited<ReturnType<typeof createSqliteRepository>>, handle: string): void {
  repo.raw.prepare(
    `INSERT INTO handle_reservations_v2 (handle, source_id, publisher_id, created_at) VALUES (?, 's1', 'p1', '2026-07-24T00:00:00.000Z')`,
  ).run(handle)
}

test('createLocalUser refuses a reserved handle with the collision-shaped error', async () => {
  const { repo } = await setup()
  reserve(repo, 'alice')
  await expect(repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })).rejects.toThrow(HandleTakenError)
  expect(await repo.getUserByHandle('alice')).toBeUndefined()
})

test('ensureLocalUser (first post) refuses a reserved handle through the same guard', async () => {
  const { svc, repo } = await setup()
  reserve(repo, 'alice')
  await expect(svc.createLocalPostAs('Alice', 'Alice', 'hello')).rejects.toThrow(HandleTakenError)
})

test('a handle-changing updateUserProfile refuses a reserved handle', async () => {
  const { repo } = await setup()
  reserve(repo, 'taken')
  const user = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  await expect(repo.updateUserProfile(user.id, { handle: 'taken' })).rejects.toThrow(HandleTakenError)
  // a display-name-only patch never consults the reservations
  const renamed = await repo.updateUserProfile(user.id, { displayName: 'Alice B' })
  expect(renamed.handle).toBe('alice')
  expect(renamed.displayName).toBe('Alice B')
})

test('an unreserved handle is unaffected by the guard', async () => {
  const { repo } = await setup()
  reserve(repo, 'alice')
  const user = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
  expect(user.handle).toBe('bob')
})

// ── the guard on the path production actually takes ───────────────────────────
// Reservations only EXIST once conversion has run, i.e. with RSC_SOURCE_MODEL_V2
// on — and with the flag on service.updateUserProfile routes to the LOGICAL
// store, not the repository. So the rename guard has to hold there too, with the
// identical error (and therefore the identical 409) whichever implementation runs.

// Same composition service.ts sees at runtime: `logical` present ⇔ flag on.
async function renameApp(v2: boolean) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, v2 ? store : undefined)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo,
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { repo, app, service }
}

const patchMe = (app: Awaited<ReturnType<typeof renameApp>>['app'], cookie: string, body: unknown) =>
  app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })

test.each([false, true])('PATCH /me refuses a reserved handle after the converted source row is removed (v2=%s)', async (v2) => {
  const { repo, app } = await renameApp(v2)
  // A converted legacy remote feed: conversion reserves its handle …
  const converted = await repo.createRemoteUser({ handle: 'newsbot', displayName: 'Newsbot', feedUrl: 'https://ex.com/n.xml' })
  reserve(repo, 'newsbot')
  // … and an admin then hard-removes the row (DELETE /admin/users/:handle).
  repo.deleteUserCascade(converted.id)
  expect(await repo.getUserByHandle('newsbot')).toBeUndefined() // users.UNIQUE no longer blocks it
  // The reservation has NO foreign keys, so it outlives the source (foundation §12).
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM handle_reservations_v2 WHERE handle = 'newsbot'`).get()).toEqual({ n: 1 })

  const cookie = await anonSession(app)
  const res = await patchMe(app, cookie, { handle: 'newsbot' })
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ error: 'handle already taken' })
  expect(await repo.getUserByHandle('newsbot')).toBeUndefined() // nothing was renamed
})

test.each([false, true])('an ordinary rename still succeeds — the guard does not over-block (v2=%s)', async (v2) => {
  const { repo, app } = await renameApp(v2)
  reserve(repo, 'newsbot')
  const cookie = await anonSession(app)
  const res = await patchMe(app, cookie, { handle: 'freehandle', displayName: 'Free' })
  expect(res.status).toBe(200)
  expect((await res.json()).user).toMatchObject({ handle: 'freehandle', displayName: 'Free' })
  expect((await repo.getUserByHandle('freehandle'))?.displayName).toBe('Free')
})

test('with v2 ON the logical store raises the same HandleTakenError as the repository', async () => {
  const { repo, service } = await renameApp(true)
  reserve(repo, 'newsbot')
  const user = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  // The v2 implementation is synchronous, so it THROWS where v1 rejects; the
  // route awaits inside one try/catch, which is why both still answer 409.
  await expect((async () => service.updateUserProfile(user.id, { handle: 'newsbot' }))()).rejects.toThrow(HandleTakenError)
  // a display-name-only patch never consults the reservations
  expect((await service.updateUserProfile(user.id, { displayName: 'Alice B' })).handle).toBe('alice')
})
