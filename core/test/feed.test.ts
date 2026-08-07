import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createApp } from '../src/api/app.ts'
import { parseFeedWithMeta } from '../src/domain/ingest.ts'
import type { FeedContext } from '../src/domain/feed.ts'
import type { Post } from '../src/domain/types.ts'
import { renderFirehoseRss, injectSourceComments, localGuid } from '../src/domain/feed.ts'
import { generateRssFeed } from 'feedsmith'
import { randomUUID } from 'node:crypto'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { convertToStructuralTombstone } from '../src/logical/threading.ts'
import { projectItem, projectTimeline } from '../src/logical/projector.ts'
import type { ProjectionViewer } from '../src/logical/types.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'
import { makeAuth } from './auth-helper.ts'

const NOW = '2026-07-23T00:00:00.000Z'
const ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }
// checkCallbackUrl runs real DNS and the sandbox has no network, so every
// acquisition resolves through an injected public address (same convention as
// logical-projector/logical-feeds).
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]

// Acquire a remote feed body into an instance the way production does — the v2
// acquisition engine plus reconciliation — replacing v1's deleted ingestItems.
async function acquireFeed(
  ctx: { repo: Awaited<ReturnType<typeof createSqliteRepository>>; db: ReturnType<typeof createDatabaseContext>; store: ReturnType<typeof createLogicalStore> },
  opts: { url: string; xml: string; sourceId?: string },
): Promise<string> {
  const sourceId = opts.sourceId ?? randomUUID()
  const exists = ctx.repo.raw.prepare(`SELECT id FROM remote_sources_v2 WHERE id = ?`).get(sourceId)
  if (!exists) {
    ctx.repo.raw.prepare(
      `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
       VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
    ).run(sourceId, opts.url, NOW)
  }
  const eng = createAcquisition({
    db: ctx.db,
    fetchFn: (async () => new Response(opts.xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } })) as unknown as typeof fetch,
    lookupFn: publicLookup,
    now: () => NOW,
  })
  await eng.acquireSource(sourceId, { kind: 'scheduled' }, undefined)
  // The same two-stage drain runtime.ts:386 runs after an acquisition:
  // reconciliation, then the orphan-adoption worker — a newest-first feed
  // delivers the reply before its parent, so adoption is what threads it.
  drainReconciliation({ store: ctx.store, now: () => NOW })
  for (;;) {
    const claim = ctx.store.claimOrphanWork(NOW)
    if (!claim) break
    let res
    do { res = ctx.store.adoptOrphans({ claim, now: NOW, limit: 100 }) } while (res.remaining)
  }
  return sourceId
}

const CTX: FeedContext = { publicUrl: 'https://cast.example.com', hubUrl: 'https://cast.example.com/hub', rssCloud: true }

async function makeApp(feeds?: FeedContext) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const publicUrl = feeds?.publicUrl ?? null
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, publicUrl, store)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo, feeds,
    sources: { service: createSourceService(repo, publicUrl), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { repo, service, app, db, store }
}

async function seedAlice(service: Awaited<ReturnType<typeof makeApp>>['service']) {
  await service.createLocalPostAs('alice', 'Alice', 'first body')
  await service.createLocalPostAs('alice', 'Alice', 'second body')
}

test('RSS feed round-trips through our own parser (Textcasting profile intact)', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const res = await app.request('/users/alice/feed.xml')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/rss+xml')
  const body = await res.text()
  const items = (await parseFeedWithMeta(body)).items
  expect(items.length).toBe(2)
  expect(items.map((i) => i.content)).toContain('<p>first body</p>') // local post → rendered HTML on the wire (dual contract)
  expect(items[0].title).toBeNull() // local posts are title-less; never synthesized
  expect(items[0].guid).toBeTruthy()
})

test('RSS raw output carries the profile and discovery markers', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const body = await (await app.request('/users/alice/feed.xml')).text()
  expect(body).toMatch(/<guid>https:\/\/cast\.example\.com\/post\/[^<]+<\/guid>/)
  expect(body).toContain('rel="self"')
  expect(body).toContain('rel="hub"')
  expect(body).toContain('<cloud ')
  expect(body).toContain('<description>Posts by Alice</description>')
  expect(body).not.toContain('<title></title>') // no synthesized empty titles
})

test('JSON Feed round-trips and carries version + hub', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const res = await app.request('/users/alice/feed.json')
  expect(res.headers.get('content-type')).toContain('application/feed+json')
  const raw = await res.text()
  expect(raw).toContain('"version": "https://jsonfeed.org/version/1.1"')
  const items = (await parseFeedWithMeta(raw)).items
  expect(items.map((i) => i.content)).toContain('<p>second body</p>') // content_html preferred (our own JSON feeds emit rendered HTML)
})

test('links are omitted without config: no self/hub/cloud when unset', async () => {
  const { service, app } = await makeApp() // defaults: all null/off
  await seedAlice(service)
  const body = await (await app.request('/users/alice/feed.xml')).text()
  expect(body).not.toContain('rel="hub"')
  expect(body).not.toContain('<cloud ')
  const root = await service.createLocalPostAs('alice', 'Alice', 'root')
  const comments = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  expect(comments).not.toContain('<source:self>')
  expect(comments).not.toContain('rel="self"')
})

test('feed description renders breaks, emoji, and highlighted code (unified pipeline)', async () => {
  const { service, app } = await makeApp(CTX)
  const md = 'line one\nline two :rocket:\n\n```js\nconst x = 1\n```'
  await service.createLocalPostAs('alice', 'Alice', md)
  const body = await (await app.request('/users/alice/feed.xml')).text()
  const items = (await parseFeedWithMeta(body)).items
  const description = items[0].content
  const sourceMarkdown = items[0].contentMarkdown
  // description = rendered + sanitized (SEC-4)
  expect(description).toContain('line one<br />')
  expect(description).toContain('🚀')
  expect(description).toContain('<span class="hljs-keyword">const</span>')
  // dual contract: the raw markdown travels verbatim beside it
  expect(sourceMarkdown).toBe(md)
})

test('unknown handle 404s; remote handle 302s to its canonical feed; null-feedUrl remote 404s', async () => {
  const { repo, app } = await makeApp(CTX)
  expect((await app.request('/users/nobody/feed.xml')).status).toBe(404)
  await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://news.example.com/feed.xml' })
  const redir = await app.request('/users/news/feed.xml')
  expect(redir.status).toBe(302)
  expect(redir.headers.get('location')).toBe('https://news.example.com/feed.xml')
})

test('firehose: RSS 2.0 channel + <source> attribution on every item', () => {
  const ctx = { publicUrl: 'https://tc.example', hubUrl: 'https://tc.example/hub', rssCloud: true }
  const alice = { id: 'u1', kind: 'local' as const, handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
  const entries = [{
    id: 'p1', authorId: 'u1', source: 'local' as const, guid: 'guid-1', title: null,
    content: 'hello **world**', url: 'https://tc.example/post/p1',
    publishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z',
    inReplyTo: null, inReplyToPostId: null, threadRootId: null,
    sourceName: null, sourceFeedUrl: null, contentMarkdown: null, author: alice,
  }]
  const xml = renderFirehoseRss(entries, ctx)
  expect(xml).toContain('<title>tc.example: all posts</title>')
  expect(xml).toContain('<link>https://tc.example</link>')
  expect(xml).toContain('Posts from all users on tc.example')
  expect(xml).toContain('<source:self>https://tc.example/users/rss.xml</source:self>')
  expect(xml).toContain('rel="self"')
  expect(xml).toContain('href="https://tc.example/users/rss.xml"')
  expect(xml).toContain('<cloud ')
  expect(xml).toContain('<source url="https://tc.example/users/alice/feed.xml">Alice</source>')
  expect(xml).toContain('<guid>https://tc.example/post/p1</guid>')
  expect(xml).toContain('<link>https://tc.example/post/p1</link>')
  expect(xml).toContain('<source:markdown>')
})

test('injectSourceComments: element lands inside the right item; xmlns declared once', () => {
  const ctx = { publicUrl: 'https://tc.example', hubUrl: null, rssCloud: false }
  const alice = { id: 'u1', kind: 'local' as const, handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
  const entries = [{
    id: 'p1', authorId: 'u1', source: 'local' as const, guid: 'guid-1', title: null,
    content: 'x', url: null, publishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z',
    inReplyTo: null, inReplyToPostId: null, threadRootId: null,
    sourceName: null, sourceFeedUrl: null, contentMarkdown: null, author: alice,
  }]
  let xml = renderFirehoseRss(entries, ctx)
  xml = injectSourceComments(xml, [{ guid: 'guid-1', count: 2, feedUrl: 'https://tc.example/post/p1/comments.xml' }])
  expect(xml).toContain('<source:comments count="2"')
  expect(xml.match(/xmlns:source=/g)?.length).toBe(1)
})

test('xmlns dedup checks the opening tag, not the whole document (body text may mention xmlns:source=)', () => {
  // Use generateRssFeed with a remote post to avoid feedsmith auto-declaring xmlns
  const post: Post = {
    id: 'p1', guid: 'guid-1', title: null,
    content: 'Check out xmlns:source= in the docs', contentMarkdown: null,
    source: 'remote', url: 'https://example.com/post/1',
    publishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z',
    inReplyTo: null, inReplyToPostId: null, threadRootId: null,
    authorId: 'u1',
  }
  // Generate initial feed without xmlns (remote posts don't have sourceNs by default)
  let xml = generateRssFeed(
    {
      title: 'Remote',
      link: 'https://tc.example/users/remote',
      description: 'Remote feed',
      items: [{
        guid: { value: 'guid-1', isPermaLink: false },
        description: post.content,
        pubDate: post.publishedAt,
      }],
    },
    { lenient: true },
  )
  // Verify body text contains the substring but opening tag doesn't have xmlns yet
  expect(xml).toContain('xmlns:source=') // body text mention
  expect(xml.slice(xml.indexOf('<rss'), xml.indexOf('>', xml.indexOf('<rss')) + 1)).not.toContain('xmlns:source="http://source') // opening tag
  // Inject source comments; the check must scope to opening tag only, not whole doc
  xml = injectSourceComments(xml, [{ guid: 'guid-1', count: 3, feedUrl: 'https://tc.example/post/guid-1/comments.xml' }])
  // After injection, opening <rss> tag MUST have the xmlns declaration
  const rssOpenTag = xml.slice(xml.indexOf('<rss'), xml.indexOf('>', xml.indexOf('<rss')) + 1)
  expect(rssOpenTag).toContain('xmlns:source="http://source.scripting.com/"')
  // And source:comments must be present
  expect(xml).toContain('<source:comments count="3"')
})

// The firehose route needs posts with minted permalink urls, so these two
// tests build the app with createService's publicUrl arg set — makeApp()
// above intentionally omits it (existing tests assert on url-less output).
async function makeFirehoseApp() {
  return makeApp(CTX)
}

test('GET /users/rss.xml serves the firehose; a user literally named rss keeps their feed', async () => {
  const { service, app } = await makeFirehoseApp()
  await seedAlice(service)
  const res = await app.request('/users/rss.xml')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/rss+xml')
  const xml = await res.text()
  expect(xml).toContain(': all posts</title>')
  expect(xml).toContain('<source url=') // per-item attribution is RSS core <source> (Dave issue #14)
  expect(xml).not.toContain('<source:account') // item-level source:account is gone (channel-level per spec)
  // non-collision: a local user named "rss" still resolves per-user
  await service.createLocalPostAs('rss', 'Rss The User', 'a post by the user named rss')
  const perUser = await app.request('/users/rss/feed.xml')
  expect(perUser.status).toBe(200)
  expect(await perUser.text()).not.toContain(': all posts</title>')
})

// The dogfood loop, re-pointed onto the v2 acquisition engine (v1's ingestItems
// is gone). Attribution/presentation selection itself is unit-pinned in
// logical-presentation/logical-projector; what only THIS test can prove is that
// our own firehose output is consumable by our own acquisition path — same
// permalink guids, same source:inReplyTo, same dedup.
test('ROUND TRIP: our own v2 acquisition consumes our own firehose, threading and deduping', async () => {
  const { service, app } = await makeFirehoseApp()
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  await service.createLocalPostAs('bob', 'Bob', 'reply text', root)
  const xml = await (await app.request('/users/rss.xml')).text()

  // A peer instance acquires that firehose as an ordinary remote source.
  const peerRepo = await createSqliteRepository(':memory:')
  const peerDb = createDatabaseContext(peerRepo.raw)
  const peer = { repo: peerRepo, db: peerDb, store: createLogicalStore(peerDb) }
  const FIREHOSE = 'https://tc.example/users/rss.xml'
  const sourceId = await acquireFeed(peer, { url: FIREHOSE, xml })

  const river = () => peerDb.read((tx) => projectTimeline(tx, { lens: { kind: 'public' }, before: null, limit: 50, viewer: ANON })).timeline
  const all = () => (peerRepo.raw.prepare(`SELECT id FROM logical_items_v2 WHERE origin = 'remote'`).all() as { id: string }[])
    .map((r) => peerDb.read((tx) => projectItem(tx, r.id, ANON))!)
  expect(all()).toHaveLength(2)
  expect(river().map((d) => d.content)).toContain('<p>root post text</p>') // the root enters the river

  const rootItem = all().find((d) => d.content?.includes('root post text'))!
  const replyItem = all().find((d) => d.content?.includes('reply text'))!
  // threading: the reply resolved against the root's permalink, which is exactly
  // what the firehose emitted as this item's <guid> and its <source:inReplyTo>.
  expect(replyItem.parentResolutionState).toBe('resolved')
  expect(replyItem.parentLogicalItemId).toBe(rootItem.id)
  expect(replyItem.threadRootId).toBe(rootItem.id)
  expect(rootItem.permalink).toBe(root.url)

  // idempotent re-acquisition: the same permalink-keyed items add no new item.
  await acquireFeed(peer, { url: FIREHOSE, xml, sourceId })
  expect(all()).toHaveLength(2)
  peerRepo.close()
})

test('localGuid: url-bearing post → bare permalink guid, no isPermaLink key', () => {
  const p = { url: 'https://cast.example.com/post/abc', guid: 'uuid-abc', source: 'local' } as any
  expect(localGuid(p)).toEqual({ value: 'https://cast.example.com/post/abc' })
  expect('isPermaLink' in localGuid(p)).toBe(false)
})

test('localGuid: url-less post → UUID guid with isPermaLink false (unchanged)', () => {
  const p = { url: null, guid: 'uuid-xyz', source: 'local' } as any
  expect(localGuid(p)).toEqual({ value: 'uuid-xyz', isPermaLink: false })
})

test('per-user feed emits the permalink as a bare guid (threadwalker string-compare key)', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const body = await (await app.request('/users/alice/feed.xml')).text()
  // url-bearing local posts now emit <guid>URL</guid> with NO attribute
  expect(body).toMatch(/<guid>https:\/\/cast\.example\.com\/post\/[^<]+<\/guid>/)
  expect(body).not.toContain('isPermaLink') // no url-less local posts in this fixture
})

test('firehose emits bare permalink guids and still injects source:comments (keyed on emitted guid)', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const root = (await service.getRecentLocalPosts(10)).find((p) => p.content === 'first body')!
  await service.createLocalPostAs('bob', 'Bob', 'a reply', root)
  const body = await (await app.request('/users/rss.xml')).text()
  expect(body).toMatch(/<guid>https:\/\/cast\.example\.com\/post\/[^<]+<\/guid>/)
  // injection landed on the url-bearing parent → keyed on the EMITTED (URL) guid, not the UUID
  expect(body).toContain(`<source:comments count="1" feedUrl="https://cast.example.com/post/${root.id}/comments.xml"/>`)
})

test('JSON feed id equals the emitted permalink for url-bearing posts', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const body = await (await app.request('/users/alice/feed.json')).json()
  for (const item of body.items) expect(item.id).toMatch(/^https:\/\/cast\.example\.com\/post\//)
})

test('remote post keeps its origin guid verbatim (never localGuid-derived)', () => {
  const p = { url: 'https://elsewhere.example/p/1', guid: 'origin-guid-1', source: 'remote' } as any
  // localGuid is only applied to source==='local'; a remote post serialized via
  // the pass-through path keeps guid='origin-guid-1'. Pin at the helper boundary:
  expect(p.source).toBe('remote') // guard: the render paths below must not call localGuid for remotes
})

test('per-user feed names the author via the channel, not per-item source:account', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const body = await (await app.request('/users/alice/feed.xml')).text()
  // A personal feed is single-author: the channel <title> says whose feed it is,
  // which is where Dave's fixed threadwalker takes the author for a single-author
  // starting feed. No item-level source:account (spec: it's channel-level).
  expect(body).toContain('<title>Alice</title>')
  expect(body).not.toContain('<source:account')
})

test('comments feed carries per-reply core <source> (multi-author, threadwalker names)', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const root = (await service.getRecentLocalPosts(10)).find((p) => p.content === 'first body')!
  await service.createLocalPostAs('bob', 'Bob', 'bob replies', root)
  await service.createLocalPostAs('carol', 'Carol', 'carol replies', root)
  const body = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  expect(body).toContain('<source url="https://cast.example.com/users/bob/feed.xml">Bob</source>')
  expect(body).toContain('<source url="https://cast.example.com/users/carol/feed.xml">Carol</source>')
})

test('comments feed: a remote cross-instance reply keeps its origin guid and still names its publisher', async () => {
  const ctx = await makeApp(CTX)
  const { service, app } = ctx
  // Local root with a minted permalink (createLocalPostAs under CTX.publicUrl).
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  // Acquire a remote reply the real way (v2 acquisition + reconciliation, the
  // shared path pushes and polls both use) — source:inReplyTo targets the root's
  // permalink so threading resolves it onto the local post, exactly like a real
  // cross-instance reply. The reply carries its own (non-local) permalink AND an
  // opaque wire guid: that is what makes the test bite, since the comments feed
  // must emit the ORIGIN guid verbatim, never a localGuid-derived one.
  const DAN_FEED = 'https://elsewhere.example/users/dan/feed.xml'
  await acquireFeed(ctx, {
    url: DAN_FEED,
    xml: `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>Dan</title>`
      + `<item><guid isPermaLink="false">origin-guid-77</guid><link>https://elsewhere.example/notes/77</link>`
      + `<description>a remote reply</description><source:inReplyTo>${root.url}</source:inReplyTo></item>`
      + `</channel></rss>`,
  })

  const body = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  expect(body).toContain('a remote reply') // sanity: the reply really resolved onto the local root
  // author named via core <source>, even though the reply is remote — the url is
  // the publisher's origin feed, the name its channel title (never ours).
  expect(body).toContain(`<source url="${DAN_FEED}">Dan</source>`)
  // origin guid kept verbatim — never swapped for the reply's own url or the local permalink form
  expect(body).toMatch(/<guid isPermaLink="false">origin-guid-77<\/guid>/)
  expect(body).not.toContain('<guid>https://elsewhere.example/notes/77</guid>') // not localGuid-derived
  expect(body).not.toContain(`<guid>${CTX.publicUrl}/post/`) // not swapped for a local permalink either
})

