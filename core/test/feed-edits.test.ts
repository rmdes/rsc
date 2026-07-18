import { it, expect } from 'vitest'
import { renderRssFeed, renderFirehoseRss, renderJsonFeed } from '../src/domain/feed.ts'
import type { Post, User, TimelineEntry } from '../src/domain/types.ts'

const user: User = { id: 'u1', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
function post(over: Partial<Post> = {}): Post {
  return { id: 'p1', authorId: 'u1', source: 'local', guid: 'p1', title: null, content: 'hi', url: null,
    publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', inReplyTo: null,
    inReplyToPostId: null, threadRootId: null, sourceName: null, sourceFeedUrl: null, contentMarkdown: null, editedAt: null, ...over }
}
const ctx = { publicUrl: 'https://ex.test', hubUrl: null, rssCloud: false }

it('edited post emits <atom:updated> in the personal RSS feed', () => {
  const xml = renderRssFeed(user, [post({ editedAt: '2026-02-02T00:00:00.000Z' })], ctx)
  expect(xml).toContain('<atom:updated>2026-02-02T00:00:00.000Z</atom:updated>')
  expect(xml).toMatch(/<rss[^>]*xmlns:atom=/)
})

it('never-edited post omits atom:updated', () => {
  expect(renderRssFeed(user, [post()], ctx)).not.toContain('<atom:updated>')
})

it('firehose emits atom:updated; JSON feed emits date_modified', () => {
  const entry: TimelineEntry = { ...post({ editedAt: '2026-02-02T00:00:00.000Z' }), author: user }
  expect(renderFirehoseRss([entry], ctx)).toContain('<atom:updated>2026-02-02T00:00:00.000Z</atom:updated>')
  expect(renderJsonFeed(user, [post({ editedAt: '2026-02-02T00:00:00.000Z' })], ctx)).toContain('"date_modified"')
})

it('edited post is well-formed (atom ns declared) even with no publicUrl', () => {
  const xml = renderRssFeed(user, [post({ editedAt: '2026-02-02T00:00:00.000Z' })], { publicUrl: null, hubUrl: null, rssCloud: false })
  expect(xml).toContain('<atom:updated>')
  expect(xml).toMatch(/<rss[^>]*xmlns:atom=/) // must be declared or the doc is malformed
})
