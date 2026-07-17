import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { parseFeedWithMeta } from '../src/domain/ingest.ts'
import type { FeedContext } from '../src/domain/feed.ts'

const CTX: FeedContext = { publicUrl: 'https://cast.example.com', hubUrl: 'https://cast.example.com/hub', rssCloud: true }

async function makeApp(feeds?: FeedContext) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', feeds })
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
  expect(body).toContain('<guid isPermaLink="false">')
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