test('comments feed: a relayed remote reply points back at the parent guid', async () => {
  const ctx = await makeApp(CTX)
  const { repo, app } = ctx
  // The parent is REMOTE and has an OPAQUE-only guid — no <link>, so reconcile
  // claims only the opaque identity key (acquisition.ts's `it.link ?? (isPermaLink
  // !== false ? guid.value : null)` leaves normalized.permalink null here). The
  // reply cites that guid verbatim as a bare, non-URL source:inReplyTo (both items
  // ride the SAME acquired source, so the opaque key's publisher scope matches).
  // safeUrl() requires a parseable http(s) URL and rejects a bare opaque string
  // outright (`new URL('origin-guid-92')` throws) — a verbatim
  // `safeUrl(mat.material.inReplyTo)` implementation therefore emits NO
  // source:inReplyTo at all. Only parentReplyRef's own DB re-derivation of the
  // parent's advertised guid (projector.ts) can recover it here, so this fixture
  // bites a verbatim implementation.
  await acquireFeed(ctx, {
    url: 'https://elsewhere.example/users/eve/feed.xml',
    xml: `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>Eve</title>`
      + `<item><guid isPermaLink="false">origin-guid-92</guid><description>eve's post</description></item>`
      + `<item><guid isPermaLink="false">origin-guid-93</guid><link>https://elsewhere.example/notes/93</link>`
      + `<description>divergent ref reply</description><source:inReplyTo>origin-guid-92</source:inReplyTo></item>`
      + `</channel></rss>`,
  })
  const parentId = (repo.raw.prepare(
    `SELECT logical_item_id AS id FROM logical_identity_keys_v2 WHERE kind LIKE 'opaque:%' AND key = 'origin-guid-92'`,
  ).get() as { id: string } | undefined)?.id
  expect(parentId).toBeDefined() // sanity: the parent reconciled and claimed its own opaque guid
  const body = await (await app.request(`/post/${parentId}/comments.xml`)).text()
  expect(body).toContain('divergent ref reply') // sanity: the reply really resolved onto the remote parent
  // isPermaLink="false" / no href: replyWireElements' isUrl branch, since a bare
  // opaque guid is not a URL — feedsmith's non-URL reply-ref shape.
  expect(body).toContain(`<source:inReplyTo isPermaLink="false">origin-guid-92</source:inReplyTo>`)
  expect(body).toContain(`<thr:in-reply-to ref="origin-guid-92"/>`)
})

