import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { ingestRemoteUser, pollAll, parseFeedWithMeta, parseLinkHeader, ingestItems } from '../src/domain/ingest.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

// The primary feedUrl fetch is now SSRF-guarded (checkCallbackUrl) on every call.
// Default lookupFn is real DNS, which NXDOMAINs these fake test hosts (ex.com,
// blog.example.com, d.example.com) — inject a fake public-IP lookup so the guard
// passes and each test still exercises what it's actually testing.
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>
<item><title>Hello</title><link>https://ex.com/1</link><guid>https://ex.com/1</guid><description>Body one</description><pubDate>Wed, 01 Jan 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`

function fakeFetch(body: string, contentType: string) {
  return async () => new Response(body, { headers: { 'content-type': contentType } })
}

test('sends a descriptive User-Agent so bot-protected feeds are not blocked', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const spy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(RSS, { headers: { 'content-type': 'application/rss+xml' } }))
  await ingestRemoteUser(repo, bus, user, spy as unknown as typeof fetch, publicLookup)
  const init = spy.mock.calls[0][1]
  const headers = new Headers(init?.headers)
  expect(headers.get('user-agent')).toMatch(/Textcaster/)
  expect(headers.get('accept')).toMatch(/rss|atom|xml|json/i)
})

test('ingests RSS items as remote posts, once (idempotent), and emits new ones', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const seen = vi.fn()
  bus.onNewPost(seen)

  const r1 = await ingestRemoteUser(repo, bus, user, fakeFetch(RSS, 'application/rss+xml'), publicLookup)
  expect(r1.inserted).toBe(1)
  expect(seen).toHaveBeenCalledTimes(0) // first sync for this author is a silent backfill

  const r2 = await ingestRemoteUser(repo, bus, user, fakeFetch(RSS, 'application/rss+xml'), publicLookup)
  expect(r2.inserted).toBe(0) // dedup by (author, guid)
  expect(seen).toHaveBeenCalledTimes(0)

  const tl = await repo.getTimeline(10)
  expect(tl[0].source).toBe('remote')
  expect(tl[0].author.handle).toBe('news')
  expect(tl[0].title).toBe('Hello')
  expect(tl[0].content).toBe('Body one')
})

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom News</title>
  <entry>
    <id>urn:uuid:atom-1</id>
    <link href="https://ex.com/atom-1"/>
    <title>Atom Title</title>
    <content type="html">Atom body</content>
    <updated>2026-01-01T00:00:00Z</updated>
  </entry>
</feed>`

test('parses Atom feed items, taking guid from the Atom id', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'atom', displayName: 'Atom', feedUrl: 'https://ex.com/f.atom' })
  const r = await ingestRemoteUser(repo, bus, user, fakeFetch(ATOM, 'application/atom+xml'), publicLookup)
  expect(r.inserted).toBe(1)
  const tl = await repo.getTimeline(10)
  expect(tl[0].guid).toBe('urn:uuid:atom-1')
  expect(tl[0].title).toBe('Atom Title')
  expect(tl[0].content).toBe('Atom body')
  expect(tl[0].url).toBe('https://ex.com/atom-1')
})

test('parses JSON Feed items too', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'jf', displayName: 'JF', feedUrl: 'https://ex.com/f.json' })
  const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ id: 'a1', url: 'https://ex.com/a1', title: 'JF One', content_text: 'jf body', date_published: '2026-01-01T00:00:00Z' }] })
  const r = await ingestRemoteUser(repo, bus, user, fakeFetch(json, 'application/feed+json'), publicLookup)
  expect(r.inserted).toBe(1)
  const tl = await repo.getTimeline(10)
  expect(tl[0].guid).toBe('a1')
  expect(tl[0].title).toBe('JF One')
  expect(tl[0].content).toBe('jf body')
})

const TWO_ITEM_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>
<item><title>One</title><link>https://ex.com/1</link><guid>https://ex.com/1</guid><description>Body one</description><pubDate>Wed, 01 Jan 2026 00:00:00 GMT</pubDate></item>
<item><title>Two</title><link>https://ex.com/2</link><guid>https://ex.com/2</guid><description>Body two</description><pubDate>Thu, 02 Jan 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`

