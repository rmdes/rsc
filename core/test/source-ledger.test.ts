import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { checkCommand, storeCommand } from '../src/domain/source-repository.ts'
import type { CommandEnvelope } from '../src/domain/types.ts'
import Database from 'better-sqlite3'

function env(commandId: string, requestFingerprint: string): CommandEnvelope {
  return { actorScope: 'administrator', actorId: 'admin-1', commandId, requestFingerprint }
}

// Exercises checkCommand/storeCommand exactly as a later mutation task will:
// both calls made inside ONE BEGIN IMMEDIATE transaction on the caller's raw
// handle. This is the ledger helper's call contract — see source-repository.ts.
function testCommand<T>(raw: InstanceType<typeof Database>, command: CommandEnvelope, fn: () => T): T {
  return raw.transaction(() => {
    const check = checkCommand<T>(raw, command)
    if (check.kind === 'replay') return check.result
    if (check.kind === 'conflict') return { kind: 'conflict' } as T
    const result = fn()
    storeCommand(raw, command, result, new Date().toISOString())
    return result
  }).immediate()
}

function countLedger(raw: InstanceType<typeof Database>): number {
  const { n } = raw.prepare('SELECT count(*) AS n FROM command_ledger_v2').get() as { n: number }
  return n
}

test('ledger returns the original result and rejects changed reuse', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw

  const first = testCommand(raw, env('c1', 'hash-a'), () => ({ kind: 'written' }))
  const replay = testCommand(raw, env('c1', 'hash-a'), () => ({ kind: 'wrong' }))
  const conflict = testCommand(raw, env('c1', 'hash-b'), () => ({ kind: 'wrong' }))

  expect(first).toEqual({ kind: 'written' })
  expect(replay).toEqual(first)
  expect(conflict).toEqual({ kind: 'conflict' })
  expect(countLedger(raw)).toBe(1)

  repo.close()
})
