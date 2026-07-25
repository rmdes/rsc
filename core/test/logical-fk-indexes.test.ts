import { test, expect } from 'vitest'
import type Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

type Raw = InstanceType<typeof Database>

// The FK-coverage invariant (the "never again" guardrail). SQLite does not
// auto-index foreign keys, so an un-indexed FK column is a full table SCAN on
// both the per-item read path and every FK-integrity/cascade child check. This
// asserts that EVERY foreign-key column of EVERY %_v2 table is the leftmost
// column of some index — an explicit index, or a UNIQUE/PRIMARY-KEY autoindex
// whose first column is that FK. Any future v2 table or FK added without an
// index makes this fail. Purely reflective over PRAGMA, so it needs no upkeep.

// The set of columns that are the leftmost of any index (explicit + autoindex),
// plus the first primary-key column (WITHOUT ROWID / integer PKs have no
// autoindex row but still seek on the PK prefix).
function coveredFirstColumns(raw: Raw, table: string): Set<string> {
  const covered = new Set<string>()
  for (const idx of raw.pragma(`index_list(${JSON.stringify(table)})`) as { name: string }[]) {
    const info = raw.pragma(`index_info(${JSON.stringify(idx.name)})`) as { seqno: number; name: string | null }[]
    const first = info.find((c) => c.seqno === 0)
    if (first?.name) covered.add(first.name)
  }
  const firstPk = (raw.pragma(`table_info(${JSON.stringify(table)})`) as { name: string; pk: number }[]).find((c) => c.pk === 1)
  if (firstPk) covered.add(firstPk.name)
  return covered
}

test('every v2 foreign-key column is the leftmost column of an index', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const tables = (
    raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%\\_v2' ESCAPE '\\'").all() as { name: string }[]
  ).map((r) => r.name)
  expect(tables.length).toBeGreaterThan(0)

  const offenders: string[] = []
  for (const t of tables) {
    const covered = coveredFirstColumns(raw, t)
    for (const fk of raw.pragma(`foreign_key_list(${JSON.stringify(t)})`) as { from: string }[]) {
      if (!covered.has(fk.from)) offenders.push(`${t}.${fk.from}`)
    }
  }

  expect(offenders, `un-indexed v2 FK columns (add a CREATE INDEX in schema.ts): ${offenders.join(', ')}`).toEqual([])
})

// The projector's two hottest per-item lookups must seek, not scan.
test('projector hot v2 lookups use an index (SEARCH, not SCAN)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const plan = (sql: string): string =>
    (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('x') as { detail: string }[]).map((r) => r.detail).join(' | ')

  const claims = plan('SELECT 1 FROM publisher_claims_v2 WHERE logical_item_id = ?')
  const replies = plan('SELECT 1 FROM logical_items_v2 WHERE parent_logical_item_id = ?')
  expect(claims, claims).toMatch(/SEARCH .*USING (COVERING )?INDEX/)
  expect(claims).not.toMatch(/SCAN/)
  expect(replies, replies).toMatch(/SEARCH .*USING (COVERING )?INDEX/)
  expect(replies).not.toMatch(/SCAN/)
})