test('comments feed: a reply to a remote parent points back at the guid that parent is EMITTED with', async () => {
  const ctx = await makeApp(CTX)
  const { service, app } = ctx
  // The ordinary RSS item shape: the remote parent carries BOTH a <guid> and a
  // DISTINCT <link>, so reconcile claims two identity keys for it (permalink AND
  // opaque:publisher:<id>) while the feed advertises only the <guid>. The child
  // cites the parent's permalink — a legitimate divergent ref — so nothing but
  // the parent's own emitted guid can be re-emitted here.
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  await acquireFeed(ctx, {
    url: 'https://elsewhere.example/users/frank/feed.xml',
    xml: `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>Frank</title>`
      + `<item><guid isPermaLink="false">origin-guid-parent</guid><link>https://elsewhere.example/notes/parent</link>`
      + `<description>remote parent body</description><source:inReplyTo>${root.url}</source:inReplyTo></item>`
      + `<item><guid isPermaLink="false">origin-guid-child</guid><link>https://elsewhere.example/notes/child</link>`
      + `<description>remote child body</description><source:inReplyTo>https://elsewhere.example/notes/parent</source:inReplyTo></item>`
      + `</channel></rss>`,
  })

  // Cross-check both ends through the wire, never through a hardcoded guess: the
  // parent's OWN emitted <guid> comes from the root's comments feed; the child's
  // <source:inReplyTo> from the parent's. replyDoesntPointBack is exactly this
  // string compare.
  const rootFeed = await parseFeedWithMeta(await (await app.request(`/post/${root.id}/comments.xml`)).text())
  const parent = rootFeed.items.find((i) => i.content.includes('remote parent body'))
  expect(parent).toBeDefined() // sanity: the remote parent resolved onto the local root

  const parentId = ctx.repo.raw.prepare(
    `SELECT logical_item_id AS id FROM logical_identity_keys_v2 WHERE kind LIKE 'opaque:%' AND key = 'origin-guid-parent'`,
  ).get() as { id: string } | undefined
  const parentFeed = await parseFeedWithMeta(await (await app.request(`/post/${parentId?.id}/comments.xml`)).text())
  const child = parentFeed.items.find((i) => i.content.includes('remote child body'))
  expect(child).toBeDefined() // sanity: the child really resolved onto the remote parent

  expect(child?.inReplyTo).toBe(parent?.guid)

  // parentReplyRef's OTHER caller (local.ts): a LOCAL reply to the same remote
  // parent must point back at the same guid. createLocalPostAs reads only
  // replyTo.id (service.ts resolveReplyTarget's documented contract).
  await service.createLocalPostAs('bob', 'Bob', 'local reply body', { id: parentId?.id } as Post)
  const bobFeed = await parseFeedWithMeta(await (await app.request('/users/bob/feed.xml')).text())
  expect(bobFeed.items.find((i) => i.content.includes('local reply body'))?.inReplyTo).toBe(parent?.guid)
})