const THREE_ITEM_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>
<item><title>One</title><link>https://ex.com/1</link><guid>https://ex.com/1</guid><description>Body one</description><pubDate>Wed, 01 Jan 2026 00:00:00 GMT</pubDate></item>
<item><title>Two</title><link>https://ex.com/2</link><guid>https://ex.com/2</guid><description>Body two</description><pubDate>Thu, 02 Jan 2026 00:00:00 GMT</pubDate></item>
<item><title>Three</title><link>https://ex.com/3</link><guid>https://ex.com/3</guid><description>Body three</description><pubDate>Fri, 03 Jan 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`

test('first sync of a feed inserts posts but stays silent on the bus; later syncs emit only new items', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const seen = vi.fn()
  bus.onNewPost(seen)

  const r1 = await ingestRemoteUser(repo, bus, user, fakeFetch(TWO_ITEM_RSS, 'application/rss+xml'), publicLookup)
  expect(r1.inserted).toBe(2)
  expect(seen).toHaveBeenCalledTimes(0)

  const r2 = await ingestRemoteUser(repo, bus, user, fakeFetch(THREE_ITEM_RSS, 'application/rss+xml'), publicLookup)
  expect(r2.inserted).toBe(1)
  expect(seen).toHaveBeenCalledTimes(1)
})

test('an item dated in the future is clamped to now', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const futureRss = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>
<item><title>Future</title><link>https://ex.com/future</link><guid>https://ex.com/future</guid><description>Body</description><pubDate>Wed, 01 Jan 2099 00:00:00 GMT</pubDate></item>
</channel></rss>`
  await ingestRemoteUser(repo, bus, user, fakeFetch(futureRss, 'application/rss+xml'), publicLookup)
  const tl = await repo.getTimeline(10)
  expect(new Date(tl[0].publishedAt).getTime()).toBeLessThanOrEqual(Date.now())
})

test('an item with no guid and no link gets a deterministic fallback guid, so re-ingesting inserts 0 new posts', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'nolink', displayName: 'NoLink', feedUrl: 'https://ex.com/f.xml' })
  const noGuidNoLinkRss = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>
<item><title>Untitled Item</title><description>Body text</description><pubDate>Wed, 01 Jan 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`

  const r1 = await ingestRemoteUser(repo, bus, user, fakeFetch(noGuidNoLinkRss, 'application/rss+xml'), publicLookup)
  expect(r1.inserted).toBe(1)

  const r2 = await ingestRemoteUser(repo, bus, user, fakeFetch(noGuidNoLinkRss, 'application/rss+xml'), publicLookup)
  expect(r2.inserted).toBe(0)
})

test('an item with no guid, no link, and no pubDate is not re-inserted on the next poll', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'nodate', displayName: 'NoDate', feedUrl: 'https://ex.com/f.xml' })
  const noGuidNoLinkNoDateRss = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>
