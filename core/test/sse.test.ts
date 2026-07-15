import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'

test('GET /timeline/stream emits an SSE "post" frame when a post is created', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret' })

  const res = await app.request('/timeline/stream')
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()

  // Give the stream a tick to subscribe, then emit.
  await new Promise((r) => setTimeout(r, 20))
  await service.createLocalPostAs('alice', 'Alice', 'live post')

  let buf = ''
  while (!buf.includes('event: post')) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value)
  }
  await reader.cancel()
  expect(buf).toContain('event: post')
  expect(buf).toContain('live post')
  expect(buf).toContain('id: ')
})

async function readUntil(res: Response, needle: string): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (!buf.includes(needle)) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value)
  }
  await reader.cancel()
  return buf
}

test('reconnect with Last-Event-ID replays missed posts (inclusive, arrival order) before live ones', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret' })

  const anchor = await service.createLocalPostAs('alice', 'Alice', 'anchor post')
  const news = await repo.createRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  // R1 case: same created_at as the anchor, different id
  await repo.insertPost({ id: 'sibling1', authorId: news.id, source: 'remote', guid: 'g-sib', title: null, content: 'same-ms sibling', url: null, publishedAt: anchor.createdAt, createdAt: anchor.createdAt })
  // H1 case: arrived after the anchor, published long before it
  const laterArrival = new Date(Date.parse(anchor.createdAt) + 5).toISOString()
  await repo.insertPost({ id: 'olddated1', authorId: news.id, source: 'remote', guid: 'g-old', title: null, content: 'old-dated missed', url: null, publishedAt: '2020-01-01T00:00:00.000Z', createdAt: laterArrival })

  const res = await app.request('/timeline/stream', { headers: { 'Last-Event-ID': anchor.id } })
  const buf = await readUntil(res, 'old-dated missed')
  expect(buf).toContain('same-ms sibling') // R1: sibling re-delivered despite equal created_at
  expect(buf).toContain('old-dated missed') // H1: old publishedAt does not hide it
  expect(buf.indexOf('same-ms sibling')).toBeLessThan(buf.indexOf('old-dated missed')) // arrival order
})

test('reconnect too stale (over the replay cap) skips replay but still goes live', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret' })

  const anchor = await service.createLocalPostAs('alice', 'Alice', 'anchor post')
  const base = Date.parse(anchor.createdAt)
  for (let i = 0; i < 101; i++) {
    const ts = new Date(base + i + 1).toISOString()
    await repo.insertPost({ id: `missed-${i}`, authorId: anchor.authorId, source: 'local', guid: `g-missed-${i}`, title: null, content: `missed ${i}`, url: null, publishedAt: ts, createdAt: ts })
  }

  const res = await app.request('/timeline/stream', { headers: { 'Last-Event-ID': anchor.id } })
  await new Promise((r) => setTimeout(r, 20))
  await service.createLocalPostAs('alice', 'Alice', 'live after stale reconnect')
  const buf = await readUntil(res, 'live after stale reconnect')
  expect(buf).not.toContain('missed 0') // no replay frames at all
})

test('an unknown Last-Event-ID skips replay silently and goes live', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret' })

  const res = await app.request('/timeline/stream', { headers: { 'Last-Event-ID': 'no-such-post' } })
  await new Promise((r) => setTimeout(r, 20))
  await service.createLocalPostAs('alice', 'Alice', 'live post')
  const buf = await readUntil(res, 'live post')
  expect(buf).toContain('event: post')
})

test('a replay query failure degrades to live-only instead of killing the stream', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const broken = { ...service, getPost: async () => { throw new Error('db exploded') } }
  const app = createApp({ service: broken as typeof service, bus, token: 'secret' })

  const res = await app.request('/timeline/stream', { headers: { 'Last-Event-ID': 'whatever' } })
  await new Promise((r) => setTimeout(r, 20))
  await service.createLocalPostAs('alice', 'Alice', 'live despite replay failure')
  const buf = await readUntil(res, 'live despite replay failure')
  expect(buf).toContain('event: post')
})
