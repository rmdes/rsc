import { test, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createLogicalPush } from '../src/logical/push.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { projectItem, projectHistory, projectTimeline } from '../src/logical/projector.ts'
import { loadConfig } from '../src/config.ts'
import { runConversion, type ConversionCounts, type ConversionFindingKind } from '../src/migration/convert.ts'
import type { Manifest, ManifestEntry } from '../src/migration/preflight.ts'

// V4 Task 5 — Conversion I: legacy sources, publishers, federation, follows,
// and handle reservations. runConversion is pure SQL over the CALLER's write
// transaction: it opens none, sends no network request, and writes neither the
// marker nor the reset (Task 8 owns both, in the same transaction).
//
// Preflight (Task 4) runs immediately before and aborts startup on any finding,
// so these tests seed only preflight-clean legacy data — the checks it owns
// (URL normalization, collisions, manifest shape/consistency) are not repeated.

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'
const LEGACY_AT = '2026-01-01T00:00:00.000Z'

async function fresh(): Promise<Raw> {
  const repo = await createSqliteRepository(':memory:')
  return repo.raw as Raw
}

const USER_COLS = `id, kind, handle, display_name, feed_url, created_at, feed_type`
function seedRemote(raw: Raw, over: Record<string, string | null> = {}): string {
  const row = {
    id: 'u1', kind: 'remote', handle: 'alice', display_name: 'Alice',
    feed_url: 'https://A.test:443/feed.xml', created_at: LEGACY_AT, feed_type: 'webfeed', ...over,
  }
  raw.prepare(
    `INSERT INTO users (${USER_COLS}) VALUES (@id, @kind, @handle, @display_name, @feed_url, @created_at, @feed_type)`,
  ).run(row)
  return row.id as string
}
function seedLocal(raw: Raw, id = 'l1', handle = 'local'): string {
  raw.prepare(`INSERT INTO users (${USER_COLS}) VALUES (?, 'local', ?, 'Local', NULL, ?, NULL)`).run(id, handle, LEGACY_AT)
  return id
}
function seedFollow(raw: Raw, followerId: string, followedId: string): void {
  raw.prepare(`INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)`).run(followerId, followedId, LEGACY_AT)
}
const manifest = (entries: Partial<ManifestEntry>[]): Manifest => ({
  schemaVersion: 1,
  entries: entries.map((e) => ({ sourceId: 'u1', feedUrl: 'https://A.test:443/feed.xml', attributionMode: 'aggregate', note: 'approved by ops', ...e })),
})

const lines: string[] = []
function convert(raw: Raw, m: Manifest | null = null): ConversionCounts {
  lines.length = 0
  return runConversion(raw, { manifest: m, now: NOW, log: (l) => lines.push(l) })
}

const source = (raw: Raw, id: string) => raw.prepare(`SELECT * FROM remote_sources_v2 WHERE id = ?`).get(id) as Record<string, unknown> | undefined
const count = (raw: Raw, table: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

// ── sources, publishers, federation ──────────────────────────────────────

test('a legacy webfeed becomes an allowed single_publisher source with the SAME id', async () => {
  const raw = await fresh()
  seedRemote(raw)
  const counts = convert(raw)

  expect(source(raw, 'u1')).toMatchObject({
    id: 'u1',
    canonical_url: 'https://a.test/feed.xml', // normalizeSourceUrl: host lowercased, default port dropped
    attribution_mode: 'single_publisher', operation: 'enabled', governance: 'allowed',
    provenance: 'migration', provenance_note: null, admin_retained: 0, policy_generation: 0,
  })
  expect(count(raw, 'federation_relationships_v2')).toBe(0)
  expect(counts.default_webfeed).toBe(1)
  expect(counts.default_person).toBe(0)
})

test('a legacy person converts under the person default', async () => {
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'person' })
  const counts = convert(raw)
  expect(source(raw, 'u1')).toMatchObject({ attribution_mode: 'single_publisher', governance: 'allowed' })
  expect(counts.default_person).toBe(1)
  expect(counts.default_webfeed).toBe(0)
})

test('each source gets a NEW publisher id, never the recycled user id', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml' })
  convert(raw)
  const pubs = raw.prepare(`SELECT * FROM remote_publishers_v2 ORDER BY canonical_feed_url`).all() as Record<string, unknown>[]
  expect(pubs).toHaveLength(2)
  expect(pubs.map((p) => p.id)).not.toContain('u1')
  expect(pubs.map((p) => p.id)).not.toContain('u2')
  expect(new Set(pubs.map((p) => p.id)).size).toBe(2)
  // single_publisher sources are anchored on their own feed URL
  expect(pubs[0]).toMatchObject({ canonical_feed_url: 'https://a.test/feed.xml', identity_level: 'feed_anchored' })
  expect(pubs[1]).toMatchObject({ canonical_feed_url: 'https://b.test/f.xml', identity_level: 'feed_anchored' })
})

test('local accounts keep their ids and handles and gain no source', async () => {
  const raw = await fresh()
  seedLocal(raw)
  seedRemote(raw)
  convert(raw)
  expect(raw.prepare(`SELECT id, kind, handle FROM users WHERE id = 'l1'`).get()).toEqual({ id: 'l1', kind: 'local', handle: 'local' })
  expect(count(raw, 'remote_sources_v2')).toBe(1)
  expect(source(raw, 'l1')).toBeUndefined()
})

test('an unconfirmed instance is quarantined, aggregate, and federation pending', async () => {
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'instance' })
  const counts = convert(raw)
  expect(source(raw, 'u1')).toMatchObject({
    attribution_mode: 'aggregate', operation: 'enabled', governance: 'quarantined', provenance: 'migration', provenance_note: null,
  })
  expect(raw.prepare(`SELECT * FROM federation_relationships_v2 WHERE source_id = 'u1'`).get()).toMatchObject({ status: 'pending', provenance_note: null })
  expect(counts.instance_quarantined).toBe(1)
  expect(counts.manifest_approved).toBe(0)
  // ADJUDICATED (2026-07-24): an aggregate's publisher is feed_anchored on the
  // source's canonical URL too — §3.6 governs over §3.2, see the convergence
  // test at the foot of this file.
  expect(raw.prepare(`SELECT * FROM remote_publishers_v2`).get()).toMatchObject({ canonical_feed_url: 'https://a.test/feed.xml', identity_level: 'feed_anchored' })
})

test('NO manifest means EVERY instance takes the unconfirmed default', async () => {
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'instance' })
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml', feed_type: 'instance' })
  const counts = convert(raw, null)
  for (const id of ['u1', 'u2']) expect(source(raw, id)).toMatchObject({ attribution_mode: 'aggregate', governance: 'quarantined' })
  expect(counts.instance_quarantined).toBe(2)
  expect(counts.manifest_approved).toBe(0)
})

test('a manifest entry approves its instance with the given mode and note', async () => {
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'instance' })
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml', feed_type: 'instance' })
  const counts = convert(raw, manifest([{}]))
  expect(source(raw, 'u1')).toMatchObject({ attribution_mode: 'aggregate', governance: 'allowed', provenance: 'migration', provenance_note: 'approved by ops' })
  expect(raw.prepare(`SELECT * FROM federation_relationships_v2 WHERE source_id = 'u1'`).get()).toMatchObject({ status: 'approved', provenance_note: 'approved by ops' })
  // the unlisted instance still quarantines
  expect(source(raw, 'u2')).toMatchObject({ governance: 'quarantined' })
  expect(counts.manifest_approved).toBe(1)
  expect(counts.instance_quarantined).toBe(1)
})

