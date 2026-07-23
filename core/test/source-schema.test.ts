import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

test('creates the five v2 source-control tables', async () => {
  const repo = await createSqliteRepository(':memory:')
  const rows = repo.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining([
    'remote_sources_v2', 'federation_relationships_v2',
    'source_subscriptions_v2', 'source_audit_v2', 'command_ledger_v2',
  ]))
  repo.close()
})
