import { test, expect } from 'vitest'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createStreamSource, activateLogicalV2 } from '../src/logical/runtime.ts'
import { mountLogicalStreamRoute } from '../src/api/logical-routes.ts'
import { appendJournal, encodeJournalCursor } from '../src/logical/journal.ts'

const NOW = '2026-07-24T00:00:00.000Z'
const ANON = { localAccountId: null, activeSourceIds: [] as string[] }

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const bus = createEventBus()
  const service = createService(repo, bus, null, store)
  activateLogicalV2(db, NOW) // journal generation 1 + first reset at sequence 1
  // server.ts wires this: a v2 local mutation publishes its coalesced high water so
  // an open /stream catches up via the hint (not only its heartbeat).
  bus.onNewPost(() => { bus.emitSequenceHint(store.snapshot((tx) => tx.getJournalMetadata().highWaterSeq)) })
  const app = new Hono()
  mountLogicalStreamRoute(app, { source: createStreamSource(db), bus, resolveViewer: async () => ANON, pollMs: 5, heartbeatMs: 30 })
  return { repo, db, store, bus, service, app }
}

interface Frame { event?: string; id?: string; data: Record<string, unknown> | null; comment: boolean }

// Read SSE frames until `until(frames)` is satisfied, the stream closes, or a
// safety cap. Parses `event:`/`id:`/`data:` lines and flags `:` comment frames.
async function readStream(res: Response, until: (frames: Frame[]) => boolean): Promise<Frame[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const frames: Frame[] = []
  for (let i = 0; i < 400 && !until(frames); i++) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value)
    let idx: number
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2)
      const lines = raw.split('\n')
      const comment = raw.trimStart().startsWith(':')
      const dataLine = lines.find((l) => l.startsWith('data: '))
      frames.push({
        event: lines.find((l) => l.startsWith('event: '))?.slice(7),
        id: lines.find((l) => l.startsWith('id: '))?.slice(4),
        data: dataLine ? (JSON.parse(dataLine.slice(6)) as Record<string, unknown>) : null,
        comment,
      })
    }
  }
  await reader.cancel()
  return frames
}

const dataFrames = (frames: Frame[]) => frames.filter((f) => !f.comment && f.data)
const byLogicalId = (frames: Frame[], id: string) => dataFrames(frames).find((f) => f.data!.logicalItemId === id)
const cursorNow = (store: Awaited<ReturnType<typeof setup>>['store']) => store.snapshot((tx) => tx.journalCursor())

// ---- cursor seeding + reset semantics (spec §5.3) ---------------------------

test('a missing cursor is invalid: exactly one synthesized reset (no id), then close', async () => {
  const { app } = await setup()
  const res = await app.request('/stream')
  const frames = await readStream(res, (f) => f.some((x) => x.event === 'reset'))
  const resets = frames.filter((f) => f.event === 'reset')
  expect(resets.length).toBe(1)
  expect(resets[0].id).toBeUndefined() // synthesized recovery reset has no invented id
  expect(resets[0].data).toEqual({ model: 'logical-v2', kind: 'reset' })
})

test('an unknown / stale / older-generation cursor each emits exactly one reset then closes', async () => {
  const { app } = await setup()
  const cases = [
    'not-a-cursor', // unknown / malformed
    encodeJournalCursor({ version: 1, resetGeneration: 1, sequence: 9999 }), // stale (ahead of high water)
    encodeJournalCursor({ version: 1, resetGeneration: 0, sequence: 0 }), // older generation
  ]
  for (const cur of cases) {
    const res = await app.request('/stream', { headers: { 'Last-Event-ID': cur } })
    const frames = await readStream(res, (f) => f.some((x) => x.event === 'reset'))
    expect(frames.filter((f) => f.event === 'reset').length).toBe(1)
    expect(dataFrames(frames).every((f) => f.data!.kind === 'reset')).toBe(true) // no data events served
  }
})

test('the query seeds the cursor and the Last-Event-ID header takes precedence', async () => {
  const { app, service, store } = await setup()
  const c0 = cursorNow(store)
  const root = await service.createLocalPostAs('alice', 'Alice', 'seeded root')

  // query-only seed → serves (replays the post), no reset
  const viaQuery = await app.request(`/stream?last=${encodeURIComponent(c0)}`)
  const qf = await readStream(viaQuery, (f) => byLogicalId(f, root.id) !== undefined)
  expect(byLogicalId(qf, root.id)?.data?.kind).toBe('upsert')

  // header valid + query garbage → header wins (serves), never resets
  const viaBoth = await app.request(`/stream?last=garbage`, { headers: { 'Last-Event-ID': c0 } })
  const bf = await readStream(viaBoth, (f) => byLogicalId(f, root.id) !== undefined)
  expect(bf.some((f) => f.event === 'reset')).toBe(false)
  expect(byLogicalId(bf, root.id)?.data?.kind).toBe('upsert')
})

// ---- ordered replay + reply-count overlay (spec §5.4-5.5) -------------------