test('a manifest mode disagreeing with the instance default wins and counts attribution_conflict', async () => {
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'instance' })
  const counts = convert(raw, manifest([{ attributionMode: 'single_publisher' }]))
  // PRECEDENCE: the manifest is the operator's explicit decision — it wins.
  expect(source(raw, 'u1')).toMatchObject({ attribution_mode: 'single_publisher', governance: 'allowed' })
  expect(counts.attribution_conflict).toBe(1)
  expect(counts.manifest_approved).toBe(1)
  expect(lines.join('\n')).toContain('attribution_conflict')
  // a single_publisher approval anchors its publisher on the feed after all
  expect(raw.prepare(`SELECT * FROM remote_publishers_v2`).get()).toMatchObject({ canonical_feed_url: 'https://a.test/feed.xml', identity_level: 'feed_anchored' })
})

test('a manifest mode agreeing with the instance default counts no conflict', async () => {
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'instance' })
  const counts = convert(raw, manifest([{ attributionMode: 'aggregate' }]))
  expect(counts.attribution_conflict).toBe(0)
  expect(counts.manifest_approved).toBe(1)
})

// ── audit (first migration_review emitter) ───────────────────────────────

test('quarantined instances and manifest approvals each write ONE migration_review audit row', async () => {
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'instance' })
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml', feed_type: 'instance' })
  seedRemote(raw, { id: 'u3', handle: 'carol', feed_url: 'https://c.test/f.xml', feed_type: 'person' })
  convert(raw, manifest([{}]))
  const rows = raw.prepare(`SELECT * FROM source_audit_v2 ORDER BY source_id`).all() as Record<string, unknown>[]
  expect(rows.map((r) => r.source_id)).toEqual(['u1', 'u2'])
  for (const r of rows) {
    expect(r.category).toBe('migration_review')
    expect(r.actor_kind).toBe('system')
    expect(r.actor_id).toBe(null)
    expect(String(r.command_id)).toMatch(/^migration:/)
    expect(r.created_at).toBe(NOW)
  }
  // one synthetic command id for the whole conversion
  expect(new Set(rows.map((r) => r.command_id)).size).toBe(1)
})

test('default person/webfeed conversions write NO audit row — counts only', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml', feed_type: 'person' })
  const counts = convert(raw)
  expect(count(raw, 'source_audit_v2')).toBe(0)
  expect(counts.default_webfeed).toBe(1)
  expect(counts.default_person).toBe(1)
})

// ── follows ──────────────────────────────────────────────────────────────

test('local -> local follows are preserved unchanged and make no subscription', async () => {
  const raw = await fresh()
  seedLocal(raw)
  seedLocal(raw, 'l2', 'other')
  seedFollow(raw, 'l1', 'l2')
  convert(raw)
  expect(raw.prepare(`SELECT * FROM follows`).all()).toEqual([{ follower_id: 'l1', followed_id: 'l2', created_at: LEGACY_AT }])
  expect(count(raw, 'source_subscriptions_v2')).toBe(0)
})

test('a follow of a person/webfeed becomes an ACTIVE subscription on the converted source', async () => {
  const raw = await fresh()
  seedLocal(raw)
  seedRemote(raw)
  seedFollow(raw, 'l1', 'u1')
  convert(raw)
  expect(raw.prepare(`SELECT owner_id, source_id, state FROM source_subscriptions_v2`).get())
    .toEqual({ owner_id: 'l1', source_id: 'u1', state: 'active' })
  // the legacy row stays inert, never rewritten
  expect(count(raw, 'follows')).toBe(1)
})

test('EVERY legacy instance follow becomes pending_review, approved or not', async () => {
  const raw = await fresh()
  seedLocal(raw)
  seedRemote(raw, { feed_type: 'instance' })                                                              // manifest-approved
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml', feed_type: 'instance' })    // quarantined
  seedFollow(raw, 'l1', 'u1')
  seedFollow(raw, 'l1', 'u2')
  convert(raw, manifest([{}]))
  const states = raw.prepare(`SELECT source_id, state FROM source_subscriptions_v2 ORDER BY source_id`).all()
  expect(states).toEqual([{ source_id: 'u1', state: 'pending_review' }, { source_id: 'u2', state: 'pending_review' }])
})

test('over-cap users are grandfathered: all follows convert, counted once per user', async () => {
  const raw = await fresh()
  raw.prepare(`UPDATE instance_settings SET value = '2' WHERE key = 'max_subs_per_user'`).run()
  seedLocal(raw)
  seedLocal(raw, 'l2', 'other')
  for (const n of [1, 2, 3]) {
    seedRemote(raw, { id: `u${n}`, handle: `r${n}`, feed_url: `https://r${n}.test/f.xml` })
    seedFollow(raw, 'l1', `u${n}`)
  }
  seedFollow(raw, 'l2', 'u1') // under cap
  const counts = convert(raw)
  expect((raw.prepare(`SELECT COUNT(*) AS n FROM source_subscriptions_v2 WHERE owner_id = 'l1'`).get() as { n: number }).n).toBe(3)
  expect(counts.over_cap_grandfathered).toBe(1)
})

test('a grandfathered user gets no NEW subscription until back under the cap', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  raw.prepare(`UPDATE instance_settings SET value = '2' WHERE key = 'max_subs_per_user'`).run()
  seedLocal(raw)
  for (const n of [1, 2, 3]) {
    seedRemote(raw, { id: `u${n}`, handle: `r${n}`, feed_url: `https://r${n}.test/f.xml` })
    seedFollow(raw, 'l1', `u${n}`)
  }
  convert(raw)
  const res = await repo.resolveAndSubscribeSource({
    command: { actorScope: 'owner', actorId: 'l1', commandId: 'c1', requestFingerprint: 'f1' },
    ownerId: 'l1', canonicalUrl: 'https://new.test/f.xml', cap: 2, now: NOW,
  })
  expect(res.kind).toBe('cap')
})

// ── handle reservations ──────────────────────────────────────────────────

test('every remote handle is reserved against its converted source and publisher', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedLocal(raw)
  convert(raw)
  const res = raw.prepare(`SELECT * FROM handle_reservations_v2`).all() as Record<string, unknown>[]
  expect(res).toHaveLength(1)
  const pub = raw.prepare(`SELECT id FROM remote_publishers_v2`).get() as { id: string }
  expect(res[0]).toEqual({ handle: 'alice', source_id: 'u1', publisher_id: pub.id, created_at: NOW })
})

test('a reservation survives deletion of its source (no FK by design)', async () => {
  const raw = await fresh()
  seedRemote(raw)
  convert(raw)
  raw.prepare(`DELETE FROM remote_sources_v2 WHERE id = 'u1'`).run()
  expect(count(raw, 'remote_sources_v2')).toBe(0)
  expect(count(raw, 'handle_reservations_v2')).toBe(1)
})

// ── post-cutover convergence with the live reconcile ─────────────────────
// The permanent pin for the 2026-07-24 adjudication. reconcile.ts's
// getOrCreatePublisher finds-or-creates by `canonical_feed_url` alone and mints
// 'feed_anchored'; conversion mints on exactly that key, so the FIRST
// post-cutover reconcile of a converted source finds the converted row instead
// of minting a second identity beside it (which would fork the items, orphan
// handle_reservations_v2.publisher_id, and make §3.5's permanent /u/:handle
// redirect point at a publisher projector.ts refuses to resolve).

