import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import type { Repository } from '../src/domain/repository.ts'

// The four timeline tabs: Local (posts.source='local'), Federated
// (users.feed_type='instance'), Personal river (followedBy, instances
// excluded even via a stale follow edge), Public river (no filter).
describe('timeline tabs', () => {
  let repo: Repository
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

  it('Personal river: the webfeed post, excluding the instance despite the stale follow', async () => {
    const tl = await repo.getTimeline(10, undefined, { followedBy: alice })
    expect(tl.map((e) => e.id)).toEqual([webfeedPostId])
  })

  it('Public river: all three', async () => {
    const tl = await repo.getTimeline(10, undefined, {})
    expect(tl.map((e) => e.id).sort()).toEqual([instancePostId, localPostId, webfeedPostId].sort())
  })
})
