import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { HandleTakenError } from '../src/domain/types.ts'
import type { Repository } from '../src/domain/repository.ts'
import type { User } from '../src/domain/types.ts'

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  return { repo, bus, svc: createService(repo, bus) }
}

test('subscribeByUrl creates a remote row + follow, reuses on a second call', async () => {
  const { repo, svc } = await setup()
  const alice = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const url = 'https://blog.example/feed.xml'

  const first = await svc.subscribeByUrl(alice, url, 'webfeed')
  expect(first).toMatchObject({ followed: true })
  if ('error' in first) throw new Error('unexpected cap')
  expect(first.user.feedUrl).toBe(url)
  expect(first.user.feedType).toBe('webfeed')

  const second = await svc.subscribeByUrl(alice, url, 'webfeed')
  if ('error' in second) throw new Error('unexpected cap')
  expect(second.user.id).toBe(first.user.id) // reused, not re-created

  const remotes = await repo.listRemoteUsers()
  expect(remotes.filter((u) => u.feedUrl === url)).toHaveLength(1)
  expect(await repo.listFollowing(alice.id)).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.user.id })]))
})

test('subscribeByUrl tags person type on create', async () => {
  const { repo, svc } = await setup()
  const alice = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const result = await svc.subscribeByUrl(alice, 'https://person.example/feed.xml', 'person')
  if ('error' in result) throw new Error('unexpected cap')
  expect(result.user.feedType).toBe('person')
})

test('subscribeByUrl returns {error: cap} at the limit and creates nothing', async () => {
  const { repo, svc } = await setup()
  const alice = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  await svc.setSetting('max_subs_per_user', '1')
  await svc.subscribeByUrl(alice, 'https://one.example/feed.xml', 'webfeed')

  const before = await repo.listRemoteUsers()
  const result = await svc.subscribeByUrl(alice, 'https://two.example/feed.xml', 'webfeed')
  expect(result).toEqual({ error: 'cap' })
  const after = await repo.listRemoteUsers()
  expect(after).toHaveLength(before.length) // nothing created
})

test('subscribeByUrl re-resolves and follows the winner when a concurrent create races the UNIQUE(feed_url) index (addendum B)', async () => {
  // mintRemoteUser exhausts MAX_HANDLE_ATTEMPTS retries because createRemoteUser
  // always throws HandleTakenError — same error insertUser maps a feed_url
  // collision to (indistinguishable from a handle collision). subscribeByUrl
  // must re-resolve by feed_url instead of throwing.
  const url = 'https://race.example/feed.xml'
  const winner: User = { id: 'winner-id', kind: 'remote', handle: 'winner', displayName: 'Winner', feedUrl: url, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null, feedType: 'webfeed' }
  let getByUrlCalls = 0
  const follows: Array<[string, string]> = []
  const repo = {
    getRemoteUserByFeedUrl: async () => { getByUrlCalls++; return getByUrlCalls === 1 ? undefined : winner },
    getSetting: async () => undefined,
    countRemoteSubscriptions: async () => 0,
    createRemoteUser: async () => { throw new HandleTakenError('feed_url already taken') },
    addFollow: async (followerId: string, followedId: string) => { follows.push([followerId, followedId]) },
  } as unknown as Repository
  const svc = createService(repo, createEventBus())
  const alice: User = { id: 'alice-id', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }

  const result = await svc.subscribeByUrl(alice, url, 'webfeed')

  expect(result).toEqual({ user: winner, followed: true })
  expect(follows).toEqual([['alice-id', 'winner-id']])
  expect(getByUrlCalls).toBe(2) // initial miss, then the post-mint re-resolve
})