test('a resolved reply whose parent degraded to a structural tombstone still emits source:inReplyTo (falls back to the origin ref)', async () => {
  const ctx = await makeApp(CTX)
  const { repo, db, app } = ctx
  // Ordinary remote parent (<guid> + distinct <link>) and a remote child citing the
  // parent's <link> — resolves via the parent's permalink identity key, same shape
  // as the test above. Once the parent is a structural tombstone (purge/last-
  // subscription-cleanup path, threading.ts convertToStructuralTombstone),
  // parentReplyRef's re-derivation of the parent's advertised guid finds nothing —
  // every identity key on the parent is gone — so it must fall back to what the
  // CHILD's own delivery originally cited (mat.material.inReplyTo), not emit null.
  await acquireFeed(ctx, {
    url: 'https://elsewhere.example/users/tomb/feed.xml',
    xml: `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>Tomb</title>`
      + `<item><guid isPermaLink="false">tomb-parent-guid</guid><link>https://elsewhere.example/notes/tomb-parent</link>`
      + `<description>tombstone parent body</description></item>`
      + `<item><guid isPermaLink="false">tomb-child-guid</guid><link>https://elsewhere.example/notes/tomb-child</link>`
      + `<description>tombstone child body</description><source:inReplyTo>https://elsewhere.example/notes/tomb-parent</source:inReplyTo></item>`
      + `</channel></rss>`,
  })

  const parentId = (repo.raw.prepare(
    `SELECT logical_item_id AS id FROM logical_identity_keys_v2 WHERE kind LIKE 'opaque:%' AND key = 'tomb-parent-guid'`,
  ).get() as { id: string } | undefined)?.id
  const childId = (repo.raw.prepare(
    `SELECT logical_item_id AS id FROM logical_identity_keys_v2 WHERE kind LIKE 'opaque:%' AND key = 'tomb-child-guid'`,
  ).get() as { id: string } | undefined)?.id
  expect(parentId).toBeDefined() // sanity: the parent reconciled
  expect(childId).toBeDefined()

  const before = (await (await app.request(`/post/${childId}`)).json()) as { item: { parentResolutionState: string; parentLogicalItemId: string | null } }
  expect(before.item.parentResolutionState).toBe('resolved') // sanity: the child really resolved onto the remote parent
  expect(before.item.parentLogicalItemId).toBe(parentId)

  // Emulate the exact deletes convertToStructuralTombstone performs (threading.ts
  // §5.3): every identity key gone, the row degraded — the child's parent edge
  // survives (it's a structural, not a content, field).
  db.write((tx) => convertToStructuralTombstone(tx, parentId!))

  const after = (await (await app.request(`/post/${childId}`)).json()) as { item: { parentResolutionState: string; inReplyToRef: string | null } }
  expect(after.item.parentResolutionState).toBe('resolved') // the edge survives the tombstone
  expect(after.item.inReplyToRef).toBe('https://elsewhere.example/notes/tomb-parent') // NOT null — this is replyDoesntPointBack
})

