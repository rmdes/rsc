import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { DomainError } from '../src/domain/types.ts'
import type { Repository } from '../src/domain/repository.ts'

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  return { repo, bus, svc: createService(repo, bus) }
}

test('createLocalPost stores, emits, and appears in the timeline', async () => {
  const { bus, svc } = await setup()
  await svc.addRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' }) // remote coexists
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

test('addRemoteUser rejects a handle with invalid characters', async () => {
  const { svc } = await setup()
  await expect(svc.addRemoteUser({ handle: 'Bad Handle!', displayName: 'Bad', feedUrl: 'https://ex.com/f.xml' })).rejects.toThrow(DomainError)
})

test('addRemoteUser rejects a handle that is already taken', async () => {
  const { svc } = await setup()
  await svc.addRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  await expect(svc.addRemoteUser({ handle: 'news', displayName: 'News Again', feedUrl: 'https://ex.com/g.xml' })).rejects.toThrow(DomainError)
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
