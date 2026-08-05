import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository, collapseVersionHistory } from '../src/storage/sqlite.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-08-05T00:00:00.000Z'
const LATER = '2026-08-05T01:00:00.000Z'

function count(raw: Raw, table: string, where = '', ...args: unknown[]): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args) as { n: number }).n
}

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  return repo.raw as Raw
}

function seedSource(raw: Raw, id: string): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, 'https://a.test/f', 'aggregate', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
  ).run(id, NOW)
}

function seedItem(raw: Raw, id: string): void {
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at)
     VALUES (?, 'remote', ?, 'none', NULL, NULL, NULL, ?)`,
  ).run(id, NOW, NOW)
}

function seedPublisher(raw: Raw, id: string): void {
  raw.prepare(`INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, NULL, 'source_scoped_fallback', ?)`).run(id, NOW)
}

function seedRun(raw: Raw, id: string, sourceId: string): void {
  raw.prepare(
    `INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json)
     VALUES (?, ?, 'scheduled', 'terminal', ?, ?, ?, 'parsed', '{}', NULL, NULL, NULL)`,
  ).run(id, sourceId, NOW, NOW, NOW)
}

function seedDelivery(raw: Raw, id: string, sourceId: string, runId: string): void {
  raw.prepare(
    `INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count)
     VALUES (?, ?, 'opaque', ?, ?, ?, ?, 1)`,
  ).run(id, sourceId, `key-${id}`, NOW, NOW, runId)
}

// A full observation_versions_v2 row + its reconciliation_jobs_v2 sibling (an
// exact-once FK child), so the collapse's RESTRICT-order deletion has a real
// job row to clear, not just an empty table.
function seedVersion(raw: Raw, id: string, deliveryId: string, runId: string, arrivalAt: string, wireOrdinal: number): void {
  raw.prepare(
    `INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, '{}', '{}')`,
  ).run(id, deliveryId, `fp-${id}`, Buffer.from(`material-${id}`), arrivalAt, runId, wireOrdinal, arrivalAt, runId)
  raw.prepare(
    `INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at)
     VALUES (?, 'observation', ?, ?, NULL, 'reconciled', 0, ?, NULL, NULL, ?)`,
  ).run(`job-${id}`, runId, id, arrivalAt, arrivalAt)
}

function seedPresentation(raw: Raw, deliveryId: string, sequence: number, versionId: string): void {
  raw.prepare(
    `INSERT INTO presentation_entries_v2 (delivery_id, sequence, observation_version_id, effective_updated_at, provenance, material_fingerprint)
     VALUES (?, ?, ?, ?, 'arrival', ?)`,
  ).run(deliveryId, sequence, versionId, NOW, `pf-${versionId}`)
}

function seedClaim(raw: Raw, id: string, itemId: string, publisherId: string, sourceId: string, versionId: string, level: string): void {
  raw.prepare(
    `INSERT INTO publisher_claims_v2 (id, logical_item_id, publisher_id, source_id, observation_version_id, evidence_level, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, itemId, publisherId, sourceId, versionId, level, NOW)
}

function seedName(raw: Raw, id: string, publisherId: string, sourceId: string, versionId: string, name: string): void {
  raw.prepare(
    `INSERT INTO publisher_names_v2 (id, publisher_id, source_id, observation_version_id, evidence_level, normalized_name, first_seen_at, effective)
     VALUES (?, ?, ?, ?, 'aggregate_assertion', ?, ?, 1)`,
  ).run(id, publisherId, sourceId, versionId, name, NOW)
}

test('collapses a multi-version delivery to the current-display survivor, with FK children gone and no RESTRICT violation', async () => {
  const raw = await fresh()
  seedSource(raw, 's1')
  seedItem(raw, 'li-1')
  seedPublisher(raw, 'p1')
  seedRun(raw, 'r1', 's1')
  seedDelivery(raw, 'd1', 's1', 'r1')
  // v1 = old, v2 = current-display (top-sequence presentation entry).
  seedVersion(raw, 'v1', 'd1', 'r1', NOW, 0)
  seedVersion(raw, 'v2', 'd1', 'r1', LATER, 1)
  seedPresentation(raw, 'd1', 0, 'v1')
  seedPresentation(raw, 'd1', 1, 'v2')
  seedClaim(raw, 'c1', 'li-1', 'p1', 's1', 'v1', 'bound_single_publisher')
  seedClaim(raw, 'c2', 'li-1', 'p1', 's1', 'v2', 'aggregate_assertion')
  seedName(raw, 'n1', 'p1', 's1', 'v1', 'Old Name')
  seedName(raw, 'n2', 'p1', 's1', 'v2', 'New Name')

  expect(() => collapseVersionHistory(raw)).not.toThrow()

  // exactly one version + one presentation entry remain: the survivor, v2
  expect(count(raw, 'observation_versions_v2', 'WHERE delivery_id = ?', 'd1')).toBe(1)
  const surviving = raw.prepare(`SELECT id FROM observation_versions_v2 WHERE delivery_id = ?`).get('d1') as { id: string }
  expect(surviving.id).toBe('v2')
  expect(count(raw, 'presentation_entries_v2', 'WHERE delivery_id = ?', 'd1')).toBe(1)
  const entry = raw.prepare(`SELECT sequence, observation_version_id FROM presentation_entries_v2 WHERE delivery_id = ?`).get('d1') as { sequence: number; observation_version_id: string }
  expect(entry).toEqual({ sequence: 0, observation_version_id: 'v2' })

  // every FK child of the dropped version (v1) is gone — no RESTRICT violation
  expect(count(raw, 'reconciliation_jobs_v2', 'WHERE observation_version_id = ?', 'v1')).toBe(0)
  expect(count(raw, 'publisher_claims_v2', 'WHERE observation_version_id = ?', 'v1')).toBe(0)
  expect(count(raw, 'publisher_names_v2', 'WHERE observation_version_id = ?', 'v1')).toBe(0)

  // the survivor's own children are untouched — the item still resolves a byline
  expect(count(raw, 'reconciliation_jobs_v2', 'WHERE observation_version_id = ?', 'v2')).toBe(1)
  const claim = raw.prepare(`SELECT publisher_id, evidence_level FROM publisher_claims_v2 WHERE observation_version_id = ?`).get('v2') as { publisher_id: string; evidence_level: string }
  expect(claim).toEqual({ publisher_id: 'p1', evidence_level: 'aggregate_assertion' })
})

