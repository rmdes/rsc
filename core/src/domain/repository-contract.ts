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

    test('getUser returns a user by id and undefined for unknown ids', async () => {
      const repo = await makeRepo()
      const u = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      expect(await repo.getUser(u.id)).toEqual(u)
      expect(await repo.getUser('nope')).toBeUndefined()
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
      await repo.insertPost({ id: 'p1', authorId: a.id, source: 'local', guid: 'g1', title: null, content: 'first', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
      await repo.insertPost({ id: 'p2', authorId: a.id, source: 'local', guid: 'g2', title: 'Second title', content: 'second', url: null, publishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z' })
      const tl = await repo.getTimeline(10)
      expect(tl.map((e) => e.id)).toEqual(['p2', 'p1'])
      expect(tl[0].author.handle).toBe('alice')
      expect(tl[0].title).toBe('Second title')
      expect(tl[1].title).toBeNull()
    })

    test('insertPost returns false and does not duplicate on a repeat (author_id, guid) pair', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      const post = { id: 'p1', authorId: a.id, source: 'remote' as const, guid: 'g1', title: null, content: 'x', url: 'https://ex.com/1', publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }
      expect(await repo.insertPost(post)).toBe(true)
      expect(await repo.insertPost({ ...post, id: 'p1-dup' })).toBe(false)
      const tl = await repo.getTimeline(10)
      expect(tl.filter((e) => e.guid === 'g1')).toHaveLength(1)
    })

    test('insertPost allows the same guid under a different author', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'news-a', displayName: 'News A', feedUrl: 'https://ex.com/a.xml' })
      const b = await repo.createRemoteUser({ handle: 'news-b', displayName: 'News B', feedUrl: 'https://ex.com/b.xml' })
      expect(await repo.insertPost({ id: 'pa', authorId: a.id, source: 'remote', guid: 'shared-guid', title: null, content: 'x', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })).toBe(true)
      expect(await repo.insertPost({ id: 'pb', authorId: b.id, source: 'remote', guid: 'shared-guid', title: null, content: 'y', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })).toBe(true)
      const tl = await repo.getTimeline(10)
      expect(tl.filter((e) => e.guid === 'shared-guid')).toHaveLength(2)
    })

    test('hasPostsByAuthor is false before any post and true after', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      expect(await repo.hasPostsByAuthor(a.id)).toBe(false)
      await repo.insertPost({ id: 'p1', authorId: a.id, source: 'remote', guid: 'g1', title: null, content: 'x', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
      expect(await repo.hasPostsByAuthor(a.id)).toBe(true)
    })

    test('inserting a post whose authorId does not exist rejects', async () => {
      const repo = await makeRepo()
      await expect(repo.insertPost({ id: 'p1', authorId: 'no-such-user', source: 'remote', guid: 'g1', title: null, content: 'x', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })).rejects.toThrow()
    })
  })
}
