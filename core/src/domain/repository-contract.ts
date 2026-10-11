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

    test('countPostsByAuthor counts only that author\'s ROOT posts', async () => {
      const { repo, logical } = await makeRepoAndStore()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const b = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
      const roots = [1, 2, 3].map((i) => logical.createLocalPost({ author: a, content: `alice ${i}`, replyToId: null, now: `2026-01-0${i}T00:00:00.000Z` }))
      logical.createLocalPost({ author: b, content: 'bob 1', replyToId: null, now: '2026-01-09T00:00:00.000Z' })
      // A reply is NOT a root post — it must not inflate the count, matching the
      // river above the author-lens stat (which is root-only, see projector.ts's
      // `river` filter: `AND p.in_reply_to_post_id IS NULL`).
      logical.createLocalPost({ author: a, content: 'alice replies to her own root', replyToId: roots[0]!.id, now: '2026-01-04T00:00:00.000Z' })
      expect(await repo.countPostsByAuthor(a.id)).toBe(3)
      expect(await repo.countPostsByAuthor(b.id)).toBe(1)
      expect(await repo.countPostsByAuthor('no-such-id')).toBe(0)
    })

    test('countFollowers counts followed_id edges and reflects removeLocalFollow', async () => {
      const { repo, logical } = await makeRepoAndStore()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const b = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
      const c = await repo.createLocalUser({ handle: 'carol', displayName: 'Carol' })
      logical.addLocalFollow({ followerId: b.id, followedId: a.id, now: '2026-01-01T00:00:00.000Z' })
      logical.addLocalFollow({ followerId: c.id, followedId: a.id, now: '2026-01-02T00:00:00.000Z' })
      expect(await repo.countFollowers(a.id)).toBe(2)
      logical.removeLocalFollow({ followerId: b.id, followedId: a.id, now: '2026-01-03T00:00:00.000Z' })
      expect(await repo.countFollowers(a.id)).toBe(1)
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
  })
}