test('replay projects upserts under current policy and attaches the root reply-count overlay only for resolved replies', async () => {
  const { app, service, store } = await setup()
  const c0 = cursorNow(store)
  const root = await service.createLocalPostAs('alice', 'Alice', 'root post')
  const reply1 = await service.createLocalPostAs('alice', 'Alice', 'reply one', root)
  const reply2 = await service.createLocalPostAs('alice', 'Alice', 'reply two', reply1)

  const res = await app.request('/stream', { headers: { 'Last-Event-ID': c0 } })
  const frames = await readStream(res, (f) => byLogicalId(f, reply2.id) !== undefined)

  const rootFrame = byLogicalId(frames, root.id)!
  expect(rootFrame.data).toMatchObject({ model: 'logical-v2', kind: 'upsert' })
  expect((rootFrame.data!.item as Record<string, unknown>).content).toBe('root post')
  expect(rootFrame.data).not.toHaveProperty('replyCounts') // a root is not a resolved reply

  // Both replies carry the authoritative ordinary-visible conversation total of
  // their derived root (2 = reply1 + reply2), from the SAME projection snapshot.
  expect(byLogicalId(frames, reply1.id)!.data!.replyCounts).toEqual({ rootLogicalItemId: root.id, rootConversationReplyCount: 2 })
  expect(byLogicalId(frames, reply2.id)!.data!.replyCounts).toEqual({ rootLogicalItemId: root.id, rootConversationReplyCount: 2 })
})

test('a stored reset stops replay at its own encoded cursor and closes; later rows are not served', async () => {
  const { app, service, store, db } = await setup()
  const c0 = cursorNow(store)
  const root = await service.createLocalPostAs('alice', 'Alice', 'before barrier')
  // A policy/orphan barrier reset (spec §5.5: recovery rides the single reset).
  db.write((tx) => appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, NOW))
  await service.createLocalPostAs('alice', 'Alice', 'after barrier')

  const res = await app.request('/stream', { headers: { 'Last-Event-ID': c0 } })
  const frames = await readStream(res, (f) => f.some((x) => x.event === 'reset'))

  expect(byLogicalId(frames, root.id)?.data?.kind).toBe('upsert') // the pre-barrier row replayed
  const reset = frames.find((f) => f.event === 'reset')!
  expect(reset.id).toBeTruthy() // a STORED reset uses its own encoded cursor
  expect(reset.data).not.toHaveProperty('replyCounts') // barrier resets ride with no overlay
  // replay stopped at the barrier: the post AFTER it was never served
  expect(dataFrames(frames).some((f) => (f.data!.item as Record<string, unknown> | undefined)?.content === 'after barrier')).toBe(false)
})

// ---- unavailable → remove, never a placeholder (spec §5.4) ------------------

test('a historical upsert whose item is now unavailable projects as a remove, never a placeholder', async () => {
  const { app, service, store } = await setup()
  const c0 = cursorNow(store)
  const post = await service.createLocalPostAs('alice', 'Alice', 'doomed post') // upsert
  store.deleteLocalPost({ postId: post.id, actorId: post.author.id, now: NOW }) // remove + deleted marker

  const res = await app.request('/stream', { headers: { 'Last-Event-ID': c0 } })
  const frames = await readStream(res, (f) => dataFrames(f).length >= 2)

  // The replayed upsert projects to a remove (item unavailable); the stored remove
  // stays a remove. Neither is ever a placeholder, and every frame is upsert/remove/reset.
  expect(dataFrames(frames).every((f) => ['upsert', 'remove', 'reset'].includes(f.data!.kind as string))).toBe(true)
  expect(dataFrames(frames).some((f) => f.data!.logicalItemId === post.id && f.data!.kind === 'remove')).toBe(true)
  expect(dataFrames(frames).some((f) => f.data!.logicalItemId === post.id && f.data!.kind === 'upsert')).toBe(false)
})

// ---- live: hints wake the pump; heartbeats are SSE comments -----------------

test('live posts arrive as upserts (listener registered before replay; coalesced hints)', async () => {
  const { app, service, store } = await setup()
  const res = await app.request('/stream', { headers: { 'Last-Event-ID': cursorNow(store) } })
  // Connect first (caught up at high water), THEN create — proving live delivery.
  const p1 = await service.createLocalPostAs('alice', 'Alice', 'live one')
  const p2 = await service.createLocalPostAs('alice', 'Alice', 'live two')
  const p3 = await service.createLocalPostAs('alice', 'Alice', 'live three')
  const frames = await readStream(res, (f) => [p1, p2, p3].every((p) => byLogicalId(f, p.id)))
  for (const p of [p1, p2, p3]) expect(byLogicalId(frames, p.id)?.data?.kind).toBe('upsert')
})

test('heartbeats are SSE comments on an idle live stream', async () => {
  const { app, store } = await setup()
  const res = await app.request('/stream', { headers: { 'Last-Event-ID': cursorNow(store) } })
  const frames = await readStream(res, (f) => f.some((x) => x.comment))
  expect(frames.some((f) => f.comment)).toBe(true)
})