test('a converted AGGREGATE source reconciles onto its converted publisher — zero new mints', async () => {
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'instance' }) // quarantined aggregate: the §3.2 fallback case
  convert(raw)
  const minted = raw.prepare(`SELECT id, canonical_feed_url, identity_level FROM remote_publishers_v2`).get() as { id: string; canonical_feed_url: string | null; identity_level: string }
  expect(minted).toMatchObject({ canonical_feed_url: 'https://a.test/feed.xml', identity_level: 'feed_anchored' })

  // ...now the live path, unchanged: acquire the source and drain the queue.
  const db = createDatabaseContext(raw)
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><guid isPermaLink="false">g1</guid><title>t</title><description>d</description></item></channel></rss>`
  const eng = createAcquisition({
    db,
    fetchFn: (async () => new Response(feed, { status: 200 })) as unknown as typeof fetch,
    lookupFn: async () => [{ address: '93.184.216.34' }],
    now: () => NOW,
  })
  await eng.acquireSource('u1', { kind: 'scheduled' }, undefined)
  expect(drainReconciliation({ store: createLogicalStore(db), now: () => NOW })).toBe(1)

  // the same row, and only that row
  expect(count(raw, 'remote_publishers_v2')).toBe(1)
  expect((raw.prepare(`SELECT id FROM remote_publishers_v2`).get() as { id: string }).id).toBe(minted.id)
  expect((raw.prepare(`SELECT publisher_id FROM publisher_claims_v2`).get() as { publisher_id: string }).publisher_id).toBe(minted.id)
  // and the permanent reservation still points at the identity the reader serves
  expect((raw.prepare(`SELECT publisher_id FROM handle_reservations_v2`).get() as { publisher_id: string }).publisher_id).toBe(minted.id)
})

// ── zero rows + atomicity ────────────────────────────────────────────────

test('an empty legacy set converts through the same path with all-zero counts', async () => {
  const raw = await fresh()
  const counts = convert(raw)
  expect(Object.values(counts).every((n) => n === 0)).toBe(true)
  for (const t of ['remote_sources_v2', 'remote_publishers_v2', 'federation_relationships_v2', 'source_subscriptions_v2', 'source_audit_v2', 'handle_reservations_v2', 'push_subscriptions_v2']) {
    expect(count(raw, t), t).toBe(0)
  }
})

test('a fault before commit leaves the database legacy-intact — nothing converted', async () => {
  const raw = await fresh()
  seedLocal(raw)
  seedRemote(raw)
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml', feed_type: 'instance' })
  seedFollow(raw, 'l1', 'u1')
  seedFollow(raw, 'l1', 'u2')
  seedPost(raw)
  seedRevision(raw, 'p1', { content: '<p>older</p>' })
  seedPush(raw)
  const legacyUsers = raw.prepare(`SELECT * FROM users ORDER BY id`).all()
  const legacyFollows = raw.prepare(`SELECT * FROM follows ORDER BY followed_id`).all()
  const legacyPosts = raw.prepare(`SELECT * FROM posts ORDER BY id`).all()
  const legacyRevisions = raw.prepare(`SELECT * FROM post_revisions ORDER BY id`).all()

  expect(() => raw.transaction(() => {
    runConversion(raw, { manifest: manifest([{ sourceId: 'u2', feedUrl: 'https://b.test/f.xml' }]), now: NOW, log: () => {} })
    throw new Error('injected fault before the marker') // Task 8 writes marker + reset AFTER this point
  }).immediate()).toThrow('injected fault before the marker')

  // every table family Tasks 5 AND 6 write (V2 Appendix D fault-injection pattern)
  for (const t of [
    'remote_sources_v2', 'remote_publishers_v2', 'federation_relationships_v2', 'source_subscriptions_v2',
    'source_audit_v2', 'handle_reservations_v2', 'logical_items_v2', 'logical_local_origins_v2',
    'logical_identity_keys_v2', 'deliveries_v2', 'observation_versions_v2', 'presentation_entries_v2',
    'publisher_claims_v2', 'logical_conflicts_v2', 'acquisition_runs_v2', 'reconciliation_jobs_v2',
    'push_subscriptions_v2',
  ]) {
    expect(count(raw, t), t).toBe(0)
  }
  expect(raw.prepare(`SELECT * FROM push_subscriptions ORDER BY id`).all()).toHaveLength(1) // the legacy lease is untouched
  expect(raw.prepare(`SELECT * FROM users ORDER BY id`).all()).toEqual(legacyUsers)
  expect(raw.prepare(`SELECT * FROM follows ORDER BY followed_id`).all()).toEqual(legacyFollows)
  expect(raw.prepare(`SELECT * FROM posts ORDER BY id`).all()).toEqual(legacyPosts)
  expect(raw.prepare(`SELECT * FROM post_revisions ORDER BY id`).all()).toEqual(legacyRevisions)
})

// =============================================================================
// V4 Task 6 — Conversion II: items, deliveries, ancestry, revisions
// =============================================================================
// Legacy remote posts become logical items with the SAME post id (so every
// pre-cutover /post/:id keeps resolving), each carrying one delivery on the
// same-ID source, synthetic observation evidence, a claim on the source's
// converted publisher, and an accepted presentation chain. Legacy rows stay
// inert: `posts`/`post_revisions` are never deleted or rewritten.

const POST_COLS = `id, author_id, source, guid, title, content, url, published_at, created_at,
  in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url,
  content_markdown, edited_at, reply_context_author, reply_context_snippet`
const POST_VALS = `@id, @author_id, @source, @guid, @title, @content, @url, @published_at, @created_at,
  @in_reply_to, @in_reply_to_post_id, @thread_root_id, @source_name, @source_feed_url,
  @content_markdown, @edited_at, @reply_context_author, @reply_context_snippet`
const PUBLISHED_AT = '2026-02-01T00:00:00.000Z'
const ARRIVED_AT = '2026-02-01T00:05:00.000Z'

function seedPost(raw: Raw, over: Record<string, string | null> = {}): string {
  const row = {
    id: 'p1', author_id: 'u1', source: 'remote', guid: 'g1', title: 'Title', content: '<p>body</p>',
    url: 'https://a.test/post/1', published_at: PUBLISHED_AT, created_at: ARRIVED_AT,
    in_reply_to: null, in_reply_to_post_id: null, thread_root_id: null,
    source_name: null, source_feed_url: null, content_markdown: null, edited_at: null,
    reply_context_author: null, reply_context_snippet: null, ...over,
  }
  raw.prepare(`INSERT INTO posts (${POST_COLS}) VALUES (${POST_VALS})`).run(row)
  return row.id as string
}
function seedLocalPost(raw: Raw, over: Record<string, string | null> = {}): string {
  return seedPost(raw, { id: 'lp1', author_id: 'l1', source: 'local', guid: 'lg1', url: '/post/lp1', ...over })
}
let revSeq = 0
function seedRevision(raw: Raw, postId: string, over: Record<string, string | null> = {}): void {
  raw.prepare(`INSERT INTO post_revisions (id, post_id, title, content, content_markdown, seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`rev${++revSeq}`, postId, over.title ?? 'Title', over.content ?? '<p>old</p>', over.content_markdown ?? null, over.seen_at ?? '2026-02-02T00:00:00.000Z')
}

