import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore, type LogicalStore } from '../src/logical/store.ts'

describe('per-user-feeds repo reads', () => {
  let repo: Awaited<ReturnType<typeof createSqliteRepository>>
  let logical: LogicalStore
  beforeEach(async () => {
    repo = await createSqliteRepository(':memory:')
    logical = createLogicalStore(createDatabaseContext(repo.raw))
  })

  it('countFollowers counts followers regardless of follower kind', async () => {
    const remote = await repo.createRemoteUser({ handle: 'eve', displayName: 'Eve', feedUrl: 'https://eve.example/feed.xml', feedType: 'webfeed' })
    const f1 = await repo.createLocalUser({ handle: 'f1', displayName: 'F1' })
    const f2 = await repo.createLocalUser({ handle: 'f2', displayName: 'F2' })
    logical.addLocalFollow({ followerId: f1.id, followedId: remote.id, now: '2026-01-01T00:00:00.000Z' })
    logical.addLocalFollow({ followerId: f2.id, followedId: remote.id, now: '2026-01-02T00:00:00.000Z' })
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