<item><title>Dateless Item</title><description>Body text</description></item>
</channel></rss>`

  // Force the defaulted "now" to differ between the two polls, so a hash that
  // (incorrectly) includes it would produce a different guid each time.
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const r1 = await ingestRemoteUser(repo, bus, user, fakeFetch(noGuidNoLinkNoDateRss, 'application/rss+xml'), publicLookup)
    expect(r1.inserted).toBe(1)

    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'))
    const r2 = await ingestRemoteUser(repo, bus, user, fakeFetch(noGuidNoLinkNoDateRss, 'application/rss+xml'), publicLookup)
    expect(r2.inserted).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('sniffs JSON Feed body even when served with a non-JSON content-type', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'jf2', displayName: 'JF2', feedUrl: 'https://ex.com/f2.json' })
  const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ id: 'b1', url: 'https://ex.com/b1', title: 'Sniffed', content_text: 'sniffed body', date_published: '2026-01-01T00:00:00Z' }] })
  const r = await ingestRemoteUser(repo, bus, user, fakeFetch(json, 'text/plain'), publicLookup)
  expect(r.inserted).toBe(1)
  const tl = await repo.getTimeline(10)
  expect(tl[0].guid).toBe('b1')
  expect(tl[0].title).toBe('Sniffed')
})

test('a malformed item date degrades to "now" instead of killing the whole feed', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'baddate', displayName: 'BadDate', feedUrl: 'https://ex.com/f.json' })
  const json = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    items: [
      { id: 'bad1', url: 'https://ex.com/bad1', title: 'Bad Date', content_text: 'body one', date_published: 'not-a-date' },
      { id: 'good1', url: 'https://ex.com/good1', title: 'Good Date', content_text: 'body two', date_published: '2026-01-01T00:00:00Z' },
    ],
  })
  const r = await ingestRemoteUser(repo, bus, user, fakeFetch(json, 'application/feed+json'), publicLookup)
  expect(r.inserted).toBe(2)
  const tl = await repo.getTimeline(10)
  const bad = tl.find((p) => p.guid === 'bad1')
  expect(bad).toBeDefined()
  expect(Number.isNaN(new Date(bad!.publishedAt).getTime())).toBe(false)
})

function fakeFetchOversized() {
  return async () => new Response(RSS, { headers: { 'content-type': 'application/rss+xml', 'content-length': String(10 * 1024 * 1024) } })
}

test('ingestRemoteUser rejects a feed whose content-length exceeds the size cap', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'huge', displayName: 'Huge', feedUrl: 'https://ex.com/huge.xml' })
  await expect(ingestRemoteUser(repo, bus, user, fakeFetchOversized(), publicLookup)).rejects.toThrow()
})

test('pollAll swallows an oversized feed and leaves the timeline unchanged', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  await repo.createRemoteUser({ handle: 'huge', displayName: 'Huge', feedUrl: 'https://ex.com/huge.xml' })
  await pollAll(repo, bus, fakeFetchOversized())
  const tl = await repo.getTimeline(10)
  expect(tl).toEqual([])
})

test('fallback guids for (ab,c) and (a,bc) do not collide', async () => {
  const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [
    { title: 'ab', content_text: 'c' },
    { title: 'a', content_text: 'bc' },
  ] })
  const items = (await parseFeedWithMeta(json)).items
  expect(items[0].guid).not.toBe(items[1].guid)
})

test('an XML feed mislabeled as JSON still parses as RSS', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'mislabeled', displayName: 'M', feedUrl: 'https://ex.com/f' })
  const r = await ingestRemoteUser(repo, bus, user, fakeFetch(RSS, 'application/json'), publicLookup)
  expect(r.inserted).toBe(1)
})

test('a BOM-prefixed JSON Feed served as text/plain parses as JSON Feed', async () => {
  const json = '﻿' + JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ id: 'bom1', content_text: 'bom body' }] })
  const items = (await parseFeedWithMeta(json)).items
  expect(items[0].guid).toBe('bom1')
})

test('backfill stays silent when the first sync was empty (pin, not a change)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'slowstart', displayName: 'S', feedUrl: 'https://ex.com/f.json' })
  const seen = vi.fn()
  bus.onNewPost(seen)
  const empty = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Slow Start', items: [] })
  expect((await ingestRemoteUser(repo, bus, user, fakeFetch(empty, 'application/feed+json'), publicLookup)).inserted).toBe(0)
  const two = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [
    { id: 's1', content_text: 'one' }, { id: 's2', content_text: 'two' },
  ] })
  expect((await ingestRemoteUser(repo, bus, user, fakeFetch(two, 'application/feed+json'), publicLookup)).inserted).toBe(2)
  expect(seen).toHaveBeenCalledTimes(0) // still backfill: nothing was ever live-visible
})

const RSS_WITH_PUSH = `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>P</title><link>https://blog.example.com</link><description>d</description><atom:link href="https://blog.example.com/feed.xml" rel="self"/><atom:link href="https://hub.example.com/hub" rel="hub"/><cloud domain="blog.example.com" port="5337" path="/rsscloud/pleaseNotify" registerProcedure="" protocol="http-post"/><item><guid>pg1</guid><title>t</title><description>b</description></item></channel></rss>`