const ANON = { localAccountId: null, activeSourceIds: [] }
const one = (raw: Raw, sql: string, ...args: unknown[]) => raw.prepare(sql).get(...args) as Record<string, unknown> | undefined
const all = (raw: Raw, sql: string, ...args: unknown[]) => raw.prepare(sql).all(...args) as Record<string, unknown>[]
const publisherOf = (raw: Raw) => (raw.prepare(`SELECT id FROM remote_publishers_v2 LIMIT 1`).get() as { id: string }).id
const materialOf = (raw: Raw, versionId: string) =>
  JSON.parse((one(raw, `SELECT canonical_material AS m FROM observation_versions_v2 WHERE id = ?`, versionId)!.m as Buffer).toString('utf8')) as Record<string, unknown>

// ── identity: one post, one item, one delivery, one claim ────────────────

test('a legacy remote post becomes a logical item with the SAME post id', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw)
  convert(raw)

  const delivery = one(raw, `SELECT * FROM deliveries_v2`)!
  expect(delivery).toMatchObject({ source_id: 'u1', key_kind: 'opaque', key: 'g1', first_seen_at: ARRIVED_AT, seen_count: 1 })
  expect(one(raw, `SELECT * FROM logical_items_v2 WHERE id = 'p1'`)).toMatchObject({
    id: 'p1', origin: 'remote', timeline_sort_at: PUBLISHED_AT, parent_state: 'none', parent_logical_item_id: null,
    selected_delivery_id: delivery.id, selected_publisher_id: publisherOf(raw), created_at: NOW,
  })
  expect(count(raw, 'logical_items_v2')).toBe(1)
  expect(count(raw, 'observation_versions_v2')).toBe(1)
  // the claim attaches to the SOURCE's converted publisher (2026-07-24 adjudication)
  expect(one(raw, `SELECT * FROM publisher_claims_v2`)).toMatchObject({
    logical_item_id: 'p1', publisher_id: publisherOf(raw), source_id: 'u1',
    evidence_level: 'bound_single_publisher', first_seen_at: NOW,
  })
  // identity keys: the delivery, the permalink, and the publisher-scoped guid
  expect(all(raw, `SELECT kind, key, logical_item_id FROM logical_identity_keys_v2 ORDER BY kind`)).toEqual([
    { kind: 'delivery', key: delivery.id, logical_item_id: 'p1' },
    { kind: `opaque:publisher:${publisherOf(raw)}`, key: 'g1', logical_item_id: 'p1' },
    { kind: 'permalink', key: 'https://a.test/post/1', logical_item_id: 'p1' },
  ])
})

test('a converted item projects as an ordinary logical item', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw, { content_markdown: '# body' })
  convert(raw)

  expect(projectItem(raw, 'p1', ANON)).toMatchObject({
    kind: 'logical_item', id: 'p1', origin: 'remote', parentResolutionState: 'none',
    title: 'Title', content: '<p>body</p>', permalink: 'https://a.test/post/1',
    publishedAt: PUBLISHED_AT, updatedAt: null, updatedAtProvenance: null,
  })
  // and it appears in the public river, not just by id
  expect(projectTimeline(raw, { lens: { kind: 'public' }, before: null, limit: 10, viewer: ANON }).timeline.map((i) => i.id)).toEqual(['p1'])
})

test('legacy posts and revisions stay INERT — never deleted, never rewritten', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw, { edited_at: '2026-02-02T00:00:00.000Z' })
  seedRevision(raw, 'p1')
  const posts = raw.prepare(`SELECT * FROM posts ORDER BY id`).all()
  const revisions = raw.prepare(`SELECT * FROM post_revisions ORDER BY id`).all()
  convert(raw)
  expect(raw.prepare(`SELECT * FROM posts ORDER BY id`).all()).toEqual(posts)
  expect(raw.prepare(`SELECT * FROM post_revisions ORDER BY id`).all()).toEqual(revisions)
})

test('local posts convert to no remote item and no delivery', async () => {
  const raw = await fresh()
  seedLocal(raw)
  seedRemote(raw)
  seedLocalPost(raw)
  convert(raw)
  expect(count(raw, 'logical_items_v2')).toBe(0)
  expect(count(raw, 'deliveries_v2')).toBe(0)
})

// ── the synthetic observation evidence contract (FC2) ────────────────────

test('the migration observation is a MARKED synthetic envelope built from the post', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw, { content_markdown: '# body', in_reply_to: 'https://other.test/p/9', source_name: 'A', reply_context_author: 'bob', reply_context_snippet: 'hi' })
  convert(raw)

  const v = one(raw, `SELECT * FROM observation_versions_v2`)!
  // canonical_material: the post's own fields, under a synthetic marker
  expect(materialOf(raw, v.id as string)).toMatchObject({
    synthetic: 'migration', keyKind: 'opaque', key: 'g1',
    title: 'Title', content: '<p>body</p>', link: 'https://a.test/post/1',
    published: PUBLISHED_AT, inReplyTo: 'https://other.test/p/9', enclosures: [],
  })
  expect(JSON.parse(v.normalized_json as string)).toMatchObject({
    synthetic: 'migration', keyKind: 'opaque', key: 'g1',
    permalink: 'https://a.test/post/1', inReplyTo: 'https://other.test/p/9',
    contentMarkdown: '# body', replyContext: { author: 'bob', snippet: 'hi' },
  })
  expect(JSON.parse(v.raw_evidence_json as string)).toMatchObject({ synthetic: 'migration', title: 'Title', sourceName: 'A', link: 'https://a.test/post/1' })
})

test('the migration observation takes the DEFINED synthetic run/ordinal/seen values', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw)
  convert(raw)

  const v = one(raw, `SELECT * FROM observation_versions_v2`)!
  expect(v).toMatchObject({
    fingerprint_version: 1, wire_ordinal: 0, seen_count: 1,
    arrival_at: ARRIVED_AT, last_seen_at: NOW, last_seen_run_id: v.run_id,
  })
  expect(String(v.run_id)).toMatch(/^migration:/)
  // the synthetic run is terminal and belongs to the converted source, so the
  // arrival tuple every comparator reads is complete
  expect(one(raw, `SELECT * FROM acquisition_runs_v2 WHERE id = ?`, v.run_id)).toMatchObject({
    source_id: 'u1', reason: 'scheduled', status: 'terminal', outcome: 'parsed',
    acquisition_committed_at: NOW, delivery_mechanism: null,
  })
  // a reconciled observation job — the version is ordinary-eligible immediately
  expect(one(raw, `SELECT * FROM reconciliation_jobs_v2`)).toMatchObject({
    kind: 'observation', run_id: v.run_id, observation_version_id: v.id, status: 'reconciled', attempts: 0,
  })
  expect(one(raw, `SELECT * FROM deliveries_v2`)).toMatchObject({ last_seen_run_id: v.run_id, last_seen_at: NOW, seen_count: 1 })
})

// ── attribution ─────────────────────────────────────────────────────────

test('per-item attribution naming a DIFFERENT feed on a bound source counts attribution_conflict', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw, { source_name: 'Elsewhere', source_feed_url: 'https://elsewhere.test/feed.xml' })
  const counts = convert(raw)

  expect(counts.attribution_conflict).toBe(1)
  expect(one(raw, `SELECT * FROM logical_conflicts_v2`)).toMatchObject({ logical_item_id: 'p1', kind: 'attribution_conflict' })
  // the BOUND publisher still wins, and no second publisher is minted
  expect(one(raw, `SELECT * FROM publisher_claims_v2`)).toMatchObject({ publisher_id: publisherOf(raw), evidence_level: 'bound_single_publisher' })
  expect(count(raw, 'remote_publishers_v2')).toBe(1)
  expect(lines.join('\n')).toContain('attribution_conflict')
})