test('a RSC conversation is walkable by threadwalker semantics (guid string-compare + source:account names)', async () => {
  const { service, app } = await makeApp(CTX)
  await seedAlice(service)
  const root = (await service.getRecentLocalPosts(10)).find((p) => p.content === 'first body')!
  const wait = () => new Promise((r) => setTimeout(r, 2)) // repo orders replies by published_at then id (a
  // random UUID) — without this, sibling replies minted in the same millisecond
  // sort arbitrarily; force strictly-increasing published_at for a stable outline.
  const bob = await service.createLocalPostAs('bob', 'Bob', 'Bob replies to Alice', root)
  await wait()
  await service.createLocalPostAs('carol', 'Carol', 'Carol replies to Bob', bob)
  await wait()
  await service.createLocalPostAs('carol', 'Carol', 'Carol replies to the root', root)

  const startingGuid = `${CTX.publicUrl}/post/${root.id}` // the permalink walker.js compares against

  // --- walker.js semantics (Dave issue #14), reproduced ---
  // The fixed walker reads the author from each item's core <source>; a
  // starting (single-author) feed falls back to the channel <title>, and
  // walkComments passes no default (a reply with no <source> would be "?").
  async function fetchFeed(url: string): Promise<{ channelTitle: string; items: Array<{ guid: string; sourceName: string | null; text: string; commentsFeed: string | null }> }> {
    const path = url.replace(CTX.publicUrl!, '')
    const xml = await (await app.request(path)).text()
    const channelTitle = (xml.match(/<channel>[\s\S]*?<title>([^<]+)<\/title>/) ?? [])[1] ?? '?'
    const items: any[] = []
    for (const block of xml.split('<item>').slice(1)) {
      const item = block.slice(0, block.indexOf('</item>'))
      const guid = (item.match(/<guid[^>]*>([^<]+)<\/guid>/) ?? [])[1] ?? ''
      const sourceName = (item.match(/<source [^>]*>([^<]+)<\/source>/) ?? [])[1] ?? null
      const text = (item.match(/<source:markdown>([^<]*)/) ?? [])[1] ?? ''
      const commentsFeed = (item.match(/<source:comments[^>]*feedUrl="([^"]+)"/) ?? [])[1] ?? null
      items.push({ guid, sourceName, text, commentsFeed })
    }
    return { channelTitle, items }
  }

  const outline: string[] = []
  async function walk(item: { sourceName: string | null; text: string; commentsFeed: string | null }, depth: number, defaultAuthor: string | undefined) {
    outline.push('  '.repeat(depth) + `${item.sourceName ?? defaultAuthor ?? '?'}: ${item.text}`)
    if (!item.commentsFeed) return
    const feed = await fetchFeed(item.commentsFeed)
    for (const reply of feed.items) await walk(reply, depth + 1, undefined) // comments feed: no channel default
  }

  const start = await fetchFeed(`${CTX.publicUrl}/users/alice/feed.xml`)
  const top = start.items.find((i) => i.guid === startingGuid)
  expect(top).toBeDefined() // guid string-compare succeeds ONLY if the guid is a bare permalink (Task 1)
  await walk(top!, 0, start.channelTitle) // starting feed: the channel names the author

  // Author label is the DISPLAY NAME: core <source> carries author.displayName
  // (matching Dave's feeds), and the starting feed's channel <title> is the
  // display name too — so 'Alice'/'Bob'/'Carol', not the lowercased handles.
  // Feed order is newest-first (RSS convention); nesting stays structural, so
  // Carol's reply to the root sorts above Bob's older one while Carol's reply to
  // Bob stays nested under Bob.
  expect(outline).toEqual([
    'Alice: first body',
    '  Carol: Carol replies to the root',
    '  Bob: Bob replies to Alice',
    '    Carol: Carol replies to Bob',
  ])
  // and never an unresolved author
  expect(outline.join('\n')).not.toContain('?:')
})

