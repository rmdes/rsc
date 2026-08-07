import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createApp } from '../src/api/app.ts'
import { renderRssFeed } from '../src/domain/feed.ts'
import { createLocalPost } from '../src/logical/local.ts'
import type { Post, User } from '../src/domain/types.ts'
import type { FeedContext } from '../src/domain/feed.ts'
import { makeAuth } from './auth-helper.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-23T00:00:00.000Z'
const PUB = 'https://rsc.test'
const CTX: FeedContext = { publicUrl: PUB, hubUrl: null, rssCloud: false }

// A v2 app over an in-memory repo, wired exactly like server.ts (publicUrl into
// BOTH createService and the feed context), so createLocalPostAs runs the atomic
// logical-v2 command with publicUrl available.
async function v2app(publicUrl: string | null) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, publicUrl, store)
  const acquisition = createAcquisition({ db, fetchFn: (async () => new Response('', { status: 200 })) as unknown as typeof fetch, lookupFn: async () => [{ address: '93.184.216.34' }], now: () => NOW })
  const app = createApp({
    service, bus, token: 'ops', auth: makeAuth(repo), users: repo, adminEmails: new Set(),
    feeds: { publicUrl, hubUrl: null, rssCloud: false },
    sources: { service: createSourceService(repo, null), repo }, logical: { store, acquisition, now: () => NOW },
  })
  return { repo: repo as typeof repo & { raw: Raw }, bus, service, store, db, app }
}

const guidOf = (xml: string): string => (xml.match(/<guid[^>]*>([^<]*)<\/guid>/)?.[1]) ?? '(no guid)'

test('cutover identity: a v1-created post renders a byte-identical <guid> under v1 and v2 rendering', async () => {
  const { repo, app } = await v2app(PUB)
  // A v1-shaped local post: stored url ABSOLUTE, guid a UUID (v1's create).
  const id = 'p-cut'
  const guid = '11111111-1111-1111-1111-111111111111'
  const url = `${PUB}/post/${id}`
  repo.raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES ('u1','local','alice','Alice',NULL,?)`).run(NOW)
  repo.raw.prepare(`INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url, content_markdown, edited_at, reply_context_author, reply_context_snippet) VALUES (?, 'u1','local',?,NULL,'BODY',?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`).run(id, guid, url, NOW, NOW)

  const user: User = { id: 'u1', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: NOW, authUserId: null }
  const post: Post = { id, authorId: 'u1', source: 'local', guid, title: null, content: 'BODY', url, publishedAt: NOW, createdAt: NOW, inReplyTo: null, inReplyToPostId: null, threadRootId: null, contentMarkdown: null, editedAt: null }
  const v1guid = guidOf(renderRssFeed(user, [post], CTX))
  const v2guid = guidOf(await (await app.request('/users/alice/feed.xml')).text())

  expect(v1guid).toBe(url) // rss.chat permalink-guid: the absolute url IS the guid
  expect(v2guid).toBe(v1guid) // byte-identical across the flip
})

test('v2 local reply to a LOCAL parent emits a resolvable source:inReplyTo and its own absolute guid/link', async () => {
  const { service, app } = await v2app(PUB)
  const root = await service.createLocalPostAs('alice', 'Alice', 'ROOTBODY')
  const reply = await service.createLocalPostAs('bob', 'Bob', 'REPLYBODY', root as unknown as Post)

  const xml = await (await app.request('/users/bob/feed.xml')).text()
  expect(xml).toContain(`<source:inReplyTo>${PUB}/post/${root.id}</source:inReplyTo>`)
  expect(xml).toContain('<thr:in-reply-to')
  expect(xml).not.toContain('isPermaLink') // both refs are absolute URLs
  expect(xml).toContain(`<guid>${PUB}/post/${reply.id}</guid>`)
  expect(xml).toContain(`<link>${PUB}/post/${reply.id}</link>`)
})

test('v2 local reply to a REMOTE parent emits the remote absolute URL as source:inReplyTo (pass-through)', async () => {
  const { repo, service, db, app } = await v2app(PUB)
  const remoteId = 'rem-1'
  const remoteUrl = 'https://a.example/post/orig'
  // A remote logical item that owns a permalink identity key (as reconcile mints
  // for a permalink-bearing ingested item). createLocalPost derives the parent
  // wire-ref from this key.
  repo.raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'remote', ?, 'none', NULL, NULL, NULL, ?)`).run(remoteId, NOW, NOW)
  repo.raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('permalink', ?, ?)`).run(remoteUrl, remoteId)

  // A bob user for the reply's author + local feed.
  repo.raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES ('u-bob','local','bob','Bob',NULL,?)`).run(NOW)
  const bob = (await service.getUserByHandle('bob'))!
  // Reply directly via the logical create command (the route's reply-target gate
  // needs a full delivery; the create path is what threads the parent ref). The
  // parent is the remote item; createLocalPost reads its permalink identity key.
  db.write((tx) => createLocalPost({ tx, author: bob, content: 'REPLYREMOTE', replyToId: remoteId, now: NOW, publicUrl: PUB }))

  const xml = await (await app.request('/users/bob/feed.xml')).text()
  expect(xml).toContain(`<source:inReplyTo>${remoteUrl}</source:inReplyTo>`)
})

