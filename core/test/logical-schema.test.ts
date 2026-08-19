import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'

type Raw = InstanceType<typeof Database>

function tableNames(raw: Raw): Set<string> {
  const rows = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}
function indexNames(raw: Raw): Set<string> {
  const rows = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}
function tableSql(raw: Raw, name: string): string {
  return (raw.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as { sql: string }).sql
}

const V2_TABLES = [
  'logical_activation_v2', 'logical_journal_meta_v2', 'logical_journal_v2',
  'remote_publishers_v2', 'publisher_names_v2', 'logical_items_v2',
  'logical_local_origins_v2', 'logical_deleted_local_v2', 'logical_identity_keys_v2',
  'deliveries_v2', 'observation_versions_v2', 'presentation_entries_v2',
  'publisher_claims_v2', 'logical_conflicts_v2', 'orphan_work_v2',
  'acquisition_runs_v2', 'acquisition_commands_v2', 'source_health_v2',
  'source_validators_v2', 'source_aliases_v2', 'redirect_observations_v2',
  'acquisition_findings_v2', 'reconciliation_jobs_v2',
]

test('the migration creates every logical-v2 table', async () => {
  const repo = await createSqliteRepository(':memory:')
  const names = tableNames(repo.raw)
  for (const t of V2_TABLES) expect(names, `missing table ${t}`).toContain(t)
})

test('the read-path index on logical_identity_keys_v2(logical_item_id) exists and is used', async () => {
  // Regression: without this index the per-item identity-key lookups (eligible
  // deliveries, REMOTE_VISIBLE, reply counts) SCAN the whole table — ~2s
  // timelines + 100% CPU on the main instance. The index turns scans into seeks.
  const repo = await createSqliteRepository(':memory:')
  expect(indexNames(repo.raw)).toContain('logical_identity_keys_v2_item')
  const plan = repo.raw
    .prepare(`EXPLAIN QUERY PLAN SELECT key FROM logical_identity_keys_v2 WHERE logical_item_id = ? AND kind LIKE 'opaque:%'`)
    .all('x') as { detail: string }[]
  expect(plan[0].detail).toContain('USING INDEX logical_identity_keys_v2_item')
})

test('activation is the inactive singleton and no journal row exists', async () => {
  const repo = await createSqliteRepository(':memory:')
  const store = createLogicalStore(createDatabaseContext(repo.raw))
  const activation = store.snapshot((tx) => tx.getActivation())
  expect(activation).toEqual({ schemaVersion: 1, state: 'never_activated', lastActivatedAt: null, lastReconciledAt: null })
  const meta = store.snapshot((tx) => tx.getJournalMetadata())
  expect(meta).toEqual({ highWaterSeq: 0, resetGeneration: 0 })
  const journalRows = (repo.raw.prepare('SELECT COUNT(*) AS n FROM logical_journal_v2').get() as { n: number }).n
  expect(journalRows).toBe(0)
})

test('presentation provenance CHECK is created three-wide including legacy_unknown', async () => {
  const repo = await createSqliteRepository(':memory:')
  const sql = tableSql(repo.raw, 'presentation_entries_v2')
  expect(sql).toContain('legacy_unknown')
  expect(sql).toContain('explicit')
  expect(sql).toContain('arrival')
})

test('reconciliation_jobs_v2 is verification-ready from day one', async () => {
  const repo = await createSqliteRepository(':memory:')
  const sql = tableSql(repo.raw, 'reconciliation_jobs_v2')
  expect(sql).toContain('verification')
  expect(sql).toContain("kind IN('observation','verification')")
})

test('source_aliases_v2 carries the ON DELETE CASCADE exception', async () => {
  const repo = await createSqliteRepository(':memory:')
  expect(tableSql(repo.raw, 'source_aliases_v2')).toContain('ON DELETE CASCADE')
})

test('remote_sources_v2 gains the additive policy_generation column', async () => {
  const repo = await createSqliteRepository(':memory:')
  const cols = (repo.raw.prepare(`PRAGMA table_info(remote_sources_v2)`).all() as { name: string }[]).map((r) => r.name)
  expect(cols).toContain('policy_generation')
})

test('the required indexes ship (timeline ordering + the V1 subscription index-debt fix)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const idx = indexNames(repo.raw)
  expect([...idx].some((n) => n.includes('logical_items_v2'))).toBe(true)
  expect([...idx].some((n) => n.includes('source_subscriptions_v2_source'))).toBe(true)
})

test('overridden: DEFAULT 1, mint writes 0, CHECK enforces the bit', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as InstanceType<typeof Database>
  // any legacy-shaped INSERT omitting the column defaults to 1
  raw.prepare(`INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
               VALUES ('s1', 'https://a.test/f', 'single_publisher', 'enabled', 'allowed', 'user_subscription', NULL, 0, '2026-07-25T00:00:00.000Z')`).run()
  expect((raw.prepare(`SELECT overridden FROM remote_sources_v2 WHERE id = 's1'`).get() as { overridden: number }).overridden).toBe(1)
  expect(() => raw.prepare(`UPDATE remote_sources_v2 SET overridden = 2 WHERE id = 's1'`).run()).toThrow()
  expect(raw.pragma('user_version', { simple: true })).toBe(25)
  repo.close()
})

test('migration 20 adds acquisition_runs_v2(started_at) and acquisition_runs_v2(status) indexes', async () => {
  const repo = await createSqliteRepository(':memory:')
  const idx = indexNames(repo.raw)
  expect([...idx].some((n) => n === 'acquisition_runs_v2_started_at')).toBe(true)
  expect([...idx].some((n) => n === 'acquisition_runs_v2_status')).toBe(true)
  expect(repo.raw.pragma('user_version', { simple: true })).toBe(25)
  repo.close()
})
