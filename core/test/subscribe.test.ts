import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'

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
