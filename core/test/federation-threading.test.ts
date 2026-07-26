import { test, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

// The primary feed fetch is SSRF-guarded (checkCallbackUrl) and default real DNS
// won't resolve the fake .example hosts this bridge uses, so inject a fake
// public-IP lookup — same convention as logical-projector/logical-feeds.
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const NOW = '2026-07-23T00:00:00.000Z'

// V1 retirement: this file's other two tests are gone, both fully superseded —
//  - 'url-less local post still threads via UUID guid ref' is
//    logical-outbound-threading.test.ts:144, which pins the same two feed lines
//    on the v2 rendering path.
//  - 'mf2 sibling: an h-entry reply with u-in-reply-to threads on ingest' is
//    logical-projector.test.ts's D4 pair, which drives the REAL v2 h-feed
//    acquisition path (extractHfeed → parseInReplyTo) rather than v1 ingest.

async function instance(publicUrl: string) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  // publicUrl is wired into createService too (not just the feed context): local
  // posts then mint a permalink, matching prod (server.ts:47) and exercising the
  // permalink-guid cross-instance loop instead of the url-less shape.
  const service = createService(repo, bus, publicUrl, store)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo,
    feeds: { publicUrl, hubUrl: null, rssCloud: false },
    sources: { service: createSourceService(repo, publicUrl), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  // A fetchFn that serves this instance's own routes for its public origin.
  const serve = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    return app.request(u.pathname + u.search)
  }) as unknown as typeof fetch
  return { repo, bus, service, app, db, store, serve }
}

type Instance = Awaited<ReturnType<typeof instance>>

// Subscribe `to` to `url` and run the acquisition the way production does:
// acquire → reconcile → orphan adoption (runtime.ts:386's drainSync).
async function acquire(to: Instance, url: string, from: Instance): Promise<void> {
  const sourceId = randomUUID()
  to.repo.raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
  ).run(sourceId, url, NOW)
  const eng = createAcquisition({ db: to.db, fetchFn: from.serve, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource(sourceId, { kind: 'scheduled' }, undefined)
  drainReconciliation({ store: to.store, now: () => NOW })
  for (;;) {
    const claim = to.store.claimOrphanWork(NOW)
    if (!claim) break
    let res
    do { res = to.store.adoptOrphans({ claim, now: NOW, limit: 100 }) } while (res.remaining)
  }
}

async function registeredAs(inst: Instance, email: string, handle: string, displayName: string): Promise<string> {
  const cookie = await registeredSession(inst.app, email, inst.repo)
  await inst.app.request('/me', { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ handle, displayName }) })
  return cookie
}

test('MONEY TEST: a conversation federates over plain RSS, round trip, threadwalker-walkable', async () => {
  const A = await instance('https://a.example')
  const B = await instance('https://b.example')

  // A: alice posts
  const aliceCookie = await registeredAs(A, 'alice@test.example', 'alice', 'Alice')
  const orig = await (await A.app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: aliceCookie }, body: JSON.stringify({ content: 'hello from A' }) })).json()

  // B subscribes to alice's feed and acquires the post
  await acquire(B, 'https://a.example/users/alice/feed.xml', A)
  const ingestedId = (B.repo.raw.prepare(`SELECT id FROM logical_items_v2 WHERE origin = 'remote'`).get() as { id: string }).id

  // B: bob replies via the reply button (target = the ingested logical item —
  // under v2 it has no `posts` row at all, which is what resolveReplyTarget is for)
  const bobCookie = await registeredAs(B, 'bob@test.example', 'bob', 'Bob')
  const reply = await B.app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: bobCookie }, body: JSON.stringify({ content: 'reply from B', inReplyTo: ingestedId }) })
  expect(reply.status).toBe(201)

  // B's feed carries the reply refs: local posts mint a permalink, so the ref is
  // the PARENT'S PERMALINK (orig.post.url) — and being a URL ref it carries no
  // isPermaLink attribute (replyWireElements omits it for URLs).
  const bobFeed = await (await B.app.request('/users/bob/feed.xml')).text()
  expect(bobFeed).toContain(`<source:inReplyTo>${orig.post.url}</source:inReplyTo>`)
  expect(bobFeed).not.toContain('isPermaLink')
  expect(bobFeed).toContain('<thr:in-reply-to')

  // A acquires bob's feed → the reply resolves onto alice's original by
  // permalink (guid === url for url-bearing posts). This is the headline
  // behavior: A→B→A resolves under permalink guids.
  await acquire(A, 'https://b.example/users/bob/feed.xml', B)

  const thread = await (await A.app.request(`/post/${orig.post.id}/thread`)).json()
  const contents = thread.nodes.filter((n: { kind: string }) => n.kind === 'item').map((n: { item: { content: string } }) => n.item.content)
  // orig is A's own local post (raw content); bob's reply arrived via acquiring
  // B's rendered feed (dual contract), so it is stored HTML.
  expect(contents).toEqual(['hello from A', '<p>reply from B</p>'])

  // Winer-native pull side: A's feed advertises the conversation…
  const aliceFeed = await (await A.app.request('/users/alice/feed.xml')).text()
  expect(aliceFeed).toContain(`<source:comments count="1" feedUrl="https://a.example/post/${orig.post.id}/comments.xml"/>`)
  // …and the advertised comments feed serves the reply (threadwalker-walkable)
  const comments = await (await A.app.request(`/post/${orig.post.id}/comments.xml`)).text()
  expect(comments).toContain('reply from B')
  A.repo.close()
  B.repo.close()
})
