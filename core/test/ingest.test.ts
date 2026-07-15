import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { ingestRemoteUser } from '../src/domain/ingest.ts'

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
  expect(seen).toHaveBeenCalledTimes(1)

  const n2 = await ingestRemoteUser(repo, bus, user, fakeFetch(RSS, 'application/rss+xml'))
  expect(n2).toBe(0) // dedup by guid
  expect(seen).toHaveBeenCalledTimes(1)

  const tl = await repo.getTimeline(10)
  expect(tl[0].source).toBe('remote')
  expect(tl[0].author.handle).toBe('news')
  expect(tl[0].content).toContain('Hello')
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
})