test('parseFeedWithMeta yields items AND discovery from one parse (rss)', async () => {
  const { items, discovery } = await parseFeedWithMeta(RSS_WITH_PUSH)
  expect(items.length).toBe(1)
  expect(discovery.hubs).toEqual(['https://hub.example.com/hub'])
  expect(discovery.self).toBe('https://blog.example.com/feed.xml')
  expect(discovery.cloud).toMatchObject({ domain: 'blog.example.com', port: 5337, path: '/rsscloud/pleaseNotify', protocol: 'http-post' })
})

test('parseFeedWithMeta discovery for json and atom; rdf yields none', async () => {
  const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'J', feed_url: 'https://j.example.com/feed.json', hubs: [{ type: 'WebSub', url: 'https://hub.example.com/hub' }], items: [{ id: 'j1', content_text: 'x' }] })
  const j = await parseFeedWithMeta(json)
  expect(j.discovery.hubs).toEqual(['https://hub.example.com/hub'])
  expect(j.discovery.self).toBe('https://j.example.com/feed.json')
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><id>urn:a</id><link rel="self" href="https://a.example.com/atom.xml"/><link rel="hub" href="https://hub.example.com/hub"/><entry><id>a1</id><title>e</title></entry></feed>`
  const a = await parseFeedWithMeta(atom)
  expect(a.discovery.hubs).toEqual(['https://hub.example.com/hub'])
  expect(a.discovery.self).toBe('https://a.example.com/atom.xml')
})

test('parseLinkHeader extracts hub and self rels', () => {
  expect(parseLinkHeader('<https://hub.example.com/hub>; rel="hub", <https://blog.example.com/feed.xml>; rel="self"')).toEqual({ hubs: ['https://hub.example.com/hub'], self: 'https://blog.example.com/feed.xml' })
  expect(parseLinkHeader(null)).toEqual({ hubs: [], self: null })
})

test('parseLinkHeader handles rel not-first, commas inside quoted params, and rel= inside the URL', () => {
  // rel is not the first parameter (W3C examples routinely put type first)
  expect(parseLinkHeader('<https://hub.example.com/hub>; type="application/rss+xml"; rel="hub"')).toEqual({ hubs: ['https://hub.example.com/hub'], self: null })
  // a comma inside a quoted param must not split the part
  expect(parseLinkHeader('<https://hub.example.com/hub>; rel="hub"; title="a, b", <https://blog.example.com/f.xml>; rel="self"')).toEqual({ hubs: ['https://hub.example.com/hub'], self: 'https://blog.example.com/f.xml' })
  // rel=hub appearing inside the URL itself is not a rel parameter
  expect(parseLinkHeader('<https://x.example.com/?rel=hub>; rel="alternate"')).toEqual({ hubs: [], self: null })
})

test('ingestRemoteUser returns discovery merging Link headers with body metadata', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'pusher', displayName: 'P', feedUrl: 'https://blog.example.com/feed.xml' })
  const fetchFn = (async () => new Response(RSS_WITH_PUSH, { headers: { 'content-type': 'application/rss+xml', link: '<https://headerhub.example.com/h>; rel="hub"' } })) as unknown as typeof fetch
  const r = await ingestRemoteUser(repo, bus, user, fetchFn, publicLookup)
  expect(r.inserted).toBe(1)
  expect(r.discovery.hubs).toEqual(['https://headerhub.example.com/h', 'https://hub.example.com/hub']) // header first, deduped
  expect(r.discovery.self).toBe('https://blog.example.com/feed.xml')
})

test('ingestItems is the shared insert path (no fetch involved)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'direct', displayName: 'D', feedUrl: 'https://d.example.com/f.xml' })
  await repo.insertPost({ id: 'seed', authorId: user.id, source: 'remote', guid: 'seed-g', title: null, content: 'seed', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }) // author has posts → emits live
  const seen = vi.fn()
  bus.onNewPost(seen)
  const n = await ingestItems(repo, bus, user, [{ guid: 'fp1', title: null, content: 'pushed body', url: null, publishedAt: '2026-01-02T00:00:00.000Z', inReplyTo: null }])
  expect(n).toBe(1)
  expect(seen).toHaveBeenCalledTimes(1)
  expect(await ingestItems(repo, bus, user, [{ guid: 'fp1', title: null, content: 'pushed body', url: null, publishedAt: '2026-01-02T00:00:00.000Z', inReplyTo: null }])).toBe(0)
})
