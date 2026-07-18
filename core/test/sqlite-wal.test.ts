import { test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

// createSqliteRepository is async: `export async function createSqliteRepository
// (filename: string): Promise<SqliteRepository>` — must be awaited.
test('file-backed DB runs in WAL journal mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-wal-'))
  const file = join(dir, 'test.db')
  try {
    await createSqliteRepository(file) // opens + migrates; sets WAL
    const check = new Database(file, { readonly: true })
    const mode = check.pragma('journal_mode', { simple: true })
    check.close()
    expect(mode).toBe('wal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
