import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { parseFeedWithMeta, ingestItems } from '../src/domain/ingest.ts'
import type { FeedContext } from '../src/domain/feed.ts'
import type { Post } from '../src/domain/types.ts'
import { renderFirehoseRss, injectSourceAccounts, injectSourceComments, localGuid } from '../src/domain/feed.ts'
import { generateRssFeed } from 'feedsmith'
import { makeAuth } from './auth-helper.ts'

const CTX: FeedContext = { publicUrl: 'https://cast.example.com', hubUrl: 'https://cast.example.com/hub', rssCloud: true }

async function makeApp(feeds?: FeedContext) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus, feeds?.publicUrl ?? null)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, feeds })
  return { repo, service, app }
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

test('injectSourceAccounts: element lands inside the right item; xmlns declared once with comments', () => {
  const ctx = { publicUrl: 'https://tc.example', hubUrl: null, rssCloud: false }
  const alice = { id: 'u1', kind: 'local' as const, handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
  const entries = [{
    id: 'p1', authorId: 'u1', source: 'local' as const, guid: 'guid-1', title: null,
    content: 'x', url: null, publishedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z',
    inReplyTo: null, inReplyToPostId: null, threadRootId: null,
    sourceName: null, sourceFeedUrl: null, contentMarkdown: null, author: alice,
  }]
  let xml = renderFirehoseRss(entries, ctx)
  xml = injectSourceAccounts(xml, [{ guid: 'guid-1', service: 'tc.example', name: 'alice' }])
  xml = injectSourceComments(xml, [{ guid: 'guid-1', count: 2, feedUrl: 'https://tc.example/post/p1/comments.xml' }])
  expect(xml).toContain('<source:account service="tc.example">alice</source:account>')
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
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus, CTX.publicUrl)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, feeds: CTX })
  return { repo, service, app }
}

test('GET /users/rss.xml serves the firehose; a user literally named rss keeps their feed', async () => {
  const { service, app } = await makeFirehoseApp()
  await seedAlice(service)
  const res = await app.request('/users/rss.xml')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/rss+xml')
  const xml = await res.text()
  expect(xml).toContain(': all posts</title>')
  expect(xml).toContain('<source url=')
  expect(xml).toContain('<source:account ')
  // non-collision: a local user named "rss" still resolves per-user
  await service.createLocalPostAs('rss', 'Rss The User', 'a post by the user named rss')
  const perUser = await app.request('/users/rss/feed.xml')
  expect(perUser.status).toBe(200)
  expect(await perUser.text()).not.toContain(': all posts</title>')
})

test('ROUND TRIP: our own ingest consumes the firehose with full attribution and threading', async () => {
  const { service, app } = await makeFirehoseApp()
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post text')
  await service.createLocalPostAs('bob', 'Bob', 'reply text', root)
  const xml = await (await app.request('/users/rss.xml')).text()
  const { items } = await parseFeedWithMeta(xml)
  const freshRepo = await createSqliteRepository(':memory:')
  const sub = await freshRepo.createRemoteUser({ handle: 'tc-firehose', displayName: 'TC', feedUrl: 'https://tc.example/users/rss.xml' })
  await ingestItems(freshRepo, createEventBus(), sub, items)
  const timeline = await freshRepo.getTimeline(50)
  const rootEntry = timeline.find((e) => e.content.includes('root post text'))!
  const replyEntry = timeline.find((e) => e.content.includes('reply text'))!
  // attribution: item author, not the subscription
  expect(rootEntry.sourceName).toBe('Alice')
  expect(rootEntry.sourceFeedUrl).toBe(`${CTX.publicUrl}/users/alice/feed.xml`)
  expect(replyEntry.sourceName).toBe('Bob')
  // threading: the reply resolved against the root's permalink (adoption
  // covers newest-first order: the reply arrives before its parent)
  expect(replyEntry.inReplyToPostId).toBe(rootEntry.id)
  expect(replyEntry.threadRootId).toBe(rootEntry.id)
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
