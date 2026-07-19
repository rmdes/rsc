import { describe, it, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

describe('per-user-feeds schema', () => {
  it('createRemoteUser defaults to webfeed; explicit feedType kept; local rows null', async () => {
    const repo = await createSqliteRepository(':memory:')
    const alice = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
    expect(alice.feedType ?? null).toBeNull()
    const wf = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog/f' }) // no feedType → default
    expect(wf.feedType).toBe('webfeed')
    const inst = await repo.createRemoteUser({ handle: 'peer', displayName: 'Peer', feedUrl: 'https://peer/f', feedType: 'instance' })
    expect(inst.feedType).toBe('instance')
  })

  it('UNIQUE(feed_url) rejects a duplicate remote feed_url', async () => {
    const repo = await createSqliteRepository(':memory:')
    await repo.createRemoteUser({ handle: 'a', displayName: 'A', feedUrl: 'https://x/f' })
    await expect(repo.createRemoteUser({ handle: 'b', displayName: 'B', feedUrl: 'https://x/f' })).rejects.toThrow()
  })
})
