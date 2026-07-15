import { describe, test, expect } from 'vitest'
import type { Repository } from './repository.ts'

export function runRepositoryContract(makeRepo: () => Promise<Repository>) {
  describe('Repository contract', () => {
    test('creates and reads a local user', async () => {
      const repo = await makeRepo()
      const u = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      expect(u.kind).toBe('local')
      expect(u.feedUrl).toBeNull()
      expect(await repo.getUserByHandle('alice')).toEqual(u)
    })

    test('creates a remote user and lists it among remotes only', async () => {
      const repo = await makeRepo()
      await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const r = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      expect(r.kind).toBe('remote')
      expect(r.feedUrl).toBe('https://ex.com/f.xml')
      const remotes = await repo.listRemoteUsers()
      expect(remotes.map((x) => x.handle)).toEqual(['news'])
    })

    test('inserts posts and returns a newest-first timeline with authors', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      await repo.insertPost({ id: 'p1', authorId: a.id, source: 'local', guid: 'g1', content: 'first', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
      await repo.insertPost({ id: 'p2', authorId: a.id, source: 'local', guid: 'g2', content: 'second', url: null, publishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z' })
      const tl = await repo.getTimeline(10)
      expect(tl.map((e) => e.id)).toEqual(['p2', 'p1'])
      expect(tl[0].author.handle).toBe('alice')
    })

    test('hasPostGuid detects duplicates for idempotent ingestion', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      expect(await repo.hasPostGuid('g1')).toBe(false)
      await repo.insertPost({ id: 'p1', authorId: a.id, source: 'remote', guid: 'g1', content: 'x', url: 'https://ex.com/1', publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
      expect(await repo.hasPostGuid('g1')).toBe(true)
    })
  })
}
