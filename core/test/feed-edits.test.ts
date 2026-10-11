import { it, expect } from 'vitest'
import { renderRssFeed, renderFirehoseRss, renderJsonFeed } from '../src/domain/feed.ts'
import { dto } from './dto-helper.ts'

const user = { handle: 'alice', displayName: 'Alice' }
const post = (over: Parameters<typeof dto>[0] = {}) => dto({ content: 'hi', ...over })
const ctx = { publicUrl: 'https://ex.test', hubUrl: null, rssCloud: false }

it('edited post emits <atom:updated> in the personal RSS feed', () => {
  const xml = renderRssFeed(user, [post({ updatedAt: '2026-02-02T00:00:00.000Z' })], ctx)
  expect(xml).toContain('<atom:updated>2026-02-02T00:00:00.000Z</atom:updated>')
  expect(xml).toMatch(/<rss[^>]*xmlns:atom=/)
})

it('never-edited post omits atom:updated', () => {
  expect(renderRssFeed(user, [post()], ctx)).not.toContain('<atom:updated>')
})

it('firehose emits atom:updated; JSON feed emits date_modified', () => {
  expect(renderFirehoseRss([post({ updatedAt: '2026-02-02T00:00:00.000Z' })], ctx)).toContain('<atom:updated>2026-02-02T00:00:00.000Z</atom:updated>')
  expect(renderJsonFeed(user, [post({ updatedAt: '2026-02-02T00:00:00.000Z' })], ctx)).toContain('"date_modified"')
})

it('edited post is well-formed (atom ns declared) even with no publicUrl', () => {
  const xml = renderRssFeed(user, [post({ updatedAt: '2026-02-02T00:00:00.000Z' })], { publicUrl: null, hubUrl: null, rssCloud: false })
  expect(xml).toContain('<atom:updated>')
  expect(xml).toMatch(/<rss[^>]*xmlns:atom=/) // must be declared or the doc is malformed
})
