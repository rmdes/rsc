import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { ingestRemoteUser } from '../src/domain/ingest.ts'

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
<item><title>Hello</title><link>https://s.ex/1</link><guid>https://s.ex/1</guid><description>Body</description></item></channel></rss>`

// checkCallbackUrl's default lookupFn does a real DNS lookup; s.ex is a test-only
// domain that doesn't resolve. Every other suite that exercises checkCallbackUrl
// (push-in.test.ts) injects a fake public lookup for the same reason — mirrored here.
const publicLookup = async () => [{ address: '93.184.216.34' }]

// A fetch stub that serves different bodies per URL and records the URLs seen.
function router(routes: Record<string, { body: string; type: string; status?: number }>) {
  const seen: string[] = []
  const fn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    seen.push(u)
    const r = routes[u]
    if (!r) return new Response('not found', { status: 404 })
    return new Response(r.body, { status: r.status ?? 200, headers: { 'content-type': r.type } })
  })
  return { fn: fn as unknown as typeof fetch, seen }
}

test('HTML page → autodiscover feed → ingest + persist the discovered feedUrl', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: 'https://s.ex/page' })
  const html = `<html><head><link rel="alternate" type="application/rss+xml" href="https://s.ex/feed.xml"></head><body><p></p></body></html>`
  const { fn, seen } = router({
    'https://s.ex/page': { body: html, type: 'text/html' },
    'https://s.ex/feed.xml': { body: RSS, type: 'application/rss+xml' },
  })
  const { inserted } = await ingestRemoteUser(repo, bus, user, fn, publicLookup)
  expect(inserted).toBe(1)
  expect((await repo.getUser(user.id))?.feedUrl).toBe('https://s.ex/feed.xml') // persisted
  expect(seen).toEqual(['https://s.ex/page', 'https://s.ex/feed.xml']) // one hop
})

test('collision (R1): discovered feed already held by another user → rewrite skipped, items still ingest', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  await repo.createRemoteUser({ handle: 'direct', displayName: 'Direct', feedUrl: 'https://s.ex/feed.xml' }) // already holds it
  const pageUser = await repo.createRemoteUser({ handle: 'page', displayName: 'Page', feedUrl: 'https://s.ex/page' })
  const html = `<html><head><link rel="alternate" type="application/rss+xml" href="https://s.ex/feed.xml"></head><body><p></p></body></html>`
  const { fn } = router({
    'https://s.ex/page': { body: html, type: 'text/html' },
    'https://s.ex/feed.xml': { body: RSS, type: 'application/rss+xml' },
  })
  const { inserted } = await ingestRemoteUser(repo, bus, pageUser, fn, publicLookup)
  expect(inserted).toBe(1) // items still ingested under page-user
  expect((await repo.getUser(pageUser.id))?.feedUrl).toBe('https://s.ex/page') // NOT rewritten
})

test('h-feed page (no feed link) → ingest h-entries, feedUrl unchanged', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'indie', displayName: 'Indie', feedUrl: 'https://s.ex/home' })
  const html = `<html><body><div class="h-feed"><div class="h-entry"><p class="e-content">a note</p><a class="u-url" href="https://s.ex/n">l</a></div></div></body></html>`
  const { fn, seen } = router({ 'https://s.ex/home': { body: html, type: 'text/html' } })
  const { inserted } = await ingestRemoteUser(repo, bus, user, fn)
  expect(inserted).toBe(1)
  expect((await repo.getUser(user.id))?.feedUrl).toBe('https://s.ex/home') // unchanged
  expect(seen).toEqual(['https://s.ex/home']) // no second fetch
})

test('neither feed link nor h-entries → still fails (throws), bounded by pollAll', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 'x', displayName: 'X', feedUrl: 'https://s.ex/blank' })
  const { fn } = router({ 'https://s.ex/blank': { body: '<html><body><p>nothing</p></body></html>', type: 'text/html' } })
  await expect(ingestRemoteUser(repo, bus, user, fn)).rejects.toThrow()
})

test('SSRF-rejected discovered URL → no second fetch, ladder falls through (P2, spec §7)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const user = await repo.createRemoteUser({ handle: 's', displayName: 'S', feedUrl: 'https://s.ex/page' })
  // The discovered link points at a loopback IP literal — checkCallbackUrl rejects
  // it synchronously (no DNS), so the feed is never fetched and the ladder falls
  // through to h-feed (none here) → throw. `seen` proves no second fetch happened.
  const html = `<html><head><link rel="alternate" type="application/rss+xml" href="http://127.0.0.1/feed"></head><body><p>x</p></body></html>`
  const { fn, seen } = router({ 'https://s.ex/page': { body: html, type: 'text/html' } })
  await expect(ingestRemoteUser(repo, bus, user, fn)).rejects.toThrow()
  expect(seen).toEqual(['https://s.ex/page']) // the 127.0.0.1 feed was never fetched
})
