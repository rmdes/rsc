import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { runConversion, type ConversionCounts } from '../src/migration/convert.ts'
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
  for (const t of ['remote_sources_v2', 'remote_publishers_v2', 'federation_relationships_v2', 'source_subscriptions_v2', 'source_audit_v2', 'handle_reservations_v2']) {
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
  const legacyUsers = raw.prepare(`SELECT * FROM users ORDER BY id`).all()
  const legacyFollows = raw.prepare(`SELECT * FROM follows ORDER BY followed_id`).all()

  expect(() => raw.transaction(() => {
    runConversion(raw, { manifest: manifest([{ sourceId: 'u2', feedUrl: 'https://b.test/f.xml' }]), now: NOW, log: () => {} })
    throw new Error('injected fault before the marker') // Task 8 writes marker + reset AFTER this point
  }).immediate()).toThrow('injected fault before the marker')

  for (const t of ['remote_sources_v2', 'remote_publishers_v2', 'federation_relationships_v2', 'source_subscriptions_v2', 'source_audit_v2', 'handle_reservations_v2']) {
    expect(count(raw, t), t).toBe(0)
  }
  expect(raw.prepare(`SELECT * FROM users ORDER BY id`).all()).toEqual(legacyUsers)
  expect(raw.prepare(`SELECT * FROM follows ORDER BY followed_id`).all()).toEqual(legacyFollows)
})
