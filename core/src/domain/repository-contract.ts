import { describe, test, expect } from 'vitest'
import type { Repository } from './repository.ts'
import { HandleTakenError } from './types.ts'

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

    test('getTimeline pages with a before cursor: page 2 starts where page 1 ended', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      for (let i = 1; i <= 3; i++) {
        await repo.insertPost({ id: `p${i}`, authorId: a.id, source: 'local', guid: `g${i}`, title: null, content: `post ${i}`, url: null, publishedAt: `2026-01-0${i}T00:00:00.000Z`, createdAt: `2026-01-0${i}T00:00:00.000Z` })
      }
      const page1 = await repo.getTimeline(2)
      expect(page1.map((e) => e.id)).toEqual(['p3', 'p2'])
      const last = page1[page1.length - 1]
      const page2 = await repo.getTimeline(2, { publishedAt: last.publishedAt, id: last.id })
      expect(page2.map((e) => e.id)).toEqual(['p1'])
    })

    test('getTimeline splits publishedAt ties by id across pages', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const t = '2026-01-01T00:00:00.000Z'
      await repo.insertPost({ id: 'aaa', authorId: a.id, source: 'local', guid: 'g-aaa', title: null, content: 'tie low', url: null, publishedAt: t, createdAt: t })
      await repo.insertPost({ id: 'zzz', authorId: a.id, source: 'local', guid: 'g-zzz', title: null, content: 'tie high', url: null, publishedAt: t, createdAt: t })
      const page1 = await repo.getTimeline(1)
      expect(page1[0].id).toBe('zzz')
      const page2 = await repo.getTimeline(1, { publishedAt: t, id: 'zzz' })
      expect(page2[0].id).toBe('aaa')
    })

    test('getTimelineAfter returns arrival order, inclusive of the anchor timestamp', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      // anchor: arrived first, displays newest (published latest)
      await repo.insertPost({ id: 'anchor', authorId: a.id, source: 'local', guid: 'g-anchor', title: null, content: 'anchor', url: null, publishedAt: '2026-01-10T12:00:00.000Z', createdAt: '2026-01-10T12:00:00.000Z' })
      // same-created_at sibling (R1 case)
      await repo.insertPost({ id: 'sibling', authorId: a.id, source: 'local', guid: 'g-sibling', title: null, content: 'sibling', url: null, publishedAt: '2026-01-10T12:00:00.000Z', createdAt: '2026-01-10T12:00:00.000Z' })
      // arrived later but published in the past (H1 case)
      await repo.insertPost({ id: 'olddate', authorId: a.id, source: 'remote', guid: 'g-old', title: null, content: 'old-dated', url: null, publishedAt: '2020-01-01T00:00:00.000Z', createdAt: '2026-01-10T12:00:01.000Z' })
      const replay = await repo.getTimelineAfter('2026-01-10T12:00:00.000Z', 10)
      expect(replay.map((e) => e.id)).toEqual(['anchor', 'sibling', 'olddate'])
      expect(replay[0].author.handle).toBe('alice')
    })

    test('getPost returns a post by id and undefined for unknown ids', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      await repo.insertPost({ id: 'p1', authorId: a.id, source: 'local', guid: 'g1', title: null, content: 'x', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
      expect((await repo.getPost('p1'))?.guid).toBe('g1')
      expect(await repo.getPost('nope')).toBeUndefined()
    })

    test('creating a user with a taken handle throws HandleTakenError (both kinds)', async () => {
      const repo = await makeRepo()
      await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      await expect(repo.createLocalUser({ handle: 'alice', displayName: 'Alice 2' })).rejects.toThrow(HandleTakenError)
      await expect(repo.createRemoteUser({ handle: 'alice', displayName: 'A', feedUrl: 'https://ex.com/f.xml' })).rejects.toThrow(HandleTakenError)
    })
  })
}