test('a second run is a no-op (idempotent)', async () => {
  const raw = await fresh()
  seedSource(raw, 's1')
  seedItem(raw, 'li-1')
  seedPublisher(raw, 'p1')
  seedRun(raw, 'r1', 's1')
  seedDelivery(raw, 'd1', 's1', 'r1')
  seedVersion(raw, 'v1', 'd1', 'r1', NOW, 0)
  seedVersion(raw, 'v2', 'd1', 'r1', LATER, 1)
  seedPresentation(raw, 'd1', 0, 'v1')
  seedPresentation(raw, 'd1', 1, 'v2')
  seedClaim(raw, 'c1', 'li-1', 'p1', 's1', 'v1', 'bound_single_publisher')
  seedClaim(raw, 'c2', 'li-1', 'p1', 's1', 'v2', 'aggregate_assertion')

  collapseVersionHistory(raw)
  const after1 = raw.prepare(`SELECT id FROM observation_versions_v2 WHERE delivery_id = ?`).get('d1')

  expect(() => collapseVersionHistory(raw)).not.toThrow()
  expect(count(raw, 'observation_versions_v2', 'WHERE delivery_id = ?', 'd1')).toBe(1)
  expect(count(raw, 'presentation_entries_v2', 'WHERE delivery_id = ?', 'd1')).toBe(1)
  const after2 = raw.prepare(`SELECT id FROM observation_versions_v2 WHERE delivery_id = ?`).get('d1')
  expect(after2).toEqual(after1)
})

test('a delivery with versions but NO presentation entry falls back to the newest by arrival_at (never null)', async () => {
  const raw = await fresh()
  seedSource(raw, 's1')
  seedRun(raw, 'r1', 's1')
  seedDelivery(raw, 'd2', 's1', 'r1')
  seedVersion(raw, 'v3', 'd2', 'r1', NOW, 0)
  seedVersion(raw, 'v4', 'd2', 'r1', LATER, 1) // newer by arrival_at — the fallback survivor

  expect(() => collapseVersionHistory(raw)).not.toThrow()

  expect(count(raw, 'observation_versions_v2', 'WHERE delivery_id = ?', 'd2')).toBe(1)
  const surviving = raw.prepare(`SELECT id FROM observation_versions_v2 WHERE delivery_id = ?`).get('d2') as { id: string }
  expect(surviving.id).toBe('v4')
  // no presentation entry existed before, and the collapse does not invent one
  expect(count(raw, 'presentation_entries_v2', 'WHERE delivery_id = ?', 'd2')).toBe(0)
})

test('a single-version delivery is left untouched', async () => {
  const raw = await fresh()
  seedSource(raw, 's1')
  seedRun(raw, 'r1', 's1')
  seedDelivery(raw, 'd3', 's1', 'r1')
  seedVersion(raw, 'v5', 'd3', 'r1', NOW, 0)
  seedPresentation(raw, 'd3', 0, 'v5')

  expect(() => collapseVersionHistory(raw)).not.toThrow()

  expect(count(raw, 'observation_versions_v2', 'WHERE delivery_id = ?', 'd3')).toBe(1)
  const surviving = raw.prepare(`SELECT id FROM observation_versions_v2 WHERE delivery_id = ?`).get('d3') as { id: string }
  expect(surviving.id).toBe('v5')
  const entry = raw.prepare(`SELECT sequence, observation_version_id FROM presentation_entries_v2 WHERE delivery_id = ?`).get('d3') as { sequence: number; observation_version_id: string }
  expect(entry).toEqual({ sequence: 0, observation_version_id: 'v5' })
})
