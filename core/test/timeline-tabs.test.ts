import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteRepository, type SqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth } from './auth-helper.ts'

// The four timeline tabs: Local (posts.source='local'), Federated
// (users.feed_type='instance'), Personal river (followedBy, instances
// excluded even via a stale follow edge), Public river (no filter).
describe('timeline tabs', () => {
  let repo: SqliteRepository
  let alice: string
  let localPostId: string
  let webfeedPostId: string
  let instancePostId: string

  beforeEach(async () => {
    repo = await createSqliteRepository(':memory:')
    const a = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
    alice = a.id
    const webfeed = await repo.createRemoteUser({ handle: 'feed', displayName: 'Feed', feedUrl: 'https://ex.com/feed.xml', feedType: 'webfeed' })
    const instance = await repo.createRemoteUser({ handle: 'peer', displayName: 'Peer', feedUrl: 'https://peer.ex/feed.xml', feedType: 'instance' })

    localPostId = 'local-1'
    webfeedPostId = 'webfeed-1'
    instancePostId = 'instance-1'
    await repo.insertPost({ id: localPostId, authorId: alice, source: 'local', guid: 'g-local', title: null, content: 'local post', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
    await repo.insertPost({ id: webfeedPostId, authorId: webfeed.id, source: 'remote', guid: 'g-webfeed', title: null, content: 'webfeed post', url: null, publishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z' })
    await repo.insertPost({ id: instancePostId, authorId: instance.id, source: 'remote', guid: 'g-instance', title: null, content: 'instance post', url: null, publishedAt: '2026-01-03T00:00:00.000Z', createdAt: '2026-01-03T00:00:00.000Z' })

    // Alice follows both the webfeed and (a pre-migration vestigial follow of) the instance.
    await repo.addFollow(alice, webfeed.id)
    await repo.addFollow(alice, instance.id) // stale instance-follow edge
  })

  it('Local: only the local post', async () => {
    const tl = await repo.getTimeline(10, undefined, { source: 'local' })
    expect(tl.map((e) => e.id)).toEqual([localPostId])
  })

  it('Federated: only the instance post', async () => {
    const tl = await repo.getTimeline(10, undefined, { feedType: 'instance' })
    expect(tl.map((e) => e.id)).toEqual([instancePostId])
  })

  it('Personal river: own + webfeed posts, excluding the instance despite the stale follow', async () => {
    const tl = await repo.getTimeline(10, undefined, { followedBy: alice })
    // webfeed post (01-02) sorts before alice's own local post (01-01)
    expect(tl.map((e) => e.id)).toEqual([webfeedPostId, localPostId])
  })

  it('Public river: all three', async () => {
    const tl = await repo.getTimeline(10, undefined, {})
    expect(tl.map((e) => e.id).sort()).toEqual([instancePostId, localPostId, webfeedPostId].sort())
  })

  it('GET /timeline serves author.feedType; source/feed_type params filter over HTTP', async () => {
    const bus = createEventBus()
    const app = createApp({ service: createService(repo, bus), bus, token: 'secret', auth: makeAuth(repo), users: repo })
    const all = await app.request('/timeline')
    expect(all.status).toBe(200)
    const body = await all.json()
    const feedTypeOf = (id: string) => body.timeline.find((e: { id: string }) => e.id === id).author.feedType
    expect(feedTypeOf(instancePostId)).toBe('instance')
    expect(feedTypeOf(webfeedPostId)).toBe('webfeed')
    expect(feedTypeOf(localPostId)).toBeNull()
    const fed = await (await app.request('/timeline?feed_type=instance')).json()
    expect(fed.timeline.map((e: { id: string }) => e.id)).toEqual([instancePostId])
    const local = await (await app.request('/timeline?source=local')).json()
    expect(local.timeline.map((e: { id: string }) => e.id)).toEqual([localPostId])
  })

  it('getThread entries carry author.feedType (second select site)', async () => {
    const thread = await repo.getThread(webfeedPostId)
    expect(thread[0].author.feedType).toBe('webfeed')
  })
})
