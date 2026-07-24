import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { LOGICAL_V2_SCHEMA, LOGICAL_V3_SCHEMA } from '../src/logical/schema.ts'

// V4 Task 1 — the migration/cutover schema (plan Appendix A). Pure shape: two
// new tables, one index, three additive ALTERs. No behavior.

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'

async function fresh(): Promise<Raw> {
  const repo = await createSqliteRepository(':memory:')
  return repo.raw as Raw
}
const tableSql = (raw: Raw, name: string): string | undefined =>
  (raw.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as { sql: string } | undefined)?.sql
const columns = (raw: Raw, table: string): { name: string; notnull: number }[] =>
  raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[]
const indexNames = (raw: Raw): Set<string> =>
  new Set((raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]).map((r) => r.name))
const foreignKeys = (raw: Raw, table: string): { table: string; from: string; on_delete: string }[] =>
  raw.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; from: string; on_delete: string }[]

function seedSource(raw: Raw, id: string, url: string): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, NOW)
}
const PUSH_COLS = `id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at`
function insertPush(raw: Raw, over: Partial<Record<string, string | null>> = {}): void {
  const row = {
    id: 'p1', source_id: 's1', mode: 'websub', endpoint: 'https://hub.test/', topic: 'https://a.test/f',
    callback_token: 'tok-1', secret: null, state: 'pending', expires_at: NOW, created_at: NOW, ...over,
  }
  raw.prepare(`INSERT INTO push_subscriptions_v2 (${PUSH_COLS}) VALUES (@id, @source_id, @mode, @endpoint, @topic, @callback_token, @secret, @state, @expires_at, @created_at)`).run(row)
}
const RUN_COLS = `id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json, delivery_mechanism`
function insertRun(raw: Raw, id: string, reason: string, mechanism: string | null): void {
  raw.prepare(
    `INSERT INTO acquisition_runs_v2 (${RUN_COLS}) VALUES (?, 's1', ?, 'terminal', ?, NULL, ?, 'ok', '{}', NULL, NULL, NULL, ?)`,
  ).run(id, reason, NOW, NOW, mechanism)
}

// --- new tables -------------------------------------------------------------

test('the V4 migration creates push_subscriptions_v2 with the Appendix A columns, its expiry index, and the deliberate CASCADE on source_id', async () => {
  const raw = await fresh()
  expect(columns(raw, 'push_subscriptions_v2').map((c) => c.name)).toEqual(
    ['id', 'source_id', 'mode', 'endpoint', 'topic', 'callback_token', 'secret', 'state', 'expires_at', 'created_at'],
  )
  // secret is the only nullable column
  expect(columns(raw, 'push_subscriptions_v2').filter((c) => c.notnull === 0).map((c) => c.name)).toEqual(['id', 'secret'])
  expect(indexNames(raw)).toContain('push_subscriptions_v2_expires')
  // V3 §5.2: purge deletes push state with the rest of the operational state,
  // so this edge is CASCADE — and therefore NOT a purge-inventory entry.
  expect(foreignKeys(raw, 'push_subscriptions_v2')).toEqual([
    expect.objectContaining({ table: 'remote_sources_v2', from: 'source_id', on_delete: 'CASCADE' }),
  ])
})

test('push_subscriptions_v2.state is the two-value WP1 pin: pending and active are accepted, anything else is rejected', async () => {
  const raw = await fresh()
  seedSource(raw, 's1', 'https://a.test/f')
  expect(() => insertPush(raw, { id: 'p1', mode: 'websub', callback_token: 't1', state: 'pending' })).not.toThrow()
  expect(() => insertPush(raw, { id: 'p2', mode: 'rsscloud', callback_token: 't2', state: 'active' })).not.toThrow()
  // migration-time expired/invalid facts are report findings, never rows
  for (const bad of ['expired', 'invalid', 'verified', '']) {
    expect(() => insertPush(raw, { id: `bad-${bad}`, callback_token: `tok-${bad}`, state: bad }), bad).toThrow()
  }
  expect(() => insertPush(raw, { id: 'p3', mode: 'atom', callback_token: 't3' })).toThrow() // mode CHECK
})

test('push_subscriptions_v2 enforces UNIQUE(source_id, mode) and a unique callback_token', async () => {
  const raw = await fresh()
  seedSource(raw, 's1', 'https://a.test/f')
  seedSource(raw, 's2', 'https://b.test/f')
  insertPush(raw, { id: 'p1', source_id: 's1', mode: 'websub', callback_token: 't1' })
  // same (source, mode) — the mirror of legacy UNIQUE(user_id, mode)
  expect(() => insertPush(raw, { id: 'p2', source_id: 's1', mode: 'websub', callback_token: 't2' })).toThrow()
  // same source, other mode: allowed
  expect(() => insertPush(raw, { id: 'p3', source_id: 's1', mode: 'rsscloud', callback_token: 't3' })).not.toThrow()
  // token is identity across every source
  expect(() => insertPush(raw, { id: 'p4', source_id: 's2', mode: 'websub', callback_token: 't1' })).toThrow()
})

test('handle_reservations_v2 has the Appendix A columns and NO foreign keys — the reservation survives source removal and purge', async () => {
  const raw = await fresh()
  expect(columns(raw, 'handle_reservations_v2').map((c) => c.name)).toEqual(['handle', 'source_id', 'publisher_id', 'created_at'])
  expect(foreignKeys(raw, 'handle_reservations_v2')).toEqual([]) // foundation §12
  const insert = raw.prepare(`INSERT INTO handle_reservations_v2 (handle, source_id, publisher_id, created_at) VALUES (?, ?, ?, ?)`)
  // no source row, no publisher row: still accepted
  expect(() => insert.run('alice', 'gone-source', 'gone-publisher', NOW)).not.toThrow()
  expect(() => insert.run('alice', 's-other', 'p-other', NOW)).toThrow() // handle is the PK
})