test('per-item attribution AGREEING with the bound source is no conflict', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw, { source_name: 'A', source_feed_url: 'https://A.test:443/feed.xml' })
  const counts = convert(raw)
  expect(counts.attribution_conflict).toBe(0)
  expect(count(raw, 'logical_conflicts_v2')).toBe(0)
})

test('an aggregate item claims the source publisher at aggregate_assertion, origin preserved for verification', async () => {
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'instance' })
  seedPost(raw, { source_name: 'Origin', source_feed_url: 'https://origin.test/feed.xml' })
  const counts = convert(raw, manifest([{}])) // approved aggregate, so it stays ordinary-eligible

  expect(one(raw, `SELECT * FROM publisher_claims_v2`)).toMatchObject({ publisher_id: publisherOf(raw), evidence_level: 'aggregate_assertion' })
  expect(count(raw, 'remote_publishers_v2')).toBe(1)
  // per-item attribution is EXPECTED on an aggregate — no conflict, and the origin
  // URL is retained so post-cutover verification can fetch it LIVE.
  expect(counts.attribution_conflict).toBe(0)
  const v = one(raw, `SELECT normalized_json FROM observation_versions_v2`)!
  expect(JSON.parse(v.normalized_json as string).originFeedUrl).toBe('https://origin.test/feed.xml')
})

test("a quarantined instance's items convert as retained admin evidence, ordinarily invisible", async () => {
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'instance' }) // no manifest ⇒ quarantined
  seedPost(raw)
  convert(raw)
  expect(count(raw, 'logical_items_v2')).toBe(1)
  expect(count(raw, 'publisher_claims_v2')).toBe(1)
  expect(projectItem(raw, 'p1', ANON)).toBeUndefined()
  expect(projectTimeline(raw, { lens: { kind: 'public' }, before: null, limit: 10, viewer: ANON }).timeline).toEqual([])
})

// ── ancestry ────────────────────────────────────────────────────────────

test('a resolved legacy remote reply edge copies as a resolved logical parent edge', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw)
  seedPost(raw, { id: 'p2', guid: 'g2', url: 'https://a.test/post/2', in_reply_to: 'https://a.test/post/1', in_reply_to_post_id: 'p1', thread_root_id: 'p1' })
  const counts = convert(raw)

  expect(one(raw, `SELECT * FROM logical_items_v2 WHERE id = 'p2'`)).toMatchObject({ parent_state: 'resolved', parent_logical_item_id: 'p1' })
  expect(counts.unresolved_reference).toBe(0)
  expect(projectItem(raw, 'p2', ANON)).toMatchObject({ parentResolutionState: 'resolved', parentLogicalItemId: 'p1', threadRootId: 'p1' })
})

test('a legacy reply to a LOCAL parent materializes the local bridge row and resolves', async () => {
  const raw = await fresh()
  seedLocal(raw)
  seedRemote(raw)
  seedLocalPost(raw)
  seedPost(raw, { id: 'p2', guid: 'g2', url: 'https://a.test/post/2', in_reply_to: '/post/lp1', in_reply_to_post_id: 'lp1' })
  convert(raw)

  expect(one(raw, `SELECT * FROM logical_local_origins_v2`)).toEqual({ logical_item_id: 'lp1', post_id: 'lp1' })
  expect(one(raw, `SELECT origin FROM logical_items_v2 WHERE id = 'lp1'`)).toEqual({ origin: 'local' })
  expect(one(raw, `SELECT * FROM logical_items_v2 WHERE id = 'p2'`)).toMatchObject({ parent_state: 'resolved', parent_logical_item_id: 'lp1' })
})

// A remote reply whose local parent is ITSELF a reply to a local root: the
// ancestry backfill must materialize the WHOLE chain (lp1 root, then lp2), not
// just the direct parent — materializeLocalPost alone would try to insert lp2's
// bridge row with parent_logical_item_id = 'lp1' while lp1 has no logical row
// yet, which FOREIGN KEY constraint failed's (schema.ts's self-FK on
// logical_items_v2, foreign_keys=ON) during this pre-listen transaction. This is
// the load-bearing half of the cutover fix (convert.ts's ancestry pass routing
// through the shared materializeLocalChain instead).
test('a remote reply to a local reply, whose OWN parent is a local root, materializes the whole chain and resolves', async () => {
  const raw = await fresh()
  seedLocal(raw)
  seedRemote(raw)
  seedLocalPost(raw) // lp1: local root
  seedLocalPost(raw, { id: 'lp2', guid: 'lg2', url: '/post/lp2', in_reply_to: '/post/lp1', in_reply_to_post_id: 'lp1', thread_root_id: 'lp1' }) // lp2: local reply to lp1
  seedPost(raw, { id: 'p2', guid: 'g2', url: 'https://a.test/post/2', in_reply_to: '/post/lp2', in_reply_to_post_id: 'lp2' }) // remote reply to lp2
  convert(raw)

  expect(one(raw, `SELECT * FROM logical_local_origins_v2 WHERE post_id = 'lp1'`)).toEqual({ logical_item_id: 'lp1', post_id: 'lp1' })
  expect(one(raw, `SELECT * FROM logical_local_origins_v2 WHERE post_id = 'lp2'`)).toEqual({ logical_item_id: 'lp2', post_id: 'lp2' })
  expect(one(raw, `SELECT parent_state, parent_logical_item_id FROM logical_items_v2 WHERE id = 'lp2'`)).toEqual({ parent_state: 'resolved', parent_logical_item_id: 'lp1' })
  expect(one(raw, `SELECT parent_state, parent_logical_item_id FROM logical_items_v2 WHERE id = 'p2'`)).toEqual({ parent_state: 'resolved', parent_logical_item_id: 'lp2' })
})

test('a reply whose parent post is GONE converts to missing and counts unresolved_reference', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw, { in_reply_to: 'https://a.test/post/0', in_reply_to_post_id: 'ghost' })
  const counts = convert(raw)

  expect(one(raw, `SELECT * FROM logical_items_v2 WHERE id = 'p1'`)).toMatchObject({ parent_state: 'missing', parent_logical_item_id: null })
  expect(counts.unresolved_reference).toBe(1)
  expect(lines.join('\n')).toContain('unresolved_reference')
  // the bounded asserted context survives as the reply-context the projector shows
  expect(projectItem(raw, 'p1', ANON)).toMatchObject({
    parentResolutionState: 'missing',
    replyContext: { kind: 'asserted_external', url: 'https://a.test/post/0', authorLabel: null, snippet: null },
  })
})

test('an UNRESOLVED raw legacy reference converts to missing and counts unresolved_reference', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw, { in_reply_to: 'https://elsewhere.test/p/1' }) // never resolved by legacy ingest
  const counts = convert(raw)
  expect(one(raw, `SELECT * FROM logical_items_v2 WHERE id = 'p1'`)).toMatchObject({ parent_state: 'missing' })
  expect(counts.unresolved_reference).toBe(1)
})

