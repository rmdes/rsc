import { describe, test, expect } from 'vitest'
import type { Repository } from './repository.ts'
import { HandleTakenError } from './types.ts'
import type { Subscription, PushSubscription, Post } from './types.ts'
import { randomUUID } from 'node:crypto'

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

    test('updateFeedUrl changes a user feedUrl and no-ops on an unknown id', async () => {
      const repo = await makeRepo()
      const u = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/page' })
      await repo.updateFeedUrl(u.id, 'https://ex.com/feed.xml')
      expect((await repo.getUser(u.id))?.feedUrl).toBe('https://ex.com/feed.xml')
      await repo.updateFeedUrl('no-such-id', 'https://ex.com/x') // no throw
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
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const b = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
      for (let i = 1; i <= 3; i++) {
        await repo.insertPost({ id: `a${i}`, authorId: a.id, source: 'local', guid: `ga${i}`, title: null, content: `alice ${i}`, url: null, publishedAt: `2026-01-0${i}T00:00:00.000Z`, createdAt: `2026-01-0${i}T00:00:00.000Z` })
      }
      await repo.insertPost({ id: 'b1', authorId: b.id, source: 'local', guid: 'gb1', title: null, content: 'bob 1', url: null, publishedAt: '2026-01-09T00:00:00.000Z', createdAt: '2026-01-09T00:00:00.000Z' })
      const posts = await repo.getPostsByAuthor(a.id, 2)
      expect(posts.map((p) => p.id)).toEqual(['a3', 'a2'])
    })

    function pushSub(over: Partial<PushSubscription>, userId: string): PushSubscription {
      return { id: randomUUID(), userId, mode: 'websub', endpoint: 'https://hub.example.com/hub', topic: 'https://blog.example.com/feed.xml', callbackToken: 'tok-' + randomUUID(), secret: 's3cret', state: 'pending', expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over }
    }

    test('upsertPushSubscription keys on (user, mode) and NEVER overwrites token or secret', async () => {
      const repo = await makeRepo()
      const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog.example.com/feed.xml' })
      await repo.upsertPushSubscription(pushSub({ callbackToken: 'original-token', secret: 'original-secret' }, u.id))
      await repo.upsertPushSubscription(pushSub({ callbackToken: 'SHOULD-NOT-LAND', secret: 'SHOULD-NOT-LAND', state: 'active', expiresAt: '2028-01-01T00:00:00.000Z', endpoint: 'https://hub2.example.com/hub' }, u.id))
      const row = await repo.findPushSubscription({ userId: u.id, mode: 'websub' })
      expect(row?.callbackToken).toBe('original-token') // H4 pin
      expect(row?.secret).toBe('original-secret')
      expect(row?.state).toBe('active')
      expect(row?.endpoint).toBe('https://hub2.example.com/hub')
    })

    test('findPushSubscription filters by token, user+mode, mode+topic, expiry, and state', async () => {
      const repo = await makeRepo()
      const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog.example.com/feed.xml' })
      await repo.upsertPushSubscription(pushSub({ callbackToken: 'tok-1', state: 'active', expiresAt: '2027-01-01T00:00:00.000Z' }, u.id))
      await repo.upsertPushSubscription(pushSub({ mode: 'rsscloud', callbackToken: 'tok-2', topic: 'https://blog.example.com/rss.xml', state: 'pending', expiresAt: '2026-01-01T00:10:00.000Z' }, u.id))
      expect((await repo.findPushSubscription({ token: 'tok-1' }))?.mode).toBe('websub')
      expect((await repo.findPushSubscription({ userId: u.id, mode: 'rsscloud' }))?.callbackToken).toBe('tok-2')
      expect((await repo.findPushSubscription({ mode: 'rsscloud', topic: 'https://blog.example.com/rss.xml' }))?.userId).toBe(u.id)
      expect(await repo.findPushSubscription({ userId: u.id }, { unexpiredAt: '2026-06-01T00:00:00.000Z' })).toMatchObject({ mode: 'websub' }) // pending one expired
      expect(await repo.findPushSubscription({ userId: u.id }, { state: 'pending' })).toMatchObject({ mode: 'rsscloud' })
      expect(await repo.findPushSubscription({ token: 'nope' })).toBeUndefined()
    })

    test('listRenewablePushSubscriptions returns only active rows expiring before the horizon', async () => {
      const repo = await makeRepo()
      const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog.example.com/feed.xml' })
      await repo.upsertPushSubscription(pushSub({ state: 'active', expiresAt: '2026-06-01T00:00:00.000Z' }, u.id))
      await repo.upsertPushSubscription(pushSub({ mode: 'rsscloud', callbackToken: 'tok-rc', state: 'pending', expiresAt: '2026-06-01T00:00:00.000Z' }, u.id))
      const due = await repo.listRenewablePushSubscriptions('2026-07-01T00:00:00.000Z')
      expect(due.length).toBe(1)
      expect(due[0].mode).toBe('websub')
      expect((await repo.listRenewablePushSubscriptions('2026-05-01T00:00:00.000Z')).length).toBe(0)
    })

    test('deletePushSubscription removes the row', async () => {
      const repo = await makeRepo()
      const u = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://blog.example.com/feed.xml' })
      const s = pushSub({}, u.id)
      await repo.upsertPushSubscription(s)
      const row = await repo.findPushSubscription({ userId: u.id, mode: 'websub' })
      await repo.deletePushSubscription(row!.id)
      expect(await repo.findPushSubscription({ userId: u.id, mode: 'websub' })).toBeUndefined()
    })

    test('addFollow is idempotent and listFollowing returns follows in created_at order', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const b = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      const c = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://ex.com/b.xml' })
      await repo.addFollow(a.id, c.id) // follow 'blog' first
      await repo.addFollow(a.id, b.id) // follow 'news' second
      await repo.addFollow(a.id, c.id) // duplicate re-follow of blog — still idempotent
      const following = await repo.listFollowing(a.id)
      // Insertion order (blog first, news second) matches assertion regardless of timing.
      // Even if both land in the same millisecond and tiebreak by handle ASC, result is blog, news.
      expect(following.map((u) => u.handle)).toEqual(['blog', 'news'])
    })

    test('removeFollow is idempotent (removing a non-follow is a no-op)', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      const b = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
      await repo.removeFollow(a.id, b.id) // never followed — no throw
      await repo.addFollow(a.id, b.id)
      await repo.removeFollow(a.id, b.id)
      await repo.removeFollow(a.id, b.id) // already gone — no throw
      expect(await repo.listFollowing(a.id)).toEqual([])
    })

    test('self-follow is allowed and needs no special-casing', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
      await repo.addFollow(a.id, a.id)
      expect((await repo.listFollowing(a.id)).map((u) => u.id)).toEqual([a.id])
    })

    test('followedBy filter scopes the timeline to followed authors, paginating across boundaries', async () => {
      const repo = await makeRepo()
      const me = await repo.createLocalUser({ handle: 'me', displayName: 'Me' })
      const x = await repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://ex.com/x.xml' })
      const y = await repo.createRemoteUser({ handle: 'y', displayName: 'Y', feedUrl: 'https://ex.com/y.xml' })
      await repo.addFollow(me.id, x.id) // follows X, not Y
      const mk = (id: string, author: string, day: string) => repo.insertPost({ id, authorId: author, source: 'remote', guid: id, title: null, content: id, url: null, publishedAt: `2026-01-${day}T00:00:00.000Z`, createdAt: `2026-01-${day}T00:00:00.000Z` })
      await mk('x1', x.id, '01'); await mk('y1', y.id, '02'); await mk('x2', x.id, '03'); await mk('y2', y.id, '04')
      const page1 = await repo.getTimeline(1, undefined, { followedBy: me.id })
      expect(page1.map((e) => e.id)).toEqual(['x2']) // newest followed post, Y excluded
      const page2 = await repo.getTimeline(1, { publishedAt: page1[0].publishedAt, id: page1[0].id }, { followedBy: me.id })
      expect(page2.map((e) => e.id)).toEqual(['x1'])
    })

    test('authorId filter scopes to one author (works for remote authors too)', async () => {
      const repo = await makeRepo()
      const x = await repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://ex.com/x.xml' })
      const y = await repo.createRemoteUser({ handle: 'y', displayName: 'Y', feedUrl: 'https://ex.com/y.xml' })
      await repo.insertPost({ id: 'x1', authorId: x.id, source: 'remote', guid: 'x1', title: null, content: 'x1', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
      await repo.insertPost({ id: 'y1', authorId: y.id, source: 'remote', guid: 'y1', title: null, content: 'y1', url: null, publishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z' })
      const tl = await repo.getTimeline(10, undefined, { authorId: x.id })
      expect(tl.map((e) => e.id)).toEqual(['x1'])
    })

    const mkPost = (over: Partial<Post> & { id: string; authorId: string }): Post => ({
      source: 'remote', guid: over.id, title: null, content: over.id, url: null,
      publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over,
    })

    test('backfillSourceAttribution fills only null attribution on existing posts', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'agg', displayName: 'Agg', feedUrl: 'https://agg.ex/f' })
      await repo.insertPost(mkPost({ id: 'p1', authorId: a.id, guid: 'g1' }))
      await repo.backfillSourceAttribution(a.id, 'g1', 'Dave Winer', 'https://rss.chat/users/dave/rss.xml')
      const p = await repo.getPost('p1')
      expect([p?.sourceName, p?.sourceFeedUrl]).toEqual(['Dave Winer', 'https://rss.chat/users/dave/rss.xml'])
      // already attributed → untouched (no flapping when a feed edits attribution)
      await repo.backfillSourceAttribution(a.id, 'g1', 'Someone Else', 'https://other.ex/f.xml')
      expect((await repo.getPost('p1'))?.sourceName).toBe('Dave Winer')
      // unknown guid → silent no-op
      await repo.backfillSourceAttribution(a.id, 'nope', 'X', null)
    })

    test('findPostByRef: unique url wins; duplicated url resolves to NOTHING (Hole A)', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'a', displayName: 'A', feedUrl: 'https://a.ex/f' })
      const b = await repo.createRemoteUser({ handle: 'b', displayName: 'B', feedUrl: 'https://b.ex/f' })
      await repo.insertPost(mkPost({ id: 'p1', authorId: a.id, url: 'https://a.ex/1' }))
      expect((await repo.findPostByRef('https://a.ex/1'))?.id).toBe('p1')
      await repo.insertPost(mkPost({ id: 'p2', authorId: b.id, url: 'https://a.ex/1' })) // syndicated duplicate
      expect(await repo.findPostByRef('https://a.ex/1')).toBeUndefined()
    })

    test('findPostByRef: unique guid matches; guid shared by two posts resolves to NOTHING (H2)', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'a', displayName: 'A', feedUrl: 'https://a.ex/f' })
      const b = await repo.createRemoteUser({ handle: 'b', displayName: 'B', feedUrl: 'https://b.ex/f' })
      await repo.insertPost(mkPost({ id: 'g1', authorId: a.id, guid: 'shared-guid' }))
      expect((await repo.findPostByRef('shared-guid'))?.id).toBe('g1')
      await repo.insertPost(mkPost({ id: 'g2', authorId: b.id, guid: 'shared-guid' })) // guid unique per (author,guid) only
      expect(await repo.findPostByRef('shared-guid')).toBeUndefined()
      expect(await repo.findPostByRef('nope')).toBeUndefined()
    })

    test('reply fields round-trip through insertPost/getPost and default to null', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
      await repo.insertPost(mkPost({ id: 'root', authorId: a.id }))
      await repo.insertPost(mkPost({ id: 're', authorId: a.id, inReplyTo: 'root', inReplyToPostId: 'root', threadRootId: 'root' }))
      const re = await repo.getPost('re')
      expect([re?.inReplyTo, re?.inReplyToPostId, re?.threadRootId]).toEqual(['root', 'root', 'root'])
      const root = await repo.getPost('root')
      expect([root?.inReplyTo, root?.inReplyToPostId, root?.threadRootId]).toEqual([null, null, null])
    })

    test('getThread returns root + all descendants flat, (published_at, id) ASC', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
      const day = (d: string) => `2026-01-0${d}T00:00:00.000Z`
      await repo.insertPost(mkPost({ id: 'root', authorId: a.id, publishedAt: day('1') }))
      await repo.insertPost(mkPost({ id: 'r1', authorId: a.id, publishedAt: day('2'), inReplyTo: 'root', inReplyToPostId: 'root', threadRootId: 'root' }))
      await repo.insertPost(mkPost({ id: 'r2', authorId: a.id, publishedAt: day('3'), inReplyTo: 'r1', inReplyToPostId: 'r1', threadRootId: 'root' }))
      await repo.insertPost(mkPost({ id: 'other', authorId: a.id, publishedAt: day('4') }))
      expect((await repo.getThread('root')).map((e) => e.id)).toEqual(['root', 'r1', 'r2'])
    })

    test('getThread never shows a reply before its parent, even when feed-truncated timestamps invert them', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
      await repo.insertPost(mkPost({ id: 'root', authorId: a.id, publishedAt: '2026-01-01T00:00:00.500Z' }))
      // RFC-822 pubDate truncates sub-second precision: the reply's timestamp sorts EARLIER than its parent
      await repo.insertPost(mkPost({ id: 're', authorId: a.id, publishedAt: '2026-01-01T00:00:00.000Z', inReplyTo: 'root', inReplyToPostId: 'root', threadRootId: 'root' }))
      expect((await repo.getThread('root')).map((e) => e.id)).toEqual(['root', 're'])
    })

    test('getThread terminates on a mutual-reply cycle (adoption-formed) and returns each post exactly once', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
      await repo.insertPost(mkPost({ id: 'x', authorId: a.id, inReplyToPostId: 'y', threadRootId: 'x' }))
      await repo.insertPost(mkPost({ id: 'y', authorId: a.id, inReplyToPostId: 'x', threadRootId: 'x' }))
      const thread = await repo.getThread('x')
      expect(thread.map((e) => e.id)).toEqual(['x', 'y'])
    })

    test('adoptOrphans attaches earlier orphans and re-roots their whole subtree', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'a', displayName: 'A', feedUrl: 'https://a.ex/f' })
      const day = (d: string) => `2026-01-0${d}T00:00:00.000Z`
      // Distinct publishedAt per post: getThread orders (published_at, id) ASC and
      // gives NO root-first guarantee on ties — same reason Task 1's test uses days.
      // Arrival order: reply-to-reply first, then reply, then the root (worst case).
      await repo.insertPost(mkPost({ id: 'rr', authorId: a.id, publishedAt: day('3'), inReplyTo: 'https://a.ex/r1' }))
      await repo.insertPost(mkPost({ id: 'r1', authorId: a.id, publishedAt: day('2'), url: 'https://a.ex/r1', inReplyTo: 'root-guid' }))
      await repo.adoptOrphans((await repo.getPost('r1'))!) // rr adopted by r1 (r1 is its own root for now)
      expect((await repo.getPost('rr'))?.threadRootId).toBe('r1')
      expect((await repo.getPost('rr'))?.inReplyToPostId).toBe('r1')
      await repo.insertPost(mkPost({ id: 'root', authorId: a.id, publishedAt: day('1'), guid: 'root-guid' }))
      await repo.adoptOrphans((await repo.getPost('root'))!)
      // r1 adopted by root; rr's subtree re-rooted to the TOP root in the same pass
      expect((await repo.getPost('r1'))?.threadRootId).toBe('root')
      expect((await repo.getPost('r1'))?.inReplyToPostId).toBe('root')
      expect((await repo.getPost('rr'))?.threadRootId).toBe('root')
      expect((await repo.getThread('root')).map((e) => e.id)).toEqual(['root', 'r1', 'rr'])
    })

    test('adoption refuses ambiguous refs on BOTH arms (H2 + Hole A)', async () => {
      const repo = await makeRepo()
      const a = await repo.createRemoteUser({ handle: 'a', displayName: 'A', feedUrl: 'https://a.ex/f' })
      const b = await repo.createRemoteUser({ handle: 'b', displayName: 'B', feedUrl: 'https://b.ex/f' })
      await repo.insertPost(mkPost({ id: 'orphan', authorId: a.id, inReplyTo: 'dup-guid' }))
      await repo.insertPost(mkPost({ id: 'h1', authorId: a.id, guid: 'dup-guid' }))
      await repo.insertPost(mkPost({ id: 'h2', authorId: b.id, guid: 'dup-guid' }))
      await repo.adoptOrphans((await repo.getPost('h2'))!) // dup-guid held by h1 AND h2 → refuse
      expect((await repo.getPost('orphan'))?.inReplyToPostId).toBeNull()
      // url arm: same shape
      await repo.insertPost(mkPost({ id: 'orphan2', authorId: a.id, inReplyTo: 'https://dup.ex/1' }))
      await repo.insertPost(mkPost({ id: 'u1', authorId: a.id, url: 'https://dup.ex/1' }))
      await repo.insertPost(mkPost({ id: 'u2', authorId: b.id, url: 'https://dup.ex/1' }))
      await repo.adoptOrphans((await repo.getPost('u2'))!)
      expect((await repo.getPost('orphan2'))?.inReplyToPostId).toBeNull()
    })

    test('countRepliesByPostIds and listRepliesByPostId key on resolved ids only', async () => {
      const repo = await makeRepo()
      const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
      await repo.insertPost(mkPost({ id: 'root', authorId: a.id }))
      await repo.insertPost(mkPost({ id: 'r1', authorId: a.id, publishedAt: '2026-01-02T00:00:00.000Z', inReplyTo: 'root', inReplyToPostId: 'root', threadRootId: 'root' }))
      await repo.insertPost(mkPost({ id: 'r2', authorId: a.id, publishedAt: '2026-01-03T00:00:00.000Z', inReplyTo: 'root', inReplyToPostId: 'root', threadRootId: 'root' }))
      // an UNRESOLVED reply whose raw ref happens to equal the root's guid must NOT count
      await repo.insertPost(mkPost({ id: 'stray', authorId: a.id, inReplyTo: 'root' }))
      const counts = await repo.countRepliesByPostIds(['root', 'r1'])
      expect(counts.get('root')).toBe(2)
      expect(counts.get('r1')).toBeUndefined()
      expect(await repo.countRepliesByPostIds([])).toEqual(new Map())
      expect((await repo.listRepliesByPostId('root')).map((p) => p.id)).toEqual(['r1', 'r2'])
    })
  })
}
