import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import type { Repository } from '../src/domain/repository.ts'

describe('per-user-feeds repo reads', () => {
  let repo: Repository
  beforeEach(async () => {
    repo = await createSqliteRepository(':memory:')
  })

  it('getRemoteUserByFeedUrl finds a remote row by feed_url, undefined on unknown', async () => {
    const remote = await repo.createRemoteUser({ handle: 'alice', displayName: 'Alice', feedUrl: 'https://alice.example/feed.xml', feedType: 'person' })
    await expect(repo.getRemoteUserByFeedUrl('https://alice.example/feed.xml')).resolves.toMatchObject({ id: remote.id })
    await expect(repo.getRemoteUserByFeedUrl('https://unknown.example/feed.xml')).resolves.toBeUndefined()
  })

  it('countRemoteSubscriptions counts only person/webfeed follows, excludes local and instance', async () => {
    const local = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
    const otherLocal = await repo.createLocalUser({ handle: 'carol', displayName: 'Carol' })
    const person = await repo.createRemoteUser({ handle: 'dana', displayName: 'Dana', feedUrl: 'https://dana.example/feed.xml', feedType: 'person' })
    const webfeed = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog.example/feed.xml', feedType: 'webfeed' })
    const instance = await repo.createRemoteUser({ handle: 'peer', displayName: 'Peer', feedUrl: 'https://peer.example/feed.xml', feedType: 'instance' })
    await repo.addFollow(local.id, person.id)
    await repo.addFollow(local.id, webfeed.id)
    await repo.addFollow(local.id, instance.id)
    await repo.addFollow(local.id, otherLocal.id)
    await expect(repo.countRemoteSubscriptions(local.id)).resolves.toBe(2)
  })

  it('countFollowers counts followers regardless of follower kind', async () => {
    const remote = await repo.createRemoteUser({ handle: 'eve', displayName: 'Eve', feedUrl: 'https://eve.example/feed.xml', feedType: 'webfeed' })
    const f1 = await repo.createLocalUser({ handle: 'f1', displayName: 'F1' })
    const f2 = await repo.createLocalUser({ handle: 'f2', displayName: 'F2' })
    await repo.addFollow(f1.id, remote.id)
    await repo.addFollow(f2.id, remote.id)
    await expect(repo.countFollowers(remote.id)).resolves.toBe(2)
  })

  it('getSetting reads seeded default, setSetting round-trips (insert + update)', async () => {
    await expect(repo.getSetting('max_subs_per_user')).resolves.toBe('500')
    await expect(repo.getSetting('unknown_key')).resolves.toBeUndefined()
    await repo.setSetting('max_subs_per_user', '250')
    await expect(repo.getSetting('max_subs_per_user')).resolves.toBe('250')
    await repo.setSetting('new_key', 'value')
    await expect(repo.getSetting('new_key')).resolves.toBe('value')
  })
})