test('a self-referential legacy edge is never copied — missing, counted, no cycle', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw, { in_reply_to: 'https://a.test/post/1', in_reply_to_post_id: 'p1' })
  const counts = convert(raw)
  expect(one(raw, `SELECT * FROM logical_items_v2 WHERE id = 'p1'`)).toMatchObject({ parent_state: 'missing', parent_logical_item_id: null })
  expect(counts.unresolved_reference).toBe(1)
})

test('two converted items sharing a permalink are BOTH kept and count permalink_collision', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml' })
  seedPost(raw)
  seedPost(raw, { id: 'p2', author_id: 'u2', guid: 'g2' }) // same url as p1
  const counts = convert(raw)

  expect(counts.permalink_collision).toBe(1)
  expect(lines.join('\n')).toContain('permalink_collision')
  // BOTH items are kept, and exactly one owns the contested key
  expect(all(raw, `SELECT id FROM logical_items_v2 ORDER BY id`)).toEqual([{ id: 'p1' }, { id: 'p2' }])
  expect(all(raw, `SELECT logical_item_id FROM logical_identity_keys_v2 WHERE kind = 'permalink'`)).toEqual([{ logical_item_id: 'p1' }])
  expect(projectItem(raw, 'p2', ANON)).toMatchObject({ id: 'p2' })
})

test('distinct permalinks count NO collision', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml' })
  seedPost(raw)
  seedPost(raw, { id: 'p2', author_id: 'u2', guid: 'g2', url: 'https://b.test/post/2' })
  const counts = convert(raw)
  expect(counts.permalink_collision).toBe(0)
  expect(counts.guid_collision).toBe(0)
})

// ── revisions → the accepted presentation chain ─────────────────────────

test('legacy revisions convert into the accepted chain in seen_at order as legacy_unknown', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw, { content: '<p>v3</p>', edited_at: '2026-02-04T00:00:00.000Z' })
  seedRevision(raw, 'p1', { content: '<p>v2</p>', seen_at: '2026-02-04T00:00:00.000Z' })
  seedRevision(raw, 'p1', { content: '<p>v1</p>', seen_at: '2026-02-03T00:00:00.000Z' })
  convert(raw)

  const entries = all(raw, `SELECT sequence, observation_version_id, effective_updated_at, provenance FROM presentation_entries_v2 ORDER BY sequence`)
  expect(entries.map((e) => e.sequence)).toEqual([0, 1, 2])
  expect(entries.map((e) => e.provenance)).toEqual(['legacy_unknown', 'legacy_unknown', 'legacy_unknown'])
  expect(entries.map((e) => e.effective_updated_at)).toEqual(['2026-02-03T00:00:00.000Z', '2026-02-04T00:00:00.000Z', '2026-02-04T00:00:00.000Z'])
  // oldest revision first, current post last — each on its OWN observation version
  expect(entries.map((e) => materialOf(raw, e.observation_version_id as string).content)).toEqual(['<p>v1</p>', '<p>v2</p>', '<p>v3</p>'])
  expect(new Set(entries.map((e) => e.observation_version_id)).size).toBe(3)
  expect(count(raw, 'observation_versions_v2')).toBe(3)
  expect(count(raw, 'reconciliation_jobs_v2')).toBe(3)
})

test('the wire updatedAtProvenance of a converted edited item reads legacy_unknown', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw, { content: '<p>new</p>', edited_at: '2026-02-04T00:00:00.000Z' })
  seedRevision(raw, 'p1', { content: '<p>old</p>', seen_at: '2026-02-04T00:00:00.000Z' })
  convert(raw)
  expect(projectItem(raw, 'p1', ANON)).toMatchObject({
    content: '<p>new</p>', updatedAt: '2026-02-04T00:00:00.000Z', updatedAtProvenance: 'legacy_unknown',
  })
  const history = projectHistory(raw, 'p1', ANON)!
  expect(history.entries.map((e) => e.content)).toEqual(['<p>old</p>', '<p>new</p>'])
  expect(history.entries.map((e) => e.updatedAtProvenance)).toEqual(['legacy_unknown', 'legacy_unknown'])
})

test('legacy_unknown never initializes the explicit-update watermark', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw, { edited_at: '2026-02-04T00:00:00.000Z' })
  seedRevision(raw, 'p1', { seen_at: '2026-02-04T00:00:00.000Z' })
  convert(raw)
  // the ONE query applyPresentation reads as the watermark
  expect(one(raw, `SELECT MAX(effective_updated_at) AS w FROM presentation_entries_v2 WHERE provenance = 'explicit'`)).toEqual({ w: null })
})

test('a post-cutover explicit update starts the watermark FRESH above the legacy chain', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPost(raw, { content: '<p>legacy</p>', edited_at: '2026-02-04T00:00:00.000Z' })
  seedRevision(raw, 'p1', { content: '<p>older</p>', seen_at: '2026-02-04T00:00:00.000Z' })
  convert(raw)

  const db = createDatabaseContext(raw)
  const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>A</title>`
    + `<item><guid isPermaLink="false">g1</guid><link>https://a.test/post/1</link><title>Title</title>`
    + `<description>&lt;p&gt;fresh&lt;/p&gt;</description><atom:updated>2026-02-05T00:00:00Z</atom:updated></item></channel></rss>`
  const eng = createAcquisition({
    db,
    fetchFn: (async () => new Response(feed, { status: 200 })) as unknown as typeof fetch,
    lookupFn: async () => [{ address: '93.184.216.34' }],
    now: () => NOW,
  })
  await eng.acquireSource('u1', { kind: 'scheduled' }, undefined)
  expect(drainReconciliation({ store: createLogicalStore(db), now: () => NOW })).toBe(1)

  // ONE delivery still — the converted key was found, not forked
  expect(count(raw, 'deliveries_v2')).toBe(1)
  expect(count(raw, 'logical_items_v2')).toBe(1)
  const top = one(raw, `SELECT sequence, effective_updated_at, provenance FROM presentation_entries_v2 ORDER BY sequence DESC LIMIT 1`)!
  expect(top).toMatchObject({ sequence: 2, provenance: 'explicit', effective_updated_at: '2026-02-05T00:00:00.000Z' })
})

// ── zero rows ───────────────────────────────────────────────────────────

test('a legacy set with no posts writes no item family at all', async () => {
  const raw = await fresh()
  seedRemote(raw)
  convert(raw)
  for (const t of ['logical_items_v2', 'deliveries_v2', 'observation_versions_v2', 'presentation_entries_v2',
    'publisher_claims_v2', 'logical_identity_keys_v2', 'acquisition_runs_v2', 'reconciliation_jobs_v2']) {
    expect(count(raw, t), t).toBe(0)
  }
})

// =============================================================================
// V4 Task 7 — Conversion III: exact push preservation and the findings contract
// =============================================================================
// A hub's in-flight lease must keep delivering ACROSS cutover with no
// re-subscription: protocol, endpoint, topic, callback token, secret, state,
// expiry and creation time all survive byte-exact, so the next fat ping
// authenticates against the converted row (spec §3.4).
//
// THE WP1 PIN: an expired or unusable legacy row is a FINDING — counted,
// logged, and dropped. push_subscriptions_v2.state is a two-value CHECK
// precisely so migration cannot resurrect such a row in a third state; the
// poll pass re-registers from the latest run's capability claim instead.

const HUB = 'https://hub.test/hub'
const CLOUD = 'http://a.test:5337/rsscloud/pleaseNotify'
const LEASE_UNTIL = '2026-08-01T00:00:00.000Z' // > NOW
const LAPSED_AT = '2026-07-01T00:00:00.000Z' // < NOW
const PUSH_COLS = `id, user_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at`
const PUSH_VALS = `@id, @user_id, @mode, @endpoint, @topic, @callback_token, @secret, @state, @expires_at, @created_at`

