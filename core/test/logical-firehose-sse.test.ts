import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { createStreamSource, activateLogicalV2 } from '../src/logical/runtime.ts'
import { mountPublicFirehoseRoute } from '../src/api/logical-routes.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'
const FEEDS = { publicUrl: 'https://rsc.test', hubUrl: null, rssCloud: false }

function seedSource(raw: Raw, id: string, url: string): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, NOW)
}
const remoteIdForSource = (raw: Raw, sourceId: string): string =>
  (raw.prepare(`SELECT ik.logical_item_id AS id FROM logical_identity_keys_v2 ik JOIN deliveries_v2 d ON d.id = ik.key WHERE ik.kind = 'delivery' AND d.source_id = ?`).get(sourceId) as { id: string }).id
const ok = (body: string): Response => new Response(body, { status: 200 })
const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed T</title>${items}</channel></rss>`
const guidItem = (guid: string, body = 'd'): string => `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>${body}</description></item>`
async function acquireRemote(db: ReturnType<typeof createDatabaseContext>, sourceId: string, url: string, body: string): Promise<void> {
  const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
  const eng = createAcquisition({ db, fetchFn: (async () => ok(body)) as unknown as typeof fetch, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource(sourceId, { kind: 'scheduled' }, undefined)
}

async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  const bus = createEventBus()
  const service = createService(repo, bus, null, store)
  activateLogicalV2(db, NOW)
  bus.onNewPost(() => { bus.emitSequenceHint(store.snapshot((tx) => tx.getJournalMetadata().highWaterSeq)) })
  const app = new Hono()
  mountPublicFirehoseRoute(app, { source: createStreamSource(db), bus, feeds: FEEDS, pollMs: 5, heartbeatMs: 30 })
  return { repo, raw, db, store, bus, service, app }
}
// A resumable cursor at the current high water — connecting with THIS (not a
// missing/absent one) keeps the stream open in the live poll loop instead of
// immediately resetting and closing, exactly like logical-sse.test.ts's own
// live-delivery tests (cursorNow there, same shape here).
const cursorNow = (store: Awaited<ReturnType<typeof setup>>['store']) => store.snapshot((tx) => tx.journalCursor())

interface Frame { event?: string; id?: string; data: Record<string, unknown> | null; comment: boolean }
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

test('a local post appears as an upsert with safe rendered content, RSC firehose model tag', async () => {
  const { app, service, store } = await setup()
  // Connect first (caught up at high water, stays open in the poll loop),
  // THEN create — proving live delivery, not just replay.
  const res = await app.request('/firehose/stream', { headers: { 'Last-Event-ID': cursorNow(store) } })
  const post = await service.createLocalPostAs('alice', 'Alice', '**hi** there')
  const frames = await readStream(res, (f) => dataFrames(f).some((x) => x.data!.id === post.id))
  const upsert = dataFrames(frames).find((f) => f.data!.id === post.id)!
  expect(upsert.event).toBe('upsert')
  expect(upsert.data!.model).toBe('firehose-v1')
  expect(upsert.data!.content).toContain('<strong>hi</strong>')
  expect(upsert.data!.contentMarkdown).toBe('**hi** there')
  expect(upsert.data!.author).toMatchObject({ displayName: 'Alice', url: 'https://rsc.test/u/alice' })
})

test('a remote item is never emitted as an upsert — filtered by origin', async () => {
  const { app, raw, db, store, service } = await setup()
  const res = await app.request('/firehose/stream', { headers: { 'Last-Event-ID': cursorNow(store) } })
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquireRemote(db, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  drainReconciliation({ store, now: () => NOW })
  const remoteId = remoteIdForSource(raw, 's1')
  // A local post AFTER the remote item proves the stream is alive and past
  // the remote item's position, not merely still waiting to catch up.
  const marker = await service.createLocalPostAs('alice', 'Alice', 'marker')
  const frames = await readStream(res, (f) => dataFrames(f).some((x) => x.data!.id === marker.id))
  expect(dataFrames(frames).some((f) => f.data!.id === remoteId)).toBe(false)
})

test('a missing cursor starts the stream live (no reset) — a fresh curl/EventSource client has nothing to send yet', async () => {
  const { app, service } = await setup()
  // No Last-Event-ID at all — the normal first-connection case for a public
  // firehose (unlike /stream, which always has an SSR-derived cursor).
  const res = await app.request('/firehose/stream')
  const post = await service.createLocalPostAs('alice', 'Alice', 'live from nothing')
  const frames = await readStream(res, (f) => dataFrames(f).some((x) => x.data!.id === post.id))
  expect(frames.some((f) => f.event === 'reset')).toBe(false)
  const upsert = dataFrames(frames).find((f) => f.data!.id === post.id)!
  expect(upsert.event).toBe('upsert')
})

test('a malformed/stale cursor still resets, unlike a missing one', async () => {
  const { app } = await setup()
  const res = await app.request('/firehose/stream', { headers: { 'Last-Event-ID': 'not-a-real-cursor' } })
  const frames = await readStream(res, (f) => f.some((x) => x.event === 'reset'))
  expect(frames.some((f) => f.event === 'reset' && f.data!.model === 'firehose-v1')).toBe(true)
})

test('a per-IP connection cap rejects the (N+1)th concurrent connection with 429', async () => {
  const { app, store } = await setup()
  // A VALID resume cursor (not a missing one) keeps each connection open in
  // the live poll loop instead of resetting-and-closing immediately — without
  // this, streams would release their cap slot before all 6 requests finish
  // opening, making the 429 assertion below racy/flaky.
  const opts = { headers: { 'x-forwarded-for': '203.0.113.9', 'Last-Event-ID': cursorNow(store) } }
  const responses = await Promise.all(Array.from({ length: 6 }, () => app.request('/firehose/stream', opts)))
  const statuses = responses.map((r) => r.status).sort()
  expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
  expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(5)
  for (const r of responses) await r.body?.cancel()
})
