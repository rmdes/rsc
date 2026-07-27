import { describe, test, expect } from 'vitest'
import type { Repository } from './repository.ts'
import { HandleTakenError } from './types.ts'
import type { Subscription } from './types.ts'
import { createDatabaseContext, type DatabaseContext } from '../logical/database.ts'
import { createLogicalStore } from '../logical/store.ts'

// The v1 post/follow WRITERS (insertPost, addFollow, …) are being retired, so
// every fixture here seeds through the logical store — the same path production
// takes — and asserts against the surviving Repository readers. That needs the
// raw handle, which only the concrete repository carries.
export function runRepositoryContract(makeRepo: () => Promise<Repository & Pick<DatabaseContext, 'raw'>>) {
  describe('Repository contract', () => {
    async function makeRepoAndStore() {
      const repo = await makeRepo()
      return { repo, logical: createLogicalStore(createDatabaseContext(repo.raw)) }
    }

    // Legacy v1 row shapes (a remote-authored post; an unresolved raw in_reply_to
    // ref) that nothing writes any more but converted databases still hold —
    // which is exactly what the two filters exercised below defend against.
    // Seeded raw because every Repository method that could write this is dying.
    function seedLegacyPost(repo: Pick<DatabaseContext, 'raw'>, p: { id: string; authorId: string; source: 'local' | 'remote'; at: string; inReplyTo?: string }): void {
      repo.raw.prepare(
        `INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
      ).run(p.id, p.authorId, p.source, `g-${p.id}`, p.id, p.at, p.at, p.inReplyTo ?? null)
    }

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

    test('creates a remote user', async () => {
      const repo = await makeRepo()
      await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const r = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      expect(r.kind).toBe('remote')
      expect(r.feedUrl).toBe('https://ex.com/f.xml')
    })

    test('updateFeedUrl changes a user feedUrl and no-ops on an unknown id', async () => {
      const repo = await makeRepo()
      const u = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/page' })
      await repo.updateFeedUrl(u.id, 'https://ex.com/feed.xml')
      expect((await repo.getUser(u.id))?.feedUrl).toBe('https://ex.com/feed.xml')
      await repo.updateFeedUrl('no-such-id', 'https://ex.com/x') // no throw
    })

    test('getPost returns a post by id and undefined for unknown ids', async () => {
      const { repo, logical } = await makeRepoAndStore()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const p = logical.createLocalPost({ author: a, content: 'x', replyToId: null, now: '2026-01-01T00:00:00.000Z' })
      expect((await repo.getPost(p.id))?.content).toBe('x')
      expect(await repo.getPost('nope')).toBeUndefined()
    })

    test('creating a user with a taken handle throws HandleTakenError (both kinds)', async () => {
      const repo = await makeRepo()
      await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      await expect(repo.createLocalUser({ handle: 'alice', displayName: 'Alice 2' })).rejects.toThrow(HandleTakenError)
      await expect(repo.createRemoteUser({ handle: 'alice', displayName: 'A', feedUrl: 'https://ex.com/f.xml' })).rejects.toThrow(HandleTakenError)
    })

    function sub(over: Partial<Subscription>): Subscription {
      return { id: crypto.randomUUID(), protocol: 'websub', topic: 'https://ex.com/users/alice/feed.xml', callback: 'https://cb.example.com/receive', callbackHost: 'cb.example.com', secret: null, expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over }
    }

    test('upsertSubscription inserts, and refreshes secret/expiry on the same triple', async () => {
      const repo = await makeRepo()
      await repo.upsertSubscription(sub({}))
      await repo.upsertSubscription(sub({ secret: 's3cret', expiresAt: '2028-01-01T00:00:00.000Z' }))
      const active = await repo.listActiveSubscriptions('https://ex.com/users/alice/feed.xml', '2026-06-01T00:00:00.000Z')
      expect(active.length).toBe(1)
      expect(active[0].secret).toBe('s3cret')
      expect(active[0].expiresAt).toBe('2028-01-01T00:00:00.000Z')
    })

    test('listActiveSubscriptions filters expired rows and returns both protocols', async () => {
      const repo = await makeRepo()
      await repo.upsertSubscription(sub({ callback: 'https://cb1.example.com/a', callbackHost: 'cb1.example.com' }))
      await repo.upsertSubscription(sub({ protocol: 'rsscloud', callback: 'http://cb2.example.com:5337/notify', callbackHost: 'cb2.example.com' }))
      await repo.upsertSubscription(sub({ callback: 'https://cb3.example.com/x', callbackHost: 'cb3.example.com', expiresAt: '2026-01-02T00:00:00.000Z' }))
      const active = await repo.listActiveSubscriptions('https://ex.com/users/alice/feed.xml', '2026-06-01T00:00:00.000Z')
      expect(active.map((s) => s.callbackHost).sort()).toEqual(['cb1.example.com', 'cb2.example.com'])
    })

    test('deleteSubscription removes exactly the triple', async () => {
      const repo = await makeRepo()
      await repo.upsertSubscription(sub({}))
      await repo.deleteSubscription('websub', 'https://ex.com/users/alice/feed.xml', 'https://cb.example.com/receive')
      expect(await repo.listActiveSubscriptions('https://ex.com/users/alice/feed.xml', '2026-06-01T00:00:00.000Z')).toEqual([])
    })

    test('countActiveSubscriptions counts by callbackHost and by topic, excluding expired', async () => {
      const repo = await makeRepo()
      await repo.upsertSubscription(sub({ callback: 'https://cb.example.com/a' }))
      await repo.upsertSubscription(sub({ callback: 'https://cb.example.com/b' }))
      await repo.upsertSubscription(sub({ callback: 'https://cb.example.com/dead', expiresAt: '2026-01-02T00:00:00.000Z' }))
      await repo.upsertSubscription(sub({ topic: 'https://ex.com/users/bob/feed.xml', callback: 'https://other.example.com/x', callbackHost: 'other.example.com' }))
      const now = '2026-06-01T00:00:00.000Z'
      expect(await repo.countActiveSubscriptions({ callbackHost: 'cb.example.com' }, now)).toBe(2)
      expect(await repo.countActiveSubscriptions({ topic: 'https://ex.com/users/alice/feed.xml' }, now)).toBe(2)
    })

    test('purgeExpiredSubscriptions deletes only expired rows', async () => {
      const repo = await makeRepo()
      await repo.upsertSubscription(sub({}))
      await repo.upsertSubscription(sub({ callback: 'https://cb.example.com/dead', expiresAt: '2026-01-02T00:00:00.000Z' }))
      await repo.purgeExpiredSubscriptions('2026-06-01T00:00:00.000Z')
      expect(await repo.countActiveSubscriptions({ callbackHost: 'cb.example.com' }, '2020-01-01T00:00:00.000Z')).toBe(1)
    })

    test('getPostsByAuthor returns only that author, display-ordered, limited', async () => {
      const { repo, logical } = await makeRepoAndStore()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const b = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
      const mine = [1, 2, 3].map((i) => logical.createLocalPost({ author: a, content: `alice ${i}`, replyToId: null, now: `2026-01-0${i}T00:00:00.000Z` }))
      // bob's post is the newest of all: it would lead an unscoped result
      logical.createLocalPost({ author: b, content: 'bob 1', replyToId: null, now: '2026-01-09T00:00:00.000Z' })
      const posts = await repo.getPostsByAuthor(a.id, 2)
      expect(posts.map((p) => p.id)).toEqual([mine[2].id, mine[1].id])
    })

    test('listFollowing returns follows in created_at order and duplicate follows are idempotent', async () => {
      const { repo, logical } = await makeRepoAndStore()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const news = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      const blog = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://ex.com/b.xml' })
      // 'news' first even though it sorts LAST by handle: created_at leads, the
      // handle is only the same-ms tiebreak.
      logical.addLocalFollow({ followerId: a.id, followedId: news.id, now: '2026-01-01T00:00:00.000Z' })
      logical.addLocalFollow({ followerId: a.id, followedId: blog.id, now: '2026-01-02T00:00:00.000Z' })
      logical.addLocalFollow({ followerId: a.id, followedId: news.id, now: '2026-01-03T00:00:00.000Z' }) // re-follow: no row, no reorder
      expect((await repo.listFollowing(a.id)).map((u) => u.handle)).toEqual(['news', 'blog'])
    })

    test('listFollowing reflects removeLocalFollow, and removing a non-follow is a no-op', async () => {
      const { repo, logical } = await makeRepoAndStore()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const b = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      const now = '2026-01-01T00:00:00.000Z'
      logical.removeLocalFollow({ followerId: a.id, followedId: b.id, now }) // never followed — no throw
      logical.addLocalFollow({ followerId: a.id, followedId: b.id, now })
      logical.removeLocalFollow({ followerId: a.id, followedId: b.id, now })
      logical.removeLocalFollow({ followerId: a.id, followedId: b.id, now }) // already gone — no throw
      expect(await repo.listFollowing(a.id)).toEqual([])
    })

    test('countRepliesByPostIds keys on resolved ids only', async () => {
      const { repo, logical } = await makeRepoAndStore()
      const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
      const post = (content: string, replyToId: string | null, day: string) =>
        logical.createLocalPost({ author: a, content, replyToId, now: `2026-01-0${day}T00:00:00.000Z` })
      const root = post('root', null, '1')
      const r1 = post('r1', root.id, '2')
      post('r2', root.id, '3')
      // a legacy UNRESOLVED reply whose raw ref happens to equal the root's id must NOT count
      seedLegacyPost(repo, { id: 'stray', authorId: a.id, source: 'local', at: '2026-01-04T00:00:00.000Z', inReplyTo: root.id })
      const counts = await repo.countRepliesByPostIds([root.id, r1.id])
      expect(counts.get(root.id)).toBe(2)
      expect(counts.get(r1.id)).toBeUndefined()
      expect(await repo.countRepliesByPostIds([])).toEqual(new Map())
    })

    test('countRepliesByPostIds counts direct replies only, never the whole conversation', async () => {
      const { repo, logical } = await makeRepoAndStore()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const root = logical.createLocalPost({ author: a, content: 'root', replyToId: null, now: '2026-01-01T00:00:00.000Z' })
      const r1 = logical.createLocalPost({ author: a, content: 'r1', replyToId: root.id, now: '2026-01-02T00:00:00.000Z' })
      logical.createLocalPost({ author: a, content: 'r2', replyToId: r1.id, now: '2026-01-03T00:00:00.000Z' })
      // root's grandchild is r1's child, not root's: 1 each, never 2 for the root
      expect(await repo.countRepliesByPostIds([root.id, r1.id])).toEqual(new Map([[root.id, 1], [r1.id, 1]]))
    })

    test('getRecentLocalPosts: local authors only, newest first, limited', async () => {
      const { repo, logical } = await makeRepoAndStore()
      const local = await repo.createLocalUser({ handle: 'loc', displayName: 'Loc' })
      const remote = await repo.createRemoteUser({ handle: 'rem', displayName: 'Rem', feedUrl: 'https://r.ex/f' })
      const l1 = logical.createLocalPost({ author: local, content: 'l1', replyToId: null, now: '2026-01-01T00:00:00.000Z' })
      const l2 = logical.createLocalPost({ author: local, content: 'l2', replyToId: null, now: '2026-01-02T00:00:00.000Z' })
      // legacy remote-authored row, newest of all — excluded by author kind, not by date
      seedLegacyPost(repo, { id: 'r1', authorId: remote.id, source: 'remote', at: '2026-01-03T00:00:00.000Z' })
      const entries = await repo.getRecentLocalPosts(10)
      expect(entries.map((e) => e.id)).toEqual([l2.id, l1.id])
      expect(entries[0].author.handle).toBe('loc') // author joined inline
      expect((await repo.getRecentLocalPosts(1)).map((e) => e.id)).toEqual([l2.id])
    })
  })
}