let pushSeq = 0
function seedPush(raw: Raw, over: Record<string, string | null> = {}): Record<string, string | null> {
  const row = {
    id: `ps${++pushSeq}`, user_id: 'u1', mode: 'websub', endpoint: HUB,
    // the LEGACY topic string verbatim — the hub echoes it back, so conversion
    // must NOT renormalize it onto the source's canonical_url
    topic: 'https://A.test:443/feed.xml',
    callback_token: `cb-${pushSeq}`, secret: `sec-${pushSeq}`, state: 'active',
    expires_at: LEASE_UNTIL, created_at: LEGACY_AT, ...over,
  }
  raw.prepare(`INSERT INTO push_subscriptions (${PUSH_COLS}) VALUES (${PUSH_VALS})`).run(row)
  return row
}
const PRESERVED = ['id', 'mode', 'endpoint', 'topic', 'callback_token', 'secret', 'state', 'expires_at', 'created_at']
const pushV2 = (raw: Raw, sourceId = 'u1') => one(raw, `SELECT * FROM push_subscriptions_v2 WHERE source_id = ?`, sourceId)
const kindLines = (kind: string): string[] => lines.filter((l) => l.startsWith(`${kind}: `))

// ── exact preservation ──────────────────────────────────────────────────

test('an unexpired legacy lease converts byte-exact onto the same-ID source', async () => {
  const raw = await fresh()
  seedRemote(raw)
  const legacy = seedPush(raw)
  const counts = convert(raw)

  const v2 = pushV2(raw)!
  for (const col of PRESERVED) expect(v2[col], col).toBe(legacy[col]) // byte-exact, spec §3.4
  expect(v2.source_id).toBe('u1')
  expect(counts.push_preserved).toBe(1)
  expect(counts.push_expired).toBe(0)
  expect(counts.push_invalid).toBe(0)
  expect(kindLines('push_preserved')).toHaveLength(1)
  expect(count(raw, 'push_subscriptions_v2')).toBe(1)
})

test('a PENDING lease stays pending and a secret-less rsscloud lease keeps its NULL secret', async () => {
  const raw = await fresh()
  seedRemote(raw)
  const pending = seedPush(raw, { state: 'pending' })
  const cloud = seedPush(raw, { mode: 'rsscloud', endpoint: CLOUD, secret: null })
  const counts = convert(raw)

  const rows = all(raw, `SELECT * FROM push_subscriptions_v2 ORDER BY mode`)
  expect(rows).toHaveLength(2)
  const [rsscloud, websub] = rows
  for (const col of PRESERVED) expect(websub[col], col).toBe(pending[col])
  for (const col of PRESERVED) expect(rsscloud[col], col).toBe(cloud[col])
  expect(websub.state).toBe('pending')
  expect(rsscloud.secret).toBeNull()
  expect(counts.push_preserved).toBe(2)
})

test('a QUARANTINED source retains its active lease — governance alone makes it admin-only', async () => {
  const raw = await fresh()
  seedRemote(raw, { feed_type: 'instance' }) // no manifest: quarantined
  const legacy = seedPush(raw)
  const counts = convert(raw)
  expect(source(raw, 'u1')).toMatchObject({ governance: 'quarantined' })
  for (const col of PRESERVED) expect(pushV2(raw)![col], col).toBe(legacy[col])
  expect(counts.push_preserved).toBe(1)
})

// ── expired: a finding, never a row ─────────────────────────────────────

test('an EXPIRED lease converts to NO live row and counts push_expired', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml' })
  seedPush(raw, { expires_at: LAPSED_AT })
  seedPush(raw, { user_id: 'u2', expires_at: NOW }) // boundary: expiry AT now is expired (v1 `expires_at > now`)
  const counts = convert(raw)

  expect(count(raw, 'push_subscriptions_v2')).toBe(0)
  expect(counts.push_expired).toBe(2)
  expect(counts.push_preserved).toBe(0)
  expect(counts.push_invalid).toBe(0)
  expect(kindLines('push_expired')).toHaveLength(2)
})

test('a lease that is BOTH expired and unusable is counted once, as expired', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPush(raw, { expires_at: LAPSED_AT, endpoint: 'http://127.0.0.1/hub' })
  const counts = convert(raw)
  expect(counts.push_expired).toBe(1)
  expect(counts.push_invalid).toBe(0)
  expect(count(raw, 'push_subscriptions_v2')).toBe(0)
})

// ── revalidation: a finding, never a row ────────────────────────────────

test('a lease whose endpoint fails revalidation converts to NO live row and counts push_invalid', async () => {
  const raw = await fresh()
  const bad = ['not a url', 'ftp://hub.test/hub', 'http://localhost:4000/hub', 'http://127.0.0.1/hub', 'http://192.168.1.10/hub', 'http://[::1]/hub']
  bad.forEach((endpoint, i) => {
    seedRemote(raw, { id: `u${i}`, handle: `r${i}`, feed_url: `https://r${i}.test/f.xml` })
    seedPush(raw, { user_id: `u${i}`, endpoint })
  })
  const counts = convert(raw)

  expect(count(raw, 'push_subscriptions_v2')).toBe(0)
  expect(counts.push_invalid).toBe(bad.length)
  expect(counts.push_preserved).toBe(0)
  expect(kindLines('push_invalid')).toHaveLength(bad.length)
})

test('an ordinary DOMAIN endpoint is not mistaken for a private host', async () => {
  const raw = await fresh()
  seedRemote(raw)
  // fd… / fe8… are IPv6 private PREFIXES, not domain prefixes: a hostname that
  // merely starts with those letters is public and its lease must survive.
  seedPush(raw, { endpoint: 'https://fdhub.example/hub' })
  const counts = convert(raw)
  expect(counts.push_preserved).toBe(1)
  expect(counts.push_invalid).toBe(0)
})

test('a legacy state or protocol the two-state CHECK rejects is DROPPED, never resurrected (WP1)', async () => {
  const raw = await fresh()
  const rejected: Record<string, string>[] = [{ state: 'expired' }, { state: 'invalid' }, { state: 'unsubscribed' }, { mode: 'webmention' }]
  rejected.forEach((over, i) => {
    seedRemote(raw, { id: `u${i}`, handle: `r${i}`, feed_url: `https://r${i}.test/f.xml` })
    seedPush(raw, { user_id: `u${i}`, ...over })
  })
  const counts = convert(raw)

  // the whole point of the narrow CHECK: no third state exists to carry them into
  expect(all(raw, `SELECT state FROM push_subscriptions_v2`)).toEqual([])
  expect(counts.push_invalid).toBe(rejected.length)
  expect(kindLines('push_invalid')).toHaveLength(rejected.length)
})

test('a lease whose user is not a converted remote source is dropped and counted', async () => {
  const raw = await fresh()
  seedLocal(raw)
  seedPush(raw, { user_id: 'l1' })
  const counts = convert(raw)
  expect(count(raw, 'push_subscriptions_v2')).toBe(0)
  expect(counts.push_invalid).toBe(1)
})

// ── no network, ever ────────────────────────────────────────────────────

