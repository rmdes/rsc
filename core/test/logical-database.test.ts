import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { appendJournal } from '../src/logical/journal.ts'
import { storeCommand } from '../src/domain/source-repository.ts'
import type { CommandEnvelope } from '../src/domain/types.ts'

type Raw = InstanceType<typeof Database>

const NOW = '2026-07-23T00:00:00.000Z'

function count(raw: Raw, table: string): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

// Seeds a V1 source row PLUS its audit row — two of the four table families a
// domain mutation touches (source + audit). The other two (ledger, journal) are
// written by the tests directly so a fault can prove all four roll back together.
function seedSource(raw: Raw, id: string): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'user_subscription', NULL, 0, ?)`,
  ).run(id, `https://203.0.113.9/${id}.xml`, NOW)
  raw.prepare(
    `INSERT INTO source_audit_v2 (id, source_id, command_id, actor_id, actor_kind, action, category, note, result_json, created_at)
     VALUES (?, ?, ?, ?, 'administrator', 'subscribe', NULL, NULL, '{}', ?)`,
  ).run(`a-${id}`, id, `cmd-${id}`, 'actor-1', NOW)
}

function command(id: string): CommandEnvelope {
  return { actorScope: 'administrator', actorId: 'actor-1', commandId: id, requestFingerprint: 'fp' }
}

test('a fault before the ledger rolls back source, audit, and journal rows', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  expect(() =>
    db.write((tx) => {
      seedSource(tx, 's1')
      appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, NOW)
      throw new Error('fault-before-ledger')
    }),
  ).toThrow('fault-before-ledger')
  expect(count(repo.raw, 'remote_sources_v2')).toBe(0)
  expect(count(repo.raw, 'source_audit_v2')).toBe(0)
  expect(count(repo.raw, 'logical_journal_v2')).toBe(0)
  expect(count(repo.raw, 'command_ledger_v2')).toBe(0)
})

test('a fault after the ledger write still rolls the ledger row back', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  expect(() =>
    db.write((tx) => {
      seedSource(tx, 's1')
      appendJournal(tx, { kind: 'upsert', logicalItemId: 'x', changeMask: 'presentation' }, NOW)
      storeCommand(tx, command('c1'), { ok: true }, NOW)
      throw new Error('fault-before-commit')
    }),
  ).toThrow('fault-before-commit')
  expect(count(repo.raw, 'command_ledger_v2')).toBe(0)
  expect(count(repo.raw, 'logical_journal_v2')).toBe(0)
  expect(count(repo.raw, 'remote_sources_v2')).toBe(0)
})

test('a clean write commits all four families together', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  db.write((tx) => {
    seedSource(tx, 's1')
    appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, NOW)
    storeCommand(tx, command('c1'), { ok: true }, NOW)
  })
  expect(count(repo.raw, 'remote_sources_v2')).toBe(1)
  expect(count(repo.raw, 'source_audit_v2')).toBe(1)
  expect(count(repo.raw, 'logical_journal_v2')).toBe(1)
  expect(count(repo.raw, 'command_ledger_v2')).toBe(1)
})

test('read returns the query value inside a deferred transaction', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  db.write((tx) => seedSource(tx, 's1'))
  const n = db.read((tx) => (tx.prepare('SELECT COUNT(*) AS n FROM remote_sources_v2').get() as { n: number }).n)
  expect(n).toBe(1)
})
