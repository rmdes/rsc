import { test, expect } from 'vitest'
import { parseFeedWithMeta } from '../src/domain/ingest.ts'
import { discoverFeed } from '../src/domain/discovery.ts'
import { renderRssFeed, renderCommentsFeed, injectSourceComments } from '../src/domain/feed.ts'
import type { User, Post, TimelineEntry } from '../src/domain/types.ts'

const RSS_NS = 'xmlns:source="http://source.scripting.com/" xmlns:thr="http://purl.org/syndication/thread/1.0"'

test('RSS in: source:inReplyTo preferred, thr fallback', async () => {
  const both = `<?xml version="1.0"?><rss version="2.0" ${RSS_NS}><channel><title>t</title>
    <item><guid>g1</guid><description>d</description><source:inReplyTo>https://a.ex/1</source:inReplyTo><thr:in-reply-to ref="WRONG"/></item>
    <item><guid>g2</guid><description>d</description><thr:in-reply-to ref="https://a.ex/2" href="https://a.ex/2"/></item>
    <item><guid>g3</guid><description>d</description></item>
  </channel></rss>`
  const { items } = await parseFeedWithMeta(both)
  expect(items.map((i) => i.inReplyTo)).toEqual(['https://a.ex/1', 'https://a.ex/2', null])
})

test('Atom in: thr:in-reply-to ref', async () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:thr="http://purl.org/syndication/thread/1.0"><title>t</title>
    <entry><id>e1</id><title>re</title><content>c</content><updated>2026-01-01T00:00:00Z</updated><thr:in-reply-to ref="https://a.ex/1"/></entry></feed>`
  const { items } = await parseFeedWithMeta(atom)
  expect(items[0].inReplyTo).toBe('https://a.ex/1')
})

test('mf2 in: u-in-reply-to as string and as array', () => {
  const single = `<div class="h-entry"><a class="u-in-reply-to" href="https://a.ex/1">re</a><p class="e-content">agree</p></div>`
  const multi = `<div class="h-entry"><a class="u-in-reply-to" href="https://a.ex/1">re</a><a class="u-in-reply-to" href="https://a.ex/2">re2</a><p class="e-content">agree</p></div>`
  expect(discoverFeed(single, 'https://b.ex/').hentries[0].inReplyTo).toBe('https://a.ex/1')
  expect(discoverFeed(multi, 'https://b.ex/').hentries[0].inReplyTo).toBe('https://a.ex/1')
})

const user: User = { id: 'u1', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
const remoteAuthor: User = { id: 'u2', kind: 'remote', handle: 'bob', displayName: 'Bob', feedUrl: 'https://bob.example/rss.xml', createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
const entry = (over: Partial<Post>, author: User = user): TimelineEntry => ({ id: 'p1', authorId: author.id, source: 'local', guid: 'guid-1', title: null, content: 'c', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over, author })
const post = (over: Partial<Post>): Post => ({ id: 'p1', authorId: 'u1', source: 'local', guid: 'guid-1', title: null, content: 'c', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over })
const ctx = { publicUrl: 'https://cast.example', hubUrl: null, rssCloud: false }

test('RSS out: reply items dual-emit; bare-guid ref carries isPermaLink=false; non-replies emit neither', () => {
  const xml = renderRssFeed(user, [post({ inReplyTo: 'https://a.ex/1' }), post({ id: 'p2', guid: 'guid-2', inReplyTo: 'bare-guid-ref' }), post({ id: 'p3', guid: 'guid-3' })], ctx)
  expect(xml).toContain('<source:inReplyTo>https://a.ex/1</source:inReplyTo>')
  expect(xml).toContain('<thr:in-reply-to ref="https://a.ex/1" href="https://a.ex/1"/>')
  expect(xml).toContain('<source:inReplyTo isPermaLink="false">bare-guid-ref</source:inReplyTo>')
  expect(xml).toContain('<thr:in-reply-to ref="bare-guid-ref"/>') // ref only — no href for a non-URL ref
  expect(xml.match(/source:inReplyTo/g)!.length).toBe(4) // 2 open + 2 close tags — p3 emits none
})

test('injectSourceComments: lands inside the RIGHT item, declares xmlns:source when absent', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel><title>t</title><link>x</link><description>d</description>
    <item><title>one</title><guid isPermaLink="false">g-one</guid></item>
    <item><title>two</title><guid isPermaLink="false">g-two</guid></item>
  </channel>
</rss>`
  const out = injectSourceComments(xml, [{ guid: 'g-two', count: 3, feedUrl: 'https://cast.example/post/p2/comments.xml' }])
  expect(out).toContain('xmlns:source="http://source.scripting.com/"')
  const itemTwo = out.slice(out.indexOf('g-two'))
  expect(itemTwo).toContain('<source:comments count="3" feedUrl="https://cast.example/post/p2/comments.xml"/>')
  expect(out.slice(0, out.indexOf('g-two'))).not.toContain('source:comments') // not in item one
  expect(injectSourceComments(xml, [])).toBe(xml) // no ads → untouched
})

test('injectSourceComments matches CDATA-wrapped guids (feedsmith wraps & < >)', () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel><title>t</title>
    <item><guid isPermaLink="false">
  <![CDATA[https://ex.com/?a=1&b=2]]>
  </guid></item>
  </channel>
</rss>`
  const out = injectSourceComments(xml, [{ guid: 'https://ex.com/?a=1&b=2', count: 1, feedUrl: 'https://cast.example/post/x/comments.xml' }])
  expect(out).toContain('<source:comments count="1"')
})

test('renderCommentsFeed: one item per reply, each with its own inReplyTo elements', () => {
  const parent = post({ id: 'root', guid: 'root-guid', title: 'Root', content: 'root body' })
  const replies = [
    entry({ id: 'c1', guid: 'c1-guid', content: 'first reply', inReplyTo: 'root-guid', publishedAt: '2026-01-02T00:00:00.000Z' }),
    entry({ id: 'c2', guid: 'c2-guid', content: 'second reply', inReplyTo: 'root-guid', publishedAt: '2026-01-03T00:00:00.000Z' }),
  ]
  const xml = renderCommentsFeed(parent, replies, ctx)
  expect(xml).toContain('Comments on')
  expect(xml.match(/<item>/g)!.length).toBe(2)
  expect(xml).toContain('first reply')
  expect(xml.match(/<source:inReplyTo isPermaLink="false">root-guid<\/source:inReplyTo>/g)!.length).toBe(2)
})

// Dave issue #14: the fixed threadwalker reads the author from each reply's core
// <source> (walkComments passes no channel default, so a reply with none walks
// as "?"). Every reply in a comments feed must carry it.
test('renderCommentsFeed: each reply carries core <source> naming its author', () => {
  const parent = post({ id: 'root', guid: 'root-guid', title: 'Root', content: 'root body' })
  const replies = [
    entry({ id: 'c1', guid: 'c1-guid', content: 'local reply', inReplyTo: 'root-guid' }), // Alice, local
    entry({ id: 'c2', guid: 'c2-guid', source: 'remote', content: 'remote reply', inReplyTo: 'root-guid' }, remoteAuthor),
  ]
  const xml = renderCommentsFeed(parent, replies, ctx)
  expect(xml).toContain('<source url="https://cast.example/users/alice/feed.xml">Alice</source>') // local -> our feed url
  expect(xml).toContain('<source url="https://bob.example/rss.xml">Bob</source>') // remote -> origin feed url
})