test('conversion sends NO subscribe, unsubscribe, verify or fetch — zero fetch calls', async () => {
  const raw = await fresh()
  seedLocal(raw)
  seedRemote(raw)
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml', feed_type: 'instance' })
  seedFollow(raw, 'l1', 'u1')
  seedPost(raw)
  seedPush(raw)
  seedPush(raw, { user_id: 'u2', endpoint: 'http://127.0.0.1/hub' })

  const spy = vi.spyOn(globalThis, 'fetch')
  try {
    const counts = convert(raw, manifest([{ sourceId: 'u2', feedUrl: 'https://b.test/f.xml' }]))
    expect(counts.push_preserved).toBe(1)
  } finally {
    spy.mockRestore()
  }
  expect(spy).not.toHaveBeenCalled()
})

// ── the whole point: the legacy lease still delivers after cutover ───────

test('a fat ping signed with the LEGACY secret authenticates against the converted row and ingests', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  seedLocal(raw)
  seedRemote(raw)
  seedFollow(raw, 'l1', 'u1') // makes the converted source schedulable, hence push-eligible
  const legacy = seedPush(raw, { callback_token: 'legacy-token', secret: 'legacy-secret', topic: 'https://a.test/feed.xml' })
  convert(raw)
  expect(pushV2(raw)!.callback_token).toBe(legacy.callback_token)

  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  // refusing fetch: a fat ping carries its own document — the path must not fetch
  const fetchFn = (async (input: string | URL | Request) => {
    throw new Error(`unexpected fetch: ${String(input)}`)
  }) as unknown as typeof fetch
  const acquisition = createAcquisition({ db, fetchFn, lookupFn: async () => [{ address: '93.184.216.34' }], now: () => NOW })
  const push = createLogicalPush({
    db, store, acquisition, fetchFn, lookupFn: async () => [{ address: '93.184.216.34' }],
    config: loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://rsc.test' }),
  })

  const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>A</title>`
    + `<item><guid isPermaLink="false">g-after-cutover</guid><title>t</title><description>d</description></item></channel></rss>`
  const signature = `sha256=${createHmac('sha256', 'legacy-secret').update(body).digest('hex')}`

  expect(await push.websubDeliver('legacy-token', body, signature)).toBe(202)
  expect(one(raw, `SELECT reason, delivery_mechanism FROM acquisition_runs_v2 WHERE id NOT LIKE 'migration:%'`))
    .toMatchObject({ reason: 'scheduled', delivery_mechanism: 'push' })
  expect(one(raw, `SELECT id FROM deliveries_v2 WHERE key = 'g-after-cutover'`)).toBeDefined()
  expect(drainReconciliation({ store, now: () => NOW })).toBe(1)
  expect(count(raw, 'logical_items_v2')).toBe(1)
  repo.close()
})

test('a WRONG secret against a converted row is still a silent 202 that ingests nothing', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  seedLocal(raw)
  seedRemote(raw)
  seedFollow(raw, 'l1', 'u1')
  seedPush(raw, { callback_token: 'legacy-token', secret: 'legacy-secret', topic: 'https://a.test/feed.xml' })
  convert(raw)

  const db = createDatabaseContext(raw)
  const fetchFn = (async () => { throw new Error('unexpected fetch') }) as unknown as typeof fetch
  const acquisition = createAcquisition({ db, fetchFn, lookupFn: async () => [{ address: '93.184.216.34' }], now: () => NOW })
  const push = createLogicalPush({
    db, store: createLogicalStore(db), acquisition, fetchFn, lookupFn: async () => [{ address: '93.184.216.34' }],
    config: loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://rsc.test' }),
  })
  const body = `<?xml version="1.0"?><rss version="2.0"><channel><title>A</title><item><guid>g9</guid><title>t</title><description>d</description></item></channel></rss>`
  expect(await push.websubDeliver('legacy-token', body, `sha256=${createHmac('sha256', 'wrong').update(body).digest('hex')}`)).toBe(202)
  expect(count(raw, 'deliveries_v2')).toBe(0)
  repo.close()
})

// ── the findings contract (spec §3.6) ───────────────────────────────────
// Counts ARE the operator report: WP2 deleted the findings relation and the
// report route, so a miscount is the only signal an operator would ever get
// that something did not survive.

const ALL_KINDS: ConversionFindingKind[] = [
  'default_person', 'default_webfeed', 'instance_quarantined', 'manifest_approved',
  'attribution_conflict', 'unresolved_reference', 'permalink_collision', 'guid_collision',
  'push_preserved', 'push_expired', 'push_invalid', 'over_cap_grandfathered',
]

test('runConversion returns the COMPLETE per-kind counts, and every count emitted its log lines', async () => {
  const raw = await fresh()
  raw.prepare(`UPDATE instance_settings SET value = '1' WHERE key = 'max_subs_per_user'`).run()
  seedLocal(raw)
  seedRemote(raw) // default_webfeed
  seedRemote(raw, { id: 'u2', handle: 'bob', feed_url: 'https://b.test/f.xml', feed_type: 'person' }) // default_person
  seedRemote(raw, { id: 'u3', handle: 'inst', feed_url: 'https://c.test/f.xml', feed_type: 'instance' }) // instance_quarantined
  seedRemote(raw, { id: 'u4', handle: 'appr', feed_url: 'https://d.test/f.xml', feed_type: 'instance' }) // manifest_approved + attribution_conflict
  for (const id of ['u1', 'u2', 'u3']) seedFollow(raw, 'l1', id) // over_cap_grandfathered
  seedPost(raw, { source_feed_url: 'https://elsewhere.test/f.xml' }) // attribution_conflict (bound source)
  seedPost(raw, { id: 'p2', guid: 'g2', url: 'https://a.test/post/1' }) // permalink_collision with p1
  seedPost(raw, { id: 'p3', guid: 'g3', url: 'https://a.test/post/3', in_reply_to: 'https://gone.test/x' }) // unresolved_reference
  seedPush(raw) // push_preserved
  seedPush(raw, { user_id: 'u2', expires_at: LAPSED_AT }) // push_expired
  seedPush(raw, { user_id: 'u3', endpoint: 'http://127.0.0.1/hub' }) // push_invalid

  const counts = convert(raw, manifest([{ sourceId: 'u4', feedUrl: 'https://d.test/f.xml', attributionMode: 'single_publisher' }]))

  // complete: exactly the declared kinds, no more, no fewer
  expect(new Set(Object.keys(counts))).toEqual(new Set(ALL_KINDS))
  // every non-aborting finding emitted exactly one log line per occurrence
  for (const kind of ALL_KINDS) expect(kindLines(kind).length, kind).toBe(counts[kind])
  // and every kind this scenario triggers is actually counted
  for (const kind of ALL_KINDS) {
    if (kind === 'guid_collision') continue // structurally unreachable (plan Task 6 correction)
    expect(counts[kind], kind).toBeGreaterThan(0)
  }
  expect(counts.guid_collision).toBe(0)
})

test('there is NO findings relation — the returned counts and the log lines are the whole report', async () => {
  const raw = await fresh()
  seedRemote(raw)
  seedPush(raw, { expires_at: LAPSED_AT })
  convert(raw)
  const tables = all(raw, `SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name as string)
  // acquisition_findings_v2 is V2's per-RUN acquisition findings and predates
  // this vertical; nothing else finding-shaped exists, and nothing conversion
  // writes lands in it.
  expect(tables.filter((n) => /finding|report/i.test(n))).toEqual(['acquisition_findings_v2'])
  expect(count(raw, 'acquisition_findings_v2')).toBe(0)
})
