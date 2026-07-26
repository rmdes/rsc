import { test, expect } from 'vitest'
import { parseFeedWithMeta, parseLinkHeader } from '../src/domain/ingest.ts'

// Pure-parser coverage only. Every fetch/insert-driven test in this file went
// with v1's ingestRemoteUser/ingestItems/pollAll (V4 Task 11); the v2
// acquisition engine owns that path and carries its own suites.

test('an item-level <source> (aggregate feeds like rss.chat) carries per-item attribution', async () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>everyone</title>
<item><guid>g1</guid><description>d</description><source url="https://rss.chat/users/dave/rss.xml">Dave Winer</source></item>
<item><guid>g2</guid><description>d</description></item>
<item><guid>g3</guid><description>d</description><source url="javascript:alert(1)">Evil</source></item>
</channel></rss>`
  const { items } = await parseFeedWithMeta(rss)
  expect(items[0].sourceName).toBe('Dave Winer')
  expect(items[0].sourceFeedUrl).toBe('https://rss.chat/users/dave/rss.xml')
  expect(items[1].sourceName).toBeNull()
  expect(items[1].sourceFeedUrl).toBeNull()
  expect(items[2].sourceName).toBe('Evil') // name is inert text
  expect(items[2].sourceFeedUrl).toBeNull() // non-http(s) url never becomes an href
})

test('a non-http(s) item link is dropped from url but still feeds the guid chain raw', async () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>x</title><link>javascript:alert(1)</link><description>d</description></item>
</channel></rss>`
  const { items } = await parseFeedWithMeta(rss)
  expect(items[0].url).toBeNull() // never renders as an <a href>
  expect(items[0].guid).toBe('javascript:alert(1)') // opaque dedup id — unchanged derivation
})

test('fallback guids for (ab,c) and (a,bc) do not collide', async () => {
  const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [
    { title: 'ab', content_text: 'c' },
    { title: 'a', content_text: 'bc' },
  ] })
  const items = (await parseFeedWithMeta(json)).items
  expect(items[0].guid).not.toBe(items[1].guid)
})

test('a BOM-prefixed JSON Feed served as text/plain parses as JSON Feed', async () => {
  const json = '﻿' + JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ id: 'bom1', content_text: 'bom body' }] })
  const items = (await parseFeedWithMeta(json)).items
  expect(items[0].guid).toBe('bom1')
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

test('RSS permalink guid is the item url when <link> is absent (rss.chat shape)', async () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item><guid>https://rss.chat/?id=324</guid><description>no link element</description><pubDate>Fri, 17 Jul 2026 14:43:36 GMT</pubDate></item>
    <item><guid isPermaLink="false">https://rss.chat/?id=325</guid><description>explicitly not a permalink</description></item>
    <item><guid>tag:example,2026:x</guid><description>permalink flag but not http(s)</description></item>
    <item><guid>https://e.example/g</guid><link>https://e.example/real</link><description>link wins over guid</description></item>
  </channel></rss>`
  const { items } = await parseFeedWithMeta(xml)
  expect(items[0].url).toBe('https://rss.chat/?id=324') // guid IS the permalink (RSS 2.0 default)
  expect(items[1].url).toBeNull() // isPermaLink="false" honored
  expect(items[2].url).toBeNull() // http(s)-only guard still applies
  expect(items[3].url).toBe('https://e.example/real') // explicit link always wins
})