test('comments feed: a remote guid equal to its permalink emits no isPermaLink attribute', async () => {
  const ctx = await makeApp(CTX)
  const { service, app } = ctx
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  // Guid === link, the shape a peer RSC/rss.chat instance emits (its own bare
  // permalink guid). Re-emitting it as isPermaLink="false" would assert the
  // origin's permalink is not one, leaving a reply nothing to fetch.
  const PERMA = 'https://peer.example/post/abc-123'
  await acquireFeed(ctx, {
    url: 'https://peer.example/users/frank/feed.xml',
    xml: `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>Frank</title>`
      + `<item><guid>${PERMA}</guid><link>${PERMA}</link>`
      + `<description>peer reply</description><source:inReplyTo>${root.url}</source:inReplyTo></item>`
      + `</channel></rss>`,
  })
  const body = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  expect(body).toContain(`<guid>${PERMA}</guid>`)
  expect(body).not.toContain(`<guid isPermaLink="false">${PERMA}</guid>`)
})

test('comments feed: a remote guid equal to its permalink but carrying a URL fragment still emits no isPermaLink attribute, and keeps the fragment in the emitted value', async () => {
  const ctx = await makeApp(CTX)
  const { service, app } = ctx
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  // guid === link, both bearing a fragment — legal per RSS, and normalizePermalink
  // strips the fragment from p.url (roots.ts) but the wire guid is stored raw. A
  // naive p.guid === p.url compares a stripped value against a raw one and always
  // loses this case, wrongly stamping isPermaLink="false" on a real permalink guid.
  const PERMA = 'https://peer.example/post/frag-1#comments'
  await acquireFeed(ctx, {
    url: 'https://peer.example/users/gina/feed.xml',
    xml: `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>Gina</title>`
      + `<item><guid>${PERMA}</guid><link>${PERMA}</link>`
      + `<description>peer reply with fragment</description><source:inReplyTo>${root.url}</source:inReplyTo></item>`
      + `</channel></rss>`,
  })
  const body = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  // bare guid, fragment preserved verbatim in the emitted VALUE
  expect(body).toContain(`<guid>${PERMA}</guid>`)
  expect(body).not.toContain(`<guid isPermaLink="false">${PERMA}</guid>`)
})

