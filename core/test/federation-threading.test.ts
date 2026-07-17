import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { ingestRemoteUser } from '../src/domain/ingest.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'

// The primary feedUrl fetch is SSRF-guarded (checkCallbackUrl); default real DNS
// won't resolve the fake .example/.ex test hosts used across this bridge, so
// inject a fake public-IP lookup (mirrors federation.test.ts / ingest.test.ts).
const publicLookup = async () => [{ address: '93.184.216.34' }]

async function instance(publicUrl: string) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  // publicUrl wired into createService too (not just the feed context): local
  // posts then mint a permalink url, matching prod (server.ts) and exercising
  // the milestone's permalink-guid cross-instance loop instead of the legacy
  // url-less shape.
  const service = createService(repo, bus, publicUrl)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, feeds: { publicUrl, hubUrl: null, rssCloud: false } })
  // fetchFn that serves this instance's own routes for its public origin
  const serve = async (url: string | URL | Request) => {
    const u = new URL(String(url))
    return app.request(u.pathname + u.search)
  }
  return { repo, bus, service, app, serve }
}

async function registeredAs(app: Awaited<ReturnType<typeof instance>>['app'], email: string, handle: string, displayName: string, repo: Awaited<ReturnType<typeof instance>>['repo']): Promise<string> {
  const cookie = await registeredSession(app, email, repo)
  await app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ handle, displayName }) })
  return cookie
}

test('MONEY TEST: a conversation federates over plain RSS, round trip, threadwalker-walkable', async () => {
  const A = await instance('https://a.example')
  const B = await instance('https://b.example')

  // A: alice posts
  const aliceCookie = await registeredAs(A.app, 'alice@test.example', 'alice', 'Alice', A.repo)
  const orig = await (await A.app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: aliceCookie }, body: JSON.stringify({ content: 'hello from A' }) })).json()

  // B follows alice's feed and ingests the post
  const aliceOnB = await B.repo.createRemoteUser({ handle: 'alice-a', displayName: 'Alice', feedUrl: 'https://a.example/users/alice/feed.xml' })
  await ingestRemoteUser(B.repo, B.bus, aliceOnB, A.serve as unknown as typeof fetch, publicLookup)
  // A's feed renders local posts as HTML (dual contract) — B ingests that rendered form
  const ingested = (await B.repo.getTimeline(10)).find((e) => e.content === '<p>hello from A</p>')!

  // B: bob replies via the reply button (target = the ingested copy)
  const bobCookie = await registeredAs(B.app, 'bob@test.example', 'bob', 'Bob', B.repo)
  await B.app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: bobCookie }, body: JSON.stringify({ content: 'reply from B', inReplyTo: ingested.id }) })

  // B's feed carries both reply forms
  const bobFeed = await (await B.app.request('/users/bob/feed.xml')).text()
  // MONEY TEST: local posts now mint a permalink, so the reply's ref is the
  // PARENT'S PERMALINK (orig.post.url), not the UUID guid — and being a URL
  // ref, it carries no isPermaLink attribute (replyWireElements omits it for URLs).
  expect(bobFeed).toContain(`<source:inReplyTo>${orig.post.url}</source:inReplyTo>`)
  expect(bobFeed).not.toContain('isPermaLink')
  expect(bobFeed).toContain('<thr:in-reply-to')

  // A ingests bob's feed → the reply resolves to alice's original by permalink
  // (guid === url for url-bearing posts) — this is the headline behavior: A→B→A
  // resolves under permalink guids.
  const bobOnA = await A.repo.createRemoteUser({ handle: 'bob-b', displayName: 'Bob', feedUrl: 'https://b.example/users/bob/feed.xml' })
  await ingestRemoteUser(A.repo, A.bus, bobOnA, B.serve as unknown as typeof fetch, publicLookup)

  const thread = await (await A.app.request(`/post/${orig.post.id}/thread`)).json()
  // orig is A's own local post (raw content); bob's reply arrived via ingesting B's
  // rendered feed (dual contract), so it's stored HTML too.
  expect(thread.thread.map((e: { content: string }) => e.content)).toEqual(['hello from A', '<p>reply from B</p>'])

  // Winer-native pull side: A's feed advertises the conversation…
  const aliceFeed = await (await A.app.request('/users/alice/feed.xml')).text()
  expect(aliceFeed).toContain(`<source:comments count="1" feedUrl="https://a.example/post/${orig.post.id}/comments.xml"/>`)
  // …and the advertised comments feed serves the reply (threadwalker-walkable)
  const comments = await (await A.app.request(`/post/${orig.post.id}/comments.xml`)).text()
  expect(comments).toContain('reply from B')
})

test('url-less local post still threads via UUID guid ref (no publicUrl on the service)', async () => {
  // Pins the pre-permalink fallback shape now that instance() above always
  // wires a publicUrl into createService: a deployment with no publicUrl (or
  // legacy rows without a stored url) must still emit a bare UUID guid ref,
  // isPermaLink="false", and still thread correctly.
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus) // no publicUrl → posts mint url: null
  const app = createApp({ service, bus, token: 'a', auth: makeAuth(repo), users: repo, feeds: { publicUrl: 'https://a.example', hubUrl: null, rssCloud: false } })
  const root = await service.createLocalPostAs('alice', 'Alice', 'root, no permalink')
  await service.createLocalPostAs('bob', 'Bob', 'reply, no permalink', root)

  const bobFeed = await (await app.request('/users/bob/feed.xml')).text()
  expect(bobFeed).toContain(`<source:inReplyTo isPermaLink="false">${root.guid}</source:inReplyTo>`)
  expect(bobFeed).toContain('<thr:in-reply-to')

  const thread = await (await app.request(`/post/${root.id}/thread`)).json()
  expect(thread.thread.map((e: { content: string }) => e.content)).toEqual(['root, no permalink', 'reply, no permalink'])
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
