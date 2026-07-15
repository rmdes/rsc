import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { ingestRemoteUser, pollAll } from '../src/domain/ingest.ts'

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>
<item><title>Hello</title><link>https://ex.com/1</link><guid>https://ex.com/1</guid><description>Body one</description><pubDate>Wed, 01 Jan 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`

function fakeFetch(body: string, contentType: string) {
  return async () => new Response(body, { headers: { 'content-type': contentType } })
}

test('ingests RSS items as remote posts, once (idempotent), and emits new ones', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const seen = vi.fn()
  bus.onNewPost(seen)

  const n1 = await ingestRemoteUser(repo, bus, user, fakeFetch(RSS, 'application/rss+xml'))
  expect(n1).toBe(1)
  expect(seen).toHaveBeenCalledTimes(0) // first sync for this author is a silent backfill

  const n2 = await ingestRemoteUser(repo, bus, user, fakeFetch(RSS, 'application/rss+xml'))
  expect(n2).toBe(0) // dedup by (author, guid)
  expect(seen).toHaveBeenCalledTimes(0)

  const tl = await repo.getTimeline(10)
  expect(tl[0].source).toBe('remote')
  expect(tl[0].author.handle).toBe('news')
  expect(tl[0].title).toBe('Hello')
  expect(tl[0].content).toBe('Body one')
})

test('parses JSON Feed items too', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'jf', displayName: 'JF', feedUrl: 'https://ex.com/f.json' })
  const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ id: 'a1', url: 'https://ex.com/a1', title: 'JF One', content_text: 'jf body', date_published: '2026-01-01T00:00:00Z' }] })
  const n = await ingestRemoteUser(repo, bus, user, fakeFetch(json, 'application/feed+json'))
  expect(n).toBe(1)
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

  const n1 = await ingestRemoteUser(repo, bus, user, fakeFetch(TWO_ITEM_RSS, 'application/rss+xml'))
  expect(n1).toBe(2)
  expect(seen).toHaveBeenCalledTimes(0)

  const n2 = await ingestRemoteUser(repo, bus, user, fakeFetch(THREE_ITEM_RSS, 'application/rss+xml'))
  expect(n2).toBe(1)
  expect(seen).toHaveBeenCalledTimes(1)
})

test('an item dated in the future is clamped to now', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const futureRss = `<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>
<item><title>Future</title><link>https://ex.com/future</link><guid>https://ex.com/future</guid><description>Body</description><pubDate>Wed, 01 Jan 2099 00:00:00 GMT</pubDate></item>
</channel></rss>`
  await ingestRemoteUser(repo, bus, user, fakeFetch(futureRss, 'application/rss+xml'))
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

  const n1 = await ingestRemoteUser(repo, bus, user, fakeFetch(noGuidNoLinkRss, 'application/rss+xml'))
  expect(n1).toBe(1)

  const n2 = await ingestRemoteUser(repo, bus, user, fakeFetch(noGuidNoLinkRss, 'application/rss+xml'))
  expect(n2).toBe(0)
})

test('sniffs JSON Feed body even when served with a non-JSON content-type', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'jf2', displayName: 'JF2', feedUrl: 'https://ex.com/f2.json' })
  const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ id: 'b1', url: 'https://ex.com/b1', title: 'Sniffed', content_text: 'sniffed body', date_published: '2026-01-01T00:00:00Z' }] })
  const n = await ingestRemoteUser(repo, bus, user, fakeFetch(json, 'text/plain'))
  expect(n).toBe(1)
  const tl = await repo.getTimeline(10)
  expect(tl[0].guid).toBe('b1')
  expect(tl[0].title).toBe('Sniffed')
})

function fakeFetchOversized() {
  return async () => new Response(RSS, { headers: { 'content-type': 'application/rss+xml', 'content-length': String(10 * 1024 * 1024) } })
}

test('ingestRemoteUser rejects a feed whose content-length exceeds the size cap', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'huge', displayName: 'Huge', feedUrl: 'https://ex.com/huge.xml' })
  await expect(ingestRemoteUser(repo, bus, user, fakeFetchOversized())).rejects.toThrow()
})

test('pollAll swallows an oversized feed and leaves the timeline unchanged', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  await repo.createRemoteUser({ handle: 'huge', displayName: 'Huge', feedUrl: 'https://ex.com/huge.xml' })
  await pollAll(repo, bus, fakeFetchOversized())
  const tl = await repo.getTimeline(10)
  expect(tl).toEqual([])
})