test('comments feed items are newest-first', async () => {
  const { service, app } = await makeApp(CTX)
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  const wait = () => new Promise((r) => setTimeout(r, 2)) // force strictly-increasing published_at
  await service.createLocalPostAs('bob', 'Bob', 'older reply', root)
  await wait()
  await service.createLocalPostAs('carol', 'Carol', 'newer reply', root)
  const body = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  expect(body.indexOf('newer reply')).toBeLessThan(body.indexOf('older reply'))
})

test('comments feed advertises where it lives; user feed carries source:self', async () => {
  const { service, app } = await makeApp(CTX)
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  await service.createLocalPostAs('bob', 'Bob', 'a reply', root)
  const comments = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  const self = `${CTX.publicUrl}/post/${root.id}/comments.xml`
  expect(comments).toContain(`<source:self>${self}</source:self>`)
  expect(comments).toContain(`href="${self}"`)
  const user = await (await app.request('/users/alice/feed.xml')).text()
  expect(user).toContain(`<source:self>${CTX.publicUrl}/users/alice/feed.xml</source:self>`)
})

test('comments feed: a remote reply with stored contentMarkdown emits source:markdown', async () => {
  const ctx = await makeApp(CTX)
  const { service, app, repo } = ctx
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  await acquireFeed(ctx, {
    url: 'https://elsewhere.example/users/gina/feed.xml',
    xml: `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>Gina</title>`
      + `<item><guid isPermaLink="false">origin-guid-93</guid><link>https://elsewhere.example/notes/93</link>`
      + `<description>&lt;p&gt;rendered html&lt;/p&gt;</description><source:inReplyTo>${root.url}</source:inReplyTo></item>`
      + `</channel></rss>`,
  })
  // Simulate what convert.ts:553-559 stores for a v1-converted item.
  const row = repo.raw.prepare(`SELECT id, normalized_json FROM observation_versions_v2 LIMIT 1`).get() as { id: string; normalized_json: string }
  const norm = JSON.parse(row.normalized_json)
  norm.contentMarkdown = 'rendered **markdown**'
  repo.raw.prepare(`UPDATE observation_versions_v2 SET normalized_json = ? WHERE id = ?`).run(JSON.stringify(norm), row.id)

  const body = await (await app.request(`/post/${root.id}/comments.xml`)).text()
  expect(body).toContain('<source:markdown>rendered **markdown**</source:markdown>')
})

