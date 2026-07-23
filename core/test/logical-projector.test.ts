import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { projectItem, projectTimeline, projectHistory, projectLocalActivity, resolvePublisher } from '../src/logical/projector.ts'
import type { ProjectionViewer, TimelineLens, TimelineCursorV2 } from '../src/logical/types.ts'
import { decodeCursor } from '../src/domain/cursor.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-23T00:00:00.000Z'
const ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  return { raw, db, store: createLogicalStore(db) }
}

function seedSource(raw: Raw, id: string, url: string, opts: { mode?: string; governance?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, 'enabled', ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, opts.mode ?? 'single_publisher', opts.governance ?? 'allowed', NOW)
}
function seedUser(raw: Raw, id: string, handle: string): void {
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES (?, 'local', ?, ?, NULL, ?)`).run(id, handle, handle, NOW)
}
function seedPost(raw: Raw, p: { id: string; author: string; content?: string; url?: string | null; at?: string; replyTo?: string | null; threadRoot?: string | null; edited?: string | null }): void {
  raw.prepare(
    `INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url, content_markdown, edited_at, reply_context_author, reply_context_snippet)
     VALUES (?, ?, 'local', ?, NULL, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, NULL, NULL)`,
  ).run(p.id, p.author, p.id, p.content ?? 'c', p.url ?? null, p.at ?? NOW, p.at ?? NOW, p.replyTo ?? null, p.threadRoot ?? null, p.edited ?? null)
}
function seedSubscription(raw: Raw, owner: string, sourceId: string, state = 'active'): void {
  raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), owner, sourceId, state, NOW)
}
function seedFederation(raw: Raw, sourceId: string, status = 'approved'): void {
  raw.prepare(`INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`).run(sourceId, status, NOW, NOW)
}
function seedFollow(raw: Raw, follower: string, followed: string): void {
  raw.prepare(`INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)`).run(follower, followed, NOW)
}

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const ok = (body: string): Response => new Response(body, { status: 200 })
const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed T</title>${items}</channel></rss>`
const guidItem = (guid: string, body = 'd'): string => `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>${body}</description></item>`
const linkItem = (link: string, body = 'd'): string => `<item><link>${link}</link><title>t</title><description>${body}</description></item>`

