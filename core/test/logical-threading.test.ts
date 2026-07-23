import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { resolveInitialParent } from '../src/logical/threading.ts'
import type { NormalizedReplyReference } from '../src/logical/types.ts'

type Raw = InstanceType<typeof Database>

const NOW = '2026-07-23T00:00:00.000Z'

function count(raw: Raw, table: string): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

// A bare logical item row (no local origin, no content) — enough to be a parent
// candidate or a new item awaiting ancestry. parent chains an existing item.
function seedItem(raw: Raw, id: string, parent: string | null = null): void {
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at)
     VALUES (?, 'remote', ?, ?, ?, NULL, NULL, ?)`,
  ).run(id, NOW, parent ? 'resolved' : 'none', parent, NOW)
}

function seedPermalink(raw: Raw, permalink: string, logicalItemId: string): void {
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('permalink', ?, ?)`).run(permalink, logicalItemId)
}

function seedScopedOpaque(raw: Raw, sourceId: string, key: string, logicalItemId: string): void {
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES (?, ?, ?)`).run(`opaque:source:${sourceId}`, key, logicalItemId)
}

// A minimal observation-version chain so a conflict row can carry a real FK.
function seedObservation(raw: Raw, obsId: string): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES ('src', 'https://203.0.113.9/f.xml', 'single_publisher', 'enabled', 'allowed', 'user_subscription', NULL, 0, ?)`,
  ).run(NOW)
  raw.prepare(
    `INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count)
     VALUES ('del', 'src', 'opaque', 'k', ?, ?, 'run', 1)`,
  ).run(NOW, NOW)
  raw.prepare(
    `INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json)
     VALUES (?, 'del', 1, 'fp', X'00', ?, 'run', 0, ?, 'run', 1, '{}', '{}')`,
  ).run(obsId, NOW, NOW)
}

const permalinkRef = (key: string): NormalizedReplyReference => ({ kind: 'permalink', key, scope: null, raw: key })

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  return { raw: repo.raw, db: createDatabaseContext(repo.raw) }
}

test('a null reference resolves to none', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'new')
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'o', reference: null, logicalItemId: 'new' }))
  expect(r).toEqual({ state: 'none', parentLogicalItemId: null })
})

test('an exact permalink resolves to its uniquely owning logical item', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'parent')
  seedPermalink(raw, 'https://ex.test/a', 'parent')
  seedItem(raw, 'new')
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'o', reference: permalinkRef('https://ex.test/a'), logicalItemId: 'new' }))
  expect(r).toEqual({ state: 'resolved', parentLogicalItemId: 'parent' })
})

test('a permalink no item owns is missing (adoptable later, no conflict)', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'new')
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'o', reference: permalinkRef('https://ex.test/nobody'), logicalItemId: 'new' }))
  expect(r).toEqual({ state: 'missing', parentLogicalItemId: null })
  expect(count(raw, 'logical_conflicts_v2')).toBe(0)
})

test('a scoped opaque reference resolves within its source scope', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'parent')
  seedScopedOpaque(raw, 'src1', 'guid-123', 'parent')
  seedItem(raw, 'new')
  const ref: NormalizedReplyReference = { kind: 'opaque', key: 'guid-123', scope: { kind: 'source', id: 'src1' }, raw: 'guid-123' }
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'o', reference: ref, logicalItemId: 'new' }))
  expect(r).toEqual({ state: 'resolved', parentLogicalItemId: 'parent' })
})

test('an unscoped opaque reference is ambiguous and records observation-version evidence', async () => {
  const { raw, db } = await fresh()
  seedObservation(raw, 'obs1')
  seedItem(raw, 'new')
  const ref: NormalizedReplyReference = { kind: 'opaque', key: 'guid-123', scope: null, raw: 'guid-123' }
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'obs1', reference: ref, logicalItemId: 'new' }))
  expect(r).toEqual({ state: 'ambiguous', parentLogicalItemId: null })
  const conflict = raw.prepare(`SELECT logical_item_id, observation_version_id FROM logical_conflicts_v2`).get() as { logical_item_id: string; observation_version_id: string }
  expect(conflict).toEqual({ logical_item_id: 'new', observation_version_id: 'obs1' })
})

test('a self-parenting reference is a cycle conflict, not a resolved edge', async () => {
  const { raw, db } = await fresh()
  seedObservation(raw, 'obs1')
  seedItem(raw, 'new')
  seedPermalink(raw, 'https://ex.test/self', 'new')
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'obs1', reference: permalinkRef('https://ex.test/self'), logicalItemId: 'new' }))
  expect(r.state).toBe('ambiguous')
  expect(count(raw, 'logical_conflicts_v2')).toBe(1)
})

test('a candidate at depth 63 resolves but depth 64 is too deep to place a new edge', async () => {
  const { raw, db } = await fresh()
  seedObservation(raw, 'obs1')
  // chain d0 (root) -> d1 -> ... -> d64 : d[i] has depth i
  let prev: string | null = null
  for (let i = 0; i <= 64; i++) {
    seedItem(raw, `d${i}`, prev)
    seedPermalink(raw, `https://ex.test/d${i}`, `d${i}`)
    prev = `d${i}`
  }
  seedItem(raw, 'newA')
  seedItem(raw, 'newB')
  // parenting under depth-63 puts the new edge at depth 64 — allowed
  const ok = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'obs1', reference: permalinkRef('https://ex.test/d63'), logicalItemId: 'newA' }))
  expect(ok).toEqual({ state: 'resolved', parentLogicalItemId: 'd63' })
  // parenting under depth-64 would place it at depth 65 — rejected as ambiguous
  const tooDeep = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'obs1', reference: permalinkRef('https://ex.test/d64'), logicalItemId: 'newB' }))
  expect(tooDeep.state).toBe('ambiguous')
})

test('a reference resolving to a terminal deleted marker is not a valid new parent', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'dead')
  seedPermalink(raw, 'https://ex.test/dead', 'dead')
  raw.prepare(`INSERT INTO logical_deleted_local_v2 (logical_item_id, canonical_permalink, deleted_at) VALUES ('dead', 'https://ex.test/dead', ?)`).run(NOW)
  seedItem(raw, 'new')
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'o', reference: permalinkRef('https://ex.test/dead'), logicalItemId: 'new' }))
  expect(r.state).toBe('missing')
})