test('v2 local reply to an OPAQUE-ONLY remote parent emits the opaque guid as source:inReplyTo (v1 replyTo.guid parity)', async () => {
  const { repo, service, db, app } = await v2app(PUB)
  const remoteId = 'rem-op'
  const wireGuid = 'opaque-wire-guid-123' // the parent's raw <guid>, no permalink
  // A remote logical item whose ONLY identity key is an opaque publisher-scoped
  // guid (as reconcile mints for a permalink-less ingested item: kind is scoped,
  // key IS the bare wire guid — reconcile.ts:284/322). No permalink key exists.
  repo.raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'remote', ?, 'none', NULL, NULL, NULL, ?)`).run(remoteId, NOW, NOW)
  repo.raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('opaque:publisher:pub-1', ?, ?)`).run(wireGuid, remoteId)

  repo.raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES ('u-bob','local','bob','Bob',NULL,?)`).run(NOW)
  const bob = (await service.getUserByHandle('bob'))!
  db.write((tx) => createLocalPost({ tx, author: bob, content: 'REPLYOPAQUE', replyToId: remoteId, now: NOW, publicUrl: PUB }))

  const xml = await (await app.request('/users/bob/feed.xml')).text()
  // The opaque guid is a non-URL ref ⇒ isPermaLink="false"; byte-matches v1's
  // replyTo.guid fallback, so a peer can reassemble the thread on the parent's guid.
  expect(xml).toContain(`<source:inReplyTo isPermaLink="false">${wireGuid}</source:inReplyTo>`)
})

// REVERSED (interop: replyDoesntPointBack). This fixture has identity keys but no
// delivery, so it pins parentReplyRef's key FALLBACK rung — reached only when the
// parent has no ordinary-eligible delivery left. The old expectation (permalink
// wins) was the bug: an item bearing a <guid> is emitted with that guid (the
// delivery key priority in acquisition.ts), so a reply citing its permalink pointed
// at a string the parent's feed never advertises. Opaque now wins; the permalink is
// used only for a parent that had no <guid>. The delivery-bearing (production) path
// is pinned end-to-end in feed.test.ts.
test('fallback precedence: a delivery-less remote parent with BOTH keys emits the opaque guid (what its origin advertised)', async () => {
  const { repo, service, db, app } = await v2app(PUB)
  const remoteId = 'rem-both'
  const remoteUrl = 'https://a.example/post/orig'
  repo.raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'remote', ?, 'none', NULL, NULL, NULL, ?)`).run(remoteId, NOW, NOW)
  repo.raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('permalink', ?, ?)`).run(remoteUrl, remoteId)
  repo.raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('opaque:publisher:pub-1', 'opaque-wins', ?)`).run(remoteId)

  repo.raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES ('u-bob','local','bob','Bob',NULL,?)`).run(NOW)
  const bob = (await service.getUserByHandle('bob'))!
  db.write((tx) => createLocalPost({ tx, author: bob, content: 'REPLYBOTH', replyToId: remoteId, now: NOW, publicUrl: PUB }))

  const xml = await (await app.request('/users/bob/feed.xml')).text()
  // non-URL ref ⇒ isPermaLink="false", the shape a peer string-matches to the guid.
  expect(xml).toContain(`<source:inReplyTo isPermaLink="false">opaque-wins</source:inReplyTo>`)
  expect(xml).not.toContain(remoteUrl)
})

test('O2 archive: a v1-era reply (absolute in_reply_to) still emits source:inReplyTo after v2 projection', async () => {
  const { repo, app } = await v2app(PUB)
  const parentUrl = `${PUB}/post/root`
  repo.raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES ('u1','local','bob','Bob',NULL,?)`).run(NOW)
  repo.raw.prepare(`INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url, content_markdown, edited_at, reply_context_author, reply_context_snippet) VALUES ('root','u1','local','g-root',NULL,'ROOT',?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`).run(parentUrl, NOW, NOW)
  // v1-era reply: in_reply_to holds the parent's ABSOLUTE url, in_reply_to_post_id set.
  repo.raw.prepare(`INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url, content_markdown, edited_at, reply_context_author, reply_context_snippet) VALUES ('rep','u1','local','g-rep',NULL,'ARCHIVEREPLY',?,?,?,?,'root','root',NULL,NULL,NULL,NULL,NULL,NULL)`).run(`${PUB}/post/rep`, NOW, NOW, parentUrl)

  const xml = await (await app.request('/users/bob/feed.xml')).text()
  expect(xml).toContain(`<source:inReplyTo>${parentUrl}</source:inReplyTo>`)
})

test('no-publicUrl degradation: own guid is a UUID isPermaLink="false" with no link; the reply still threads via the parent guid (v1 parity)', async () => {
  const { service, app } = await v2app(null)
  const root = await service.createLocalPostAs('alice', 'Alice', 'ROOTBODY')
  const reply = await service.createLocalPostAs('bob', 'Bob', 'REPLYBODY', root as unknown as Post)

  const xml = await (await app.request('/users/bob/feed.xml')).text()
  // Own identity degrades to the UUID guid + no <link> (localGuid's null-url branch;
  // the emitted guid is the item's own id, matching what a peer would reference).
  expect(xml).toContain(`<guid isPermaLink="false">${reply.id}</guid>`)
  expect((xml.match(/<link>/g) ?? []).length).toBe(1) // channel link only; the item has none
  // But the reply STILL threads: source:inReplyTo carries the parent's id ref, which
  // equals the parent's own advertised guid — the url-less analogue of v1's parity.
  expect(xml).toContain(`<source:inReplyTo isPermaLink="false">${root.id}</source:inReplyTo>`)
})