async function acquire(db: ReturnType<typeof createDatabaseContext>, sourceId: string, url: string, body: string): Promise<void> {
  const eng = createAcquisition({ db, fetchFn: (async (i: string | URL | Request) => { const u = typeof i === 'string' ? i : i instanceof URL ? i.toString() : i.url; if (u !== url) throw new Error(`no route ${u}`); return ok(body) }) as unknown as typeof fetch, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource(sourceId, { kind: 'scheduled' }, undefined)
}
const drain = (store: ReturnType<typeof createLogicalStore>): number => drainReconciliation({ store, now: () => NOW })

// White-box remote observation (no crafted network body), mirrors the reconcile test helper.
function seedJob(raw: Raw, input: { sourceId: string; deliveryKey: { kind: string; key: string }; committedAt?: string; wireOrdinal?: number; material?: { title?: string | null; content?: string; permalink?: string | null; published?: string; updated?: string | null; inReplyTo?: string | null } }): { versionId: string } {
  const runId = randomUUID(); const deliveryId = randomUUID(); const versionId = randomUUID(); const jobId = randomUUID()
  const committedAt = input.committedAt ?? NOW
  const m = input.material ?? {}
  const material = { v: 1, keyKind: input.deliveryKey.kind, key: input.deliveryKey.key, title: m.title ?? 't', content: m.content ?? 'body', link: m.permalink ?? null, published: m.published ?? '', updated: m.updated ?? null, inReplyTo: m.inReplyTo ?? null, enclosures: [] }
  const canonical = Buffer.from(JSON.stringify(material), 'utf8')
  const fingerprint = createHash('sha256').update(canonical).digest('hex')
  const normalized = JSON.stringify({ keyKind: input.deliveryKey.kind, key: input.deliveryKey.key, permalink: m.permalink ?? null, inReplyTo: m.inReplyTo ?? null, enclosures: [] })
  const rawEvidence = JSON.stringify({ title: m.title ?? 't', sourceName: 'Feed T', link: m.permalink ?? null, published: m.published ?? '', updated: m.updated ?? null, enclosureCount: 0 })
  raw.prepare(`INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json) VALUES (?, ?, 'scheduled', 'terminal', ?, ?, ?, 'parsed', '{}', NULL, NULL, NULL)`).run(runId, input.sourceId, committedAt, committedAt, committedAt)
  raw.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(deliveryId, input.sourceId, input.deliveryKey.kind, input.deliveryKey.key, committedAt, committedAt, runId)
  raw.prepare(`INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(versionId, deliveryId, fingerprint, canonical, committedAt, runId, input.wireOrdinal ?? 0, committedAt, runId, rawEvidence, normalized)
  raw.prepare(`INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at) VALUES (?, 'observation', ?, ?, NULL, 'pending', 0, ?, NULL, NULL, ?)`).run(jobId, runId, versionId, committedAt, committedAt)
  return { versionId }
}

const oneRemoteId = (raw: Raw): string => (raw.prepare(`SELECT id FROM logical_items_v2 WHERE origin = 'remote' LIMIT 1`).get() as { id: string }).id

// ---- DTO bounds + classification booleans (spec §3.4) -----------------------

test('a remote item projects boolean classification; personal follows subscription, federated follows approved federation', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  drain(store)
  const id = oneRemoteId(raw)

  // anonymous: personal false always
  const anon = db.read((tx) => projectItem(tx, id, ANON))!
  expect(anon.kind).toBe('logical_item')
  expect(anon.origin).toBe('remote')
  expect(typeof anon.classification.personal).toBe('boolean')
  expect(typeof anon.classification.federated).toBe('boolean')
  expect(anon.classification).toEqual({ personal: false, federated: false })
  expect(['explicit', 'arrival', null]).toContain(anon.updatedAtProvenance) // membership, not equality

  // a subscriber sees personal:true; still not federated
  seedUser(raw, 'u1', 'alice')
  seedSubscription(raw, 'u1', 's1')
  const subbed = db.read((tx) => projectItem(tx, id, { localAccountId: 'u1', activeSourceIds: [] }))!
  expect(subbed.classification).toEqual({ personal: true, federated: false })

  // approve federation → federated:true from any approved source
  seedFederation(raw, 's1')
  const fed = db.read((tx) => projectItem(tx, id, { localAccountId: 'u1', activeSourceIds: [] }))!
  expect(fed.classification).toEqual({ personal: true, federated: true })
})

test('a local item is always federated:false; personal follows own/followed rules', async () => {
  const { raw, db } = await fresh()
  seedUser(raw, 'u1', 'alice')
  seedUser(raw, 'u2', 'bob')
  seedPost(raw, { id: 'p1', author: 'u1', url: 'https://rsc.test/post/p1' })

  const own = db.read((tx) => projectItem(tx, 'p1', { localAccountId: 'u1', activeSourceIds: [] }))!
  expect(own.origin).toBe('local')
  expect(own.classification).toEqual({ personal: true, federated: false })

  const stranger = db.read((tx) => projectItem(tx, 'p1', { localAccountId: 'u2', activeSourceIds: [] }))!
  expect(stranger.classification).toEqual({ personal: false, federated: false })

  seedFollow(raw, 'u2', 'u1')
  const follower = db.read((tx) => projectItem(tx, 'p1', { localAccountId: 'u2', activeSourceIds: [] }))!
  expect(follower.classification.personal).toBe(true)
})

test('a remote echo of a local permalink confers neither Personal nor Federated on the local origin', async () => {
  const { raw, db, store } = await fresh()
  seedUser(raw, 'u1', 'alice')
  seedPost(raw, { id: 'p1', author: 'u1', url: 'https://feed.test/p1' })
  seedSource(raw, 's1', 'https://feed.test/f')
  seedSubscription(raw, 'u1', 's1')
  seedFederation(raw, 's1')
  await acquire(db, 's1', 'https://feed.test/f', RSS(linkItem('https://feed.test/p1')))
  drain(store)

  // No second (remote) item was created — the echo was a local_permalink_collision.
  expect((raw.prepare(`SELECT COUNT(*) AS n FROM logical_items_v2 WHERE origin = 'remote'`).get() as { n: number }).n).toBe(0)
  const dto = db.read((tx) => projectItem(tx, 'p1', { localAccountId: 'u1', activeSourceIds: [] }))!
  expect(dto.origin).toBe('local')
  expect(dto.classification.federated).toBe(false) // remote echo never federates a local item
})

// ---- read-time authority: stored hints are optimization only (spec §3.1) ----

test('deterministic selection re-derives from current data even when the stored delivery hint is garbage', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, 's1', 'https://feed.test/f', RSS(guidItem('g1', 'the body')))
  drain(store)
  const id = oneRemoteId(raw)
  // Only selected_delivery_id has no FK; a garbage delivery hint must not change the read.
  raw.prepare(`UPDATE logical_items_v2 SET selected_delivery_id = 'garbage' WHERE id = ?`).run(id)
  const dto = db.read((tx) => projectItem(tx, id, ANON))!
  expect(dto.content).toBe('the body') // re-derived, not the corrupt pointer
  expect(dto.selectedAuthor.kind).toBe('remote_publisher')
})

// ---- reply counts are query-time derived, no stored counts (spec §3.4) ------

test('directReplyCount and conversationReplyCount are derived at read time from current descendants', async () => {
  const { raw, db } = await fresh()
  seedUser(raw, 'u1', 'alice')
  seedPost(raw, { id: 'root', author: 'u1' })
  seedPost(raw, { id: 'r1', author: 'u1', replyTo: 'root', threadRoot: 'root' })
  seedPost(raw, { id: 'r2', author: 'u1', replyTo: 'root', threadRoot: 'root' })
  seedPost(raw, { id: 'r1a', author: 'u1', replyTo: 'r1', threadRoot: 'root' })
  const dto = db.read((tx) => projectItem(tx, 'root', ANON))!
  expect(dto.directReplyCount).toBe(2)
  expect(dto.conversationReplyCount).toBe(3)
})

// ---- river vs activity, applied BEFORE limit (spec §3.5) --------------------

function makeRiver(raw: Raw): void {
  seedUser(raw, 'u1', 'alice')
  // interleave roots and resolved replies by publishedAt so a post-LIMIT filter would short the page
  seedPost(raw, { id: 'root1', author: 'u1', at: '2026-07-23T00:00:06.000Z' })
  seedPost(raw, { id: 'rep1', author: 'u1', replyTo: 'root1', threadRoot: 'root1', at: '2026-07-23T00:00:05.000Z' })
  seedPost(raw, { id: 'root2', author: 'u1', at: '2026-07-23T00:00:04.000Z' })
  seedPost(raw, { id: 'rep2', author: 'u1', replyTo: 'root2', threadRoot: 'root2', at: '2026-07-23T00:00:03.000Z' })
  seedPost(raw, { id: 'root3', author: 'u1', at: '2026-07-23T00:00:02.000Z' })
  seedPost(raw, { id: 'rep3', author: 'u1', replyTo: 'root3', threadRoot: 'root3', at: '2026-07-23T00:00:01.000Z' })
}

test('the Public river excludes resolved replies and applies the predicate before LIMIT (no short page)', async () => {
  const { raw, db } = await fresh()
  makeRiver(raw)
  const env = db.read((tx) => projectTimeline(tx, { lens: { kind: 'public' }, before: null, limit: 2, viewer: ANON }))
  expect(env.timeline.map((d) => d.id)).toEqual(['root1', 'root2']) // 2 roots, not shortened by interleaved replies
  expect(env.nextCursor).not.toBeNull()
  expect(env.timeline.every((d) => d.parentResolutionState !== 'resolved')).toBe(true)
})

test('the local_author activity lens INCLUDES resolved replies', async () => {
  const { raw, db } = await fresh()
  makeRiver(raw)
  const account = { id: 'u1', handle: 'alice', displayName: 'alice' }
  const env = db.read((tx) => projectTimeline(tx, { lens: { kind: 'local_author', account }, before: null, limit: 50, viewer: ANON }))
  expect(env.timeline.map((d) => d.id)).toContain('rep1') // resolved reply present in activity view
  expect(env.timeline.length).toBe(6)
})

test('Personal membership comes from current subscriptions; unsubscribing removes remote items from the river', async () => {
  const { raw, db, store } = await fresh()
  seedUser(raw, 'u1', 'alice')
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  drain(store)
  const account = { id: 'u1', handle: 'alice', displayName: 'alice' }
  const viewer = { localAccountId: 'u1', activeSourceIds: [] }

  seedSubscription(raw, 'u1', 's1')
  const on = db.read((tx) => projectTimeline(tx, { lens: { kind: 'personal', account }, before: null, limit: 50, viewer }))
  expect(on.timeline.some((d) => d.origin === 'remote')).toBe(true)

  raw.prepare(`UPDATE source_subscriptions_v2 SET state = 'pending' WHERE owner_id = 'u1'`).run()
  const off = db.read((tx) => projectTimeline(tx, { lens: { kind: 'personal', account }, before: null, limit: 50, viewer }))
  expect(off.timeline.some((d) => d.origin === 'remote')).toBe(false) // pending does not contribute
})

test('Federated requires an approved federation source', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  drain(store)
  const before = db.read((tx) => projectTimeline(tx, { lens: { kind: 'federated' }, before: null, limit: 50, viewer: ANON }))
  expect(before.timeline.length).toBe(0)
  seedFederation(raw, 's1')
  const after = db.read((tx) => projectTimeline(tx, { lens: { kind: 'federated' }, before: null, limit: 50, viewer: ANON }))
  expect(after.timeline.length).toBe(1)
})

// ---- immutable ordering + opaque versioned cursors (spec §3.3) --------------

test('timeline orders by (timelineSortAt DESC, id DESC) and paginates through the opaque cursor', async () => {
  const { raw, db } = await fresh()
  makeRiver(raw)
  const first = db.read((tx) => projectTimeline(tx, { lens: { kind: 'public' }, before: null, limit: 2, viewer: ANON }))
  expect(first.timeline.map((d) => d.id)).toEqual(['root1', 'root2'])
  const dec = decodeCursor(first.nextCursor as string)!
  const before: TimelineCursorV2 = { version: 1, timelineSortAt: dec.tuple[0], logicalItemId: dec.tuple[1] }
  const second = db.read((tx) => projectTimeline(tx, { lens: { kind: 'public' }, before, limit: 2, viewer: ANON }))
  expect(second.timeline.map((d) => d.id)).toEqual(['root3'])
  expect(second.nextCursor).toBeNull()
})

// ---- unresolved reply keeps ordinary reply context (spec §3.4-3.5) ----------

test('a remote reply to an unknown parent is missing, stays in the river, and exposes asserted external reply context', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  seedJob(raw, { sourceId: 's1', deliveryKey: { kind: 'opaque', key: 'g1' }, material: { content: 'reply body', inReplyTo: 'https://other.test/parent' } })
  drain(store)
  const id = oneRemoteId(raw)
  const dto = db.read((tx) => projectItem(tx, id, ANON))!
  expect(dto.parentResolutionState).toBe('missing')
  expect(dto.parentLogicalItemId).toBeNull()
  expect(dto.replyContext).toEqual({ kind: 'asserted_external', authorLabel: null, snippet: null, url: 'https://other.test/parent' })
  const env = db.read((tx) => projectTimeline(tx, { lens: { kind: 'public' }, before: null, limit: 50, viewer: ANON }))
  expect(env.timeline.map((d) => d.id)).toContain(id) // river includes unresolved replies
})

// ---- blocked source removes ordinary visibility (spec §3.1-3.2) -------------

test('an item whose only source is blocked has no ordinary-eligible delivery and does not project', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  drain(store)
  const id = oneRemoteId(raw)
  raw.prepare(`UPDATE remote_sources_v2 SET governance = 'blocked' WHERE id = 's1'`).run()
  expect(db.read((tx) => projectItem(tx, id, ANON))).toBeUndefined()
  const env = db.read((tx) => projectTimeline(tx, { lens: { kind: 'public' }, before: null, limit: 50, viewer: ANON }))
  expect(env.timeline.length).toBe(0)
})

// ---- history envelope (spec §4.5) -------------------------------------------

test('local history returns the authoritative revision chain with a current marker', async () => {
  const { raw, db } = await fresh()
  seedUser(raw, 'u1', 'alice')
  seedPost(raw, { id: 'p1', author: 'u1', content: 'v2', edited: '2026-07-23T01:00:00.000Z' })
  raw.prepare(`INSERT INTO post_revisions (id, post_id, title, content, content_markdown, seen_at) VALUES (?, 'p1', NULL, 'v1', NULL, ?)`).run(randomUUID(), NOW)
  const env = db.read((tx) => projectHistory(tx, 'p1', ANON))!
  expect(env.origin).toBe('local')
  expect(env.entries.map((e) => e.content)).toEqual(['v1', 'v2'])
  expect(env.entries[env.entries.length - 1].current).toBe(true)
  expect(env.currentSequence).toBe(1)
})

// ---- publisher descriptor (spec §3.6) ---------------------------------------

test('resolvePublisher returns a feed-anchored descriptor for an evidence-backed publisher and undefined otherwise', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  drain(store)
  const pubId = (raw.prepare(`SELECT id FROM remote_publishers_v2 LIMIT 1`).get() as { id: string }).id
  const desc = db.read((tx) => resolvePublisher(tx, pubId))
  expect(desc).toMatchObject({ id: pubId, identityLevel: 'feed_anchored', canonicalFeedUrl: 'https://feed.test/f' })
  expect(db.read((tx) => resolvePublisher(tx, 'no-such-publisher'))).toBeUndefined()
})

// ---- feeds use the central projector (spec §4.6) ----------------------------

test('projectLocalActivity returns local items (roots AND replies) newest-first, remote excluded', async () => {
  const { raw, db, store } = await fresh()
  makeRiver(raw)
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  drain(store)
  const items = db.read((tx) => projectLocalActivity(tx, { authorId: null, limit: 50 }))
  expect(items.every((d) => d.origin === 'local')).toBe(true) // firehose is local-only
  expect(items.map((d) => d.id)).toContain('rep1') // replies transported
  expect(items[0].id).toBe('root1') // newest first
})