test('an unchanged re-poll heals stored markdown without a new version row', async () => {
  const ctx = await makeApp(CTX)
  const { service, repo } = ctx
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  const SRC = randomUUID()
  const item = (md: string) => `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>Hal</title>`
    + `<item><guid isPermaLink="false">origin-guid-94</guid><link>https://elsewhere.example/notes/94</link>`
    + `<description>body</description><source:inReplyTo>${root.url}</source:inReplyTo>${md}</item>`
    + `</channel></rss>`
  const url = 'https://elsewhere.example/users/hal/feed.xml'
  await acquireFeed(ctx, { url, xml: item(''), sourceId: SRC })
  const countVersions = () => (repo.raw.prepare(`SELECT count(*) AS n FROM observation_versions_v2`).get() as { n: number }).n
  const before = countVersions()

  // Same content ⇒ same fingerprint ⇒ the "unchanged" branch. Markdown is not
  // fingerprinted, so only the heal can put it in normalized_json.
  await acquireFeed(ctx, { url, xml: item('<source:markdown>**body**</source:markdown>'), sourceId: SRC })
  const healed = repo.raw.prepare(`SELECT normalized_json FROM observation_versions_v2 LIMIT 1`).get() as { normalized_json: string }
  expect(JSON.parse(healed.normalized_json).contentMarkdown).toBe('**body**')
  expect(countVersions()).toBe(before) // no new version row
})
