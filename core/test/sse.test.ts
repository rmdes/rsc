import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth } from './auth-helper.ts'

test('GET /timeline/stream emits an SSE "post" frame when a post is created', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo })

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
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo })

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
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo })

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
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo })

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
  const app = createApp({ service: broken as typeof service, bus, token: 'secret', auth: makeAuth(repo), users: repo })

  const res = await app.request('/timeline/stream', { headers: { 'Last-Event-ID': 'whatever' } })
  await new Promise((r) => setTimeout(r, 20))
  await service.createLocalPostAs('alice', 'Alice', 'live despite replay failure')
  const buf = await readUntil(res, 'live despite replay failure')
  expect(buf).toContain('event: post')
})

// Reads post-event frames off the stream until every content string in
// `wantContents` has been seen at least once, returning every parsed post
// frame collected along the way (per-frame content is asserted — never
// cross-frame emit ordering, since the count query makes the bus handler
// async and closely-spaced frames may interleave).
async function collectPostFrames(res: Response, wantContents: string[]): Promise<Record<string, unknown>[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const frames: Record<string, unknown>[] = []
  const remaining = new Set(wantContents)
  while (remaining.size > 0) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value)
    let idx: number
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      if (/^event: post/m.test(frame)) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
        if (dataLine) {
          const obj = JSON.parse(dataLine.slice(6)) as Record<string, unknown>
          frames.push(obj)
          if (typeof obj.content === 'string') remaining.delete(obj.content)
        }
      }
    }
  }
  await reader.cancel()
  return frames
}

function frameFor(frames: Record<string, unknown>[], content: string): Record<string, unknown> {
  const frame = frames.find((f) => f.content === content)
  if (!frame) throw new Error(`no frame with content ${content}`)
  return frame
}

test('live SSE reply frames carry authoritative rootReplyCount; roots, unresolved replies, and edits do not', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo })

  const res = await app.request('/timeline/stream')
  await new Promise((r) => setTimeout(r, 20))

  const root = await service.createLocalPostAs('alice', 'Alice', 'root post')
  const reply1 = await service.createLocalPostAs('alice', 'Alice', 'reply one', root)
  const reply2 = await service.createLocalPostAs('alice', 'Alice', 'reply two', reply1)
  const edited = await service.editLocalPost(reply2, 'reply two edited', reply2.author)
  const orphan = { ...reply1, id: 'orphan-1', guid: 'g-orphan', content: 'orphan reply', inReplyTo: 'https://missing.example/post', inReplyToPostId: null, threadRootId: null, editedAt: null }
  bus.emitNewPost(orphan)

  const frames = await collectPostFrames(res, ['root post', 'reply one', 'reply two', 'reply two edited', 'orphan reply'])

  expect(frameFor(frames, 'reply one')).toMatchObject({
    inReplyToPostId: root.id,
    threadRootId: root.id,
    rootReplyCount: 1,
  })
  expect(frameFor(frames, 'reply two')).toMatchObject({
    inReplyToPostId: reply1.id,
    threadRootId: root.id,
    rootReplyCount: 2,
  })
  const rootFrame = frameFor(frames, 'root post')
  expect(rootFrame).not.toHaveProperty('rootReplyCount')

  const editedFrame = frameFor(frames, 'reply two edited')
  expect(editedFrame.editedAt).toBe(edited.editedAt)
  expect(editedFrame).not.toHaveProperty('rootReplyCount')

  const orphanFrame = frameFor(frames, 'orphan reply')
  expect(orphanFrame).not.toHaveProperty('rootReplyCount')
})

test('SSE replay delivers the same authoritative reply totals as live (not deltas)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo })

  const anchor = await service.createLocalPostAs('alice', 'Alice', 'anchor post')
  const base = Date.parse(anchor.createdAt)
  const t = (n: number) => new Date(base + n).toISOString()
  await repo.insertPost({ id: 'root2', authorId: anchor.authorId, source: 'local', guid: 'g-root2', title: null, content: 'replay root', url: null, publishedAt: t(1), createdAt: t(1) })
  await repo.insertPost({ id: 'r2reply1', authorId: anchor.authorId, source: 'local', guid: 'g-r2r1', title: null, content: 'replay reply one', url: null, publishedAt: t(2), createdAt: t(2), inReplyTo: 'root2', inReplyToPostId: 'root2', threadRootId: 'root2' })
  await repo.insertPost({ id: 'r2reply2', authorId: anchor.authorId, source: 'local', guid: 'g-r2r2', title: null, content: 'replay reply two', url: null, publishedAt: t(3), createdAt: t(3), inReplyTo: 'root2', inReplyToPostId: 'root2', threadRootId: 'root2' })

  const res = await app.request('/timeline/stream', { headers: { 'Last-Event-ID': anchor.id } })
  const frames = await collectPostFrames(res, ['replay reply one', 'replay reply two'])

  expect(frameFor(frames, 'replay reply one')).toMatchObject({ threadRootId: 'root2', rootReplyCount: 2 })
  expect(frameFor(frames, 'replay reply two')).toMatchObject({ threadRootId: 'root2', rootReplyCount: 2 })
})

test('a reply-count enrichment failure degrades to an un-enriched frame instead of killing the stream', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const broken = { ...service, countThreadRepliesByRootIds: async () => { throw new Error('count failed') } }
  const app = createApp({ service: broken as typeof service, bus, token: 'secret', auth: makeAuth(repo), users: repo })

  const res = await app.request('/timeline/stream')
  await new Promise((r) => setTimeout(r, 20))

  const root = await service.createLocalPostAs('alice', 'Alice', 'broken root')
  await service.createLocalPostAs('alice', 'Alice', 'reply under broken', root)
  await service.createLocalPostAs('alice', 'Alice', 'root two')

  const frames = await collectPostFrames(res, ['broken root', 'reply under broken', 'root two'])

  const replyFrame = frameFor(frames, 'reply under broken')
  expect(replyFrame.inReplyToPostId).toBe(root.id)
  expect(replyFrame).not.toHaveProperty('rootReplyCount')
  // the stream stayed alive past the failure: a later, unrelated live post arrived
  expect(frameFor(frames, 'root two')).toBeTruthy()
})
