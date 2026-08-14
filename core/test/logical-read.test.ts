import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { deleteLocalAccount } from '../src/logical/local.ts'
import { createApp } from '../src/api/app.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'
import { makeAuth } from './auth-helper.ts'
import { decodeCursor } from '../src/domain/cursor.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-08-14T00:00:00.000Z'
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const PUBLIC_URL = 'https://rsc.test'

function seedUser(raw: Raw, id: string, handle: string): void {
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES (?, 'local', ?, ?, NULL, ?)`).run(id, handle, handle, NOW)
}
function seedPost(raw: Raw, p: { id: string; author: string; content: string; url: string | null; at?: string }): void {
  raw.prepare(`INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url, content_markdown, edited_at, reply_context_author, reply_context_snippet) VALUES (?, ?, 'local', ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`).run(p.id, p.author, p.id, p.content, p.url, p.at ?? NOW, p.at ?? NOW)
}

// Direct-insert helper for a marker row not produced through the real delete
// commands — used for the relative/foreign-host filtering test, where the
// point is to plant historical rows a real command on THIS instance wouldn't
// write today, matching local.ts's terminallyDelete shape (materialize +
// marker) without going through createLocalPost/deleteLocalPost.
function seedDeletedMarker(raw: Raw, id: string, permalink: string, deletedAt: string): void {
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'local', ?, 'none', NULL, NULL, NULL, ?)`).run(id, deletedAt, deletedAt)
  raw.prepare(`INSERT INTO logical_deleted_local_v2 (logical_item_id, canonical_permalink, deleted_at) VALUES (?, ?, ?)`).run(id, permalink, deletedAt)
}

async function makeApp(publicUrl: string | null = PUBLIC_URL) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, store)
  const acquisition = createAcquisition({ db, fetchFn: (async () => new Response('', { status: 200 })) as unknown as typeof fetch, lookupFn: publicLookup, now: () => NOW })
  const app = createApp({
    service, bus, token: 'ops', auth: makeAuth(repo), users: repo, adminEmails: new Set(),
    feeds: { publicUrl, hubUrl: null, rssCloud: false },
    sources: { service: createSourceService(repo, null), repo }, logical: { store, acquisition, now: () => NOW },
  })
  return { app, repo: repo as typeof repo & { raw: Raw }, store, db }
}

test('deletions page ascending and drain across a shared timestamp (account deletion produces N same-timestamp markers)', async () => {
  const { app, repo, db } = await makeApp()
  seedUser(repo.raw, 'u1', 'alice')
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5']
  for (const id of ids) seedPost(repo.raw, { id, author: 'u1', content: id, url: `${PUBLIC_URL}/post/${id}` })
  // One shared `now` across every post, exactly like deleteLocalAccount does —
  // this is the scenario that breaks a timestamp-only cursor.
  db.write((tx) => deleteLocalAccount({ tx, accountId: 'u1', actorId: 'admin', now: NOW }))

  const seenRefs = new Set<string>()
  let totalReceived = 0
  let cursor: string | null = null
  let pages = 0
  for (;;) {
    const res = await app.request(`/deletions.json?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { deletions: { ref: string; deletedAt: string }[]; nextCursor: string | null; hasMore: boolean }
    pages++
    totalReceived += body.deletions.length
    for (const d of body.deletions) seenRefs.add(d.ref)
    expect(body.hasMore).toBe(body.nextCursor !== null)
    if (!body.hasMore) break
    cursor = body.nextCursor
    expect(pages).toBeLessThan(10) // guard against an infinite loop if paging breaks
  }
  // Both assertions matter: a boundary-repeat bug (e.g. `>=` instead of `>`
  // on the tuple cursor) re-emits the last row of one page as the first row
  // of the next — seenRefs.size alone dedupes that away via the Set, so the
  // total-count check is what actually catches it.
  expect(totalReceived).toBe(5) // nothing skipped, nothing repeated (incl. across-page duplicates)
  expect(seenRefs.size).toBe(5) // and all 5 are distinct
  for (const id of ids) expect(seenRefs.has(`${PUBLIC_URL}/post/${id}`)).toBe(true)
  expect(pages).toBeGreaterThan(1) // actually exercised pagination
})

test('deletions omit relative and foreign-host permalinks', async () => {
  const { app, repo } = await makeApp()
  seedDeletedMarker(repo.raw, 'legacy', '/post/legacy', NOW)
  seedDeletedMarker(repo.raw, 'foreign', 'https://other.test/post/foreign', NOW)
  const res = await app.request('/deletions.json')
  expect(res.status).toBe(200)
  const body = await res.json() as { deletions: unknown[] }
  expect(body.deletions).toEqual([])
})

test('a normal page returns normalized absolute refs for this instance and a null nextCursor when exhausted', async () => {
  const { app, repo } = await makeApp()
  seedDeletedMarker(repo.raw, 'own', `${PUBLIC_URL}/post/own#fragment`, NOW)
  const res = await app.request('/deletions.json')
  const body = await res.json() as { deletions: { ref: string; deletedAt: string }[]; nextCursor: string | null; hasMore: boolean }
  expect(body.deletions).toEqual([{ ref: `${PUBLIC_URL}/post/own`, deletedAt: NOW }]) // fragment stripped by normalizePermalink
  expect(body.hasMore).toBe(false)
  expect(body.nextCursor).toBeNull()
})

test('no configured publicUrl serves an empty page, not an unfiltered list', async () => {
  const { app, repo } = await makeApp(null)
  seedDeletedMarker(repo.raw, 'own', `${PUBLIC_URL}/post/own`, NOW)
  seedDeletedMarker(repo.raw, 'legacy', '/post/legacy', NOW)
  const res = await app.request('/deletions.json')
  expect(res.status).toBe(200)
  const body = await res.json() as { deletions: unknown[]; nextCursor: string | null; hasMore: boolean }
  expect(body.deletions).toEqual([])
  expect(body.hasMore).toBe(false)
  expect(body.nextCursor).toBeNull()
})

test('an invalid cursor is rejected with 400', async () => {
  const { app } = await makeApp()
  const res = await app.request('/deletions.json?cursor=not-base64url-json')
  expect(res.status).toBe(400)
})

test('the cursor tuple is the timestamp AND the item id, never the timestamp alone', async () => {
  const { app, repo } = await makeApp()
  seedDeletedMarker(repo.raw, 'a', `${PUBLIC_URL}/post/a`, NOW)
  seedDeletedMarker(repo.raw, 'b', `${PUBLIC_URL}/post/b`, NOW)
  const res = await app.request('/deletions.json?limit=1')
  const body = await res.json() as { nextCursor: string | null }
  expect(body.nextCursor).not.toBeNull()
  const dec = decodeCursor(body.nextCursor as string)
  expect(dec?.tuple.length).toBe(2)
  expect(dec?.tuple[0]).toBe(NOW)
})