// --- additive ALTERs --------------------------------------------------------

test('logical_activation_v2 accepts the conversion marker: converted_at plus conversion_findings_json', async () => {
  const raw = await fresh()
  const findings = JSON.stringify({ default_person: 2, push_preserved: 1 })
  raw.prepare(`UPDATE logical_activation_v2 SET converted_at = ?, conversion_findings_json = ? WHERE singleton = 1`).run(NOW, findings)
  const row = raw.prepare(`SELECT converted_at, conversion_findings_json FROM logical_activation_v2 WHERE singleton = 1`)
    .get() as { converted_at: string | null; conversion_findings_json: string | null }
  expect(row).toEqual({ converted_at: NOW, conversion_findings_json: findings })
  // the marker is absent on a fresh database
  const raw2 = await fresh()
  expect(raw2.prepare(`SELECT converted_at FROM logical_activation_v2 WHERE singleton = 1`).get()).toEqual({ converted_at: null })
})

test('acquisition_runs_v2.delivery_mechanism records push or NULL, and reason keeps V2 two values (no push_ping)', async () => {
  const raw = await fresh()
  seedSource(raw, 's1', 'https://a.test/f')
  expect(() => insertRun(raw, 'r1', 'scheduled', 'push')).not.toThrow()
  expect(() => insertRun(raw, 'r2', 'scheduled', null)).not.toThrow()
  expect(() => insertRun(raw, 'r3', 'administrator_refresh', 'push')).not.toThrow()
  // FC1: the plan-invented reason value is gone everywhere
  expect(() => insertRun(raw, 'r4', 'push_ping', 'push')).toThrow()
  const rows = raw.prepare(`SELECT id, delivery_mechanism FROM acquisition_runs_v2 ORDER BY id`).all()
  expect(rows).toEqual([{ id: 'r1', delivery_mechanism: 'push' }, { id: 'r2', delivery_mechanism: null }, { id: 'r3', delivery_mechanism: 'push' }])
})

// --- the amendment tripwire -------------------------------------------------

// Not a red-first assertion: presentation_entries_v2.provenance was CREATED
// three-wide by V2 rev 6's lockstep amendment (schema.ts). A CHECK cannot be
// widened after creation without a table rebuild, so if this ever fails the
// answer is to refuse V4, not to rebuild.
test('presentation_entries_v2 accepts provenance legacy_unknown (the V2 rev 6 lockstep amendment landed)', async () => {
  const raw = await fresh()
  seedSource(raw, 's1', 'https://a.test/f')
  raw.prepare(
    `INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count)
     VALUES ('d1', 's1', 'guid', 'g1', ?, ?, 'run-1', 1)`,
  ).run(NOW, NOW)
  raw.prepare(
    `INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json)
     VALUES ('ov1', 'd1', 1, 'fp1', ?, ?, 'run-1', 0, ?, 'run-1', 1, '{}', '{}')`,
  ).run(Buffer.from('m'), NOW, NOW)
  expect(() =>
    raw.prepare(
      `INSERT INTO presentation_entries_v2 (delivery_id, sequence, observation_version_id, effective_updated_at, provenance, material_fingerprint)
       VALUES ('d1', 0, 'ov1', ?, 'legacy_unknown', 'fp1')`,
    ).run(NOW),
  ).not.toThrow()
  expect(
    (raw.prepare(`SELECT provenance FROM presentation_entries_v2 WHERE delivery_id = 'd1'`).get() as { provenance: string }).provenance,
  ).toBe('legacy_unknown')
})

// --- no existing table is rebuilt (the V3 rev 2 TP5 assertion, reused) -------

// The shipped V2/V3 CREATE TABLE text IS the "before" snapshot: SQLite stores
// it verbatim in sqlite_master and only a table rebuild can change it. ALTER
// TABLE ADD COLUMN appends ", <coldef>" in place of the closing paren, so the
// three V4 ALTER targets are checked against exactly that derived text.
const V3_ALTERED = new Set(['logical_items_v2'])
const createStatements = (schema: string[]): [string, string][] =>
  schema.filter((s) => s.startsWith('CREATE TABLE')).map((s) => [/^CREATE TABLE (\w+)/.exec(s)![1], s])
const withAppended = (ddl: string, appended: string): string => ddl.replace(/\)$/, `, ${appended})`)

test('the V4 migration rebuilds no existing table — every shipped V2/V3 CREATE TABLE text survives byte-identical', async () => {
  const raw = await fresh()
  const V4_ALTERED = new Set(['logical_activation_v2', 'acquisition_runs_v2'])
  for (const [name, ddl] of [...createStatements(LOGICAL_V2_SCHEMA), ...createStatements(LOGICAL_V3_SCHEMA)]) {
    if (V3_ALTERED.has(name) || V4_ALTERED.has(name)) continue
    expect(tableSql(raw, name), `${name} was rebuilt`).toBe(ddl)
  }
  const ddlOf = (name: string): string => Object.fromEntries([...createStatements(LOGICAL_V2_SCHEMA)])[name]
  expect(tableSql(raw, 'logical_activation_v2')).toBe(withAppended(ddlOf('logical_activation_v2'), 'converted_at TEXT, conversion_findings_json TEXT'))
  expect(tableSql(raw, 'acquisition_runs_v2')).toBe(withAppended(ddlOf('acquisition_runs_v2'), 'delivery_mechanism TEXT'))
})
