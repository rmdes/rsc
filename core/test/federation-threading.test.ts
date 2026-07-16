import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { ingestRemoteUser } from '../src/domain/ingest.ts'

// The primary feedUrl fetch is SSRF-guarded (checkCallbackUrl); default real DNS
// won't resolve the fake .example/.ex test hosts used across this bridge, so
// inject a fake public-IP lookup (mirrors federation.test.ts / ingest.test.ts).
const publicLookup = async () => [{ address: '93.184.216.34' }]

async function instance(publicUrl: string) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', feeds: { publicUrl, hubUrl: null, rssCloud: false } })
  // fetchFn that serves this instance's own routes for its public origin
  const serve = (base: string) => async (url: string | URL | Request) => {
    const u = new URL(String(url))
    return app.request(u.pathname + u.search)
  }
  return { repo, bus, service, app, serve }
}
const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }

test('MONEY TEST: a conversation federates over plain RSS, round trip, threadwalker-walkable', async () => {
  const A = await instance('https://a.example')
  const B = await instance('https://b.example')

  // A: alice posts
  const orig = await (await A.app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'alice', content: 'hello from A' }) })).json()

  // B follows alice's feed and ingests the post
  const aliceOnB = await B.repo.createRemoteUser({ handle: 'alice-a', displayName: 'Alice', feedUrl: 'https://a.example/users/alice/feed.xml' })
  await ingestRemoteUser(B.repo, B.bus, aliceOnB, A.serve('https://a.example') as unknown as typeof fetch, publicLookup)
  const ingested = (await B.repo.getTimeline(10)).find((e) => e.content === 'hello from A')!

  // B: bob replies via the reply button (target = the ingested copy)
  await B.app.request('/posts', { method: 'POST', headers: auth, body: JSON.stringify({ handle: 'bob', content: 'reply from B', inReplyTo: ingested.id }) })

  // B's feed carries both reply forms
  const bobFeed = await (await B.app.request('/users/bob/feed.xml')).text()
  expect(bobFeed).toContain(`<source:inReplyTo isPermaLink="false">${orig.post.guid}</source:inReplyTo>`) // local posts have no url → guid ref
  expect(bobFeed).toContain('<thr:in-reply-to')

  // A ingests bob's feed → the reply resolves to alice's original by guid
  const bobOnA = await A.repo.createRemoteUser({ handle: 'bob-b', displayName: 'Bob', feedUrl: 'https://b.example/users/bob/feed.xml' })
  await ingestRemoteUser(A.repo, A.bus, bobOnA, B.serve('https://b.example') as unknown as typeof fetch, publicLookup)

  const thread = await (await A.app.request(`/post/${orig.post.id}/thread`)).json()
  expect(thread.thread.map((e: { content: string }) => e.content)).toEqual(['hello from A', 'reply from B'])

  // Winer-native pull side: A's feed advertises the conversation…
  const aliceFeed = await (await A.app.request('/users/alice/feed.xml')).text()
  expect(aliceFeed).toContain(`<source:comments count="1" feedUrl="https://a.example/post/${orig.post.id}/comments.xml"/>`)
  // …and the advertised comments feed serves the reply (threadwalker-walkable)
  const comments = await (await A.app.request(`/post/${orig.post.id}/comments.xml`)).text()
  expect(comments).toContain('reply from B')
})

test('mf2 sibling: an h-entry reply with u-in-reply-to threads on ingest', async () => {
  const A = await instance('https://a.example')
  const orig = await A.repo.createRemoteUser({ handle: 'orig', displayName: 'O', feedUrl: 'https://o.ex/feed.xml' })
  await A.repo.insertPost({ id: 'op', authorId: orig.id, source: 'remote', guid: 'op-guid', title: null, content: 'original', url: 'https://o.ex/1', publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const indie = await A.repo.createRemoteUser({ handle: 'indie', displayName: 'I', feedUrl: 'https://indie.ex/' })
  const html = `<html><body><div class="h-feed"><div class="h-entry"><a class="u-in-reply-to" href="https://o.ex/1">re</a><p class="e-content">indie reply</p><a class="u-url" href="https://indie.ex/n1">l</a></div></div></body></html>`
  const fetchFn = (async () => new Response(html, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
  await ingestRemoteUser(A.repo, A.bus, indie, fetchFn, publicLookup)
  const thread = await (await A.app.request('/post/op/thread')).json()
  expect(thread.thread.map((e: { content: string }) => e.content)).toEqual(['original', 'indie reply'])
})
