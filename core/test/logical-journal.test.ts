import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import {
  appendJournal, getJournalMetadata, reconstructJournal,
  encodeJournalCursor, decodeJournalCursor, snapshotJournalCursor,
  readJournalBatch, isServeableCursor,
} from '../src/logical/journal.ts'

const NOW = '2026-07-23T00:00:00.000Z'

async function freshDb() {
  const repo = await createSqliteRepository(':memory:')
  return createDatabaseContext(repo.raw)
}

test('sequences grow strictly monotonically without reuse', async () => {
  const db = await freshDb()
  const seqs = db.write((tx) => [
    appendJournal(tx, { kind: 'upsert', logicalItemId: 'a', changeMask: 'presentation' }, NOW),
    appendJournal(tx, { kind: 'upsert', logicalItemId: 'b', changeMask: 'author' }, NOW),
    appendJournal(tx, { kind: 'remove', logicalItemId: 'a', changeMask: 'visibility' }, NOW),
  ])
  expect(seqs).toEqual([1, 2, 3])
  const meta = db.read((tx) => getJournalMetadata(tx))
  expect(meta).toEqual({ highWaterSeq: 3, resetGeneration: 0 })
})

test('a reset row is stored with a null logical item id', async () => {
  const db = await freshDb()
  db.write((tx) => appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, NOW))
  const rows = db.read((tx) => readJournalBatch(tx, 0, 10))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ sequence: 1, kind: 'reset', logicalItemId: null })
})

test('a generation-qualified cursor round-trips and rejects foreign shapes', async () => {
  const cursor = { version: 1 as const, resetGeneration: 2, sequence: 7 }
  expect(decodeJournalCursor(encodeJournalCursor(cursor))).toEqual(cursor)
  expect(decodeJournalCursor('')).toBeNull()
  expect(decodeJournalCursor('not-base64-json!!')).toBeNull()
  // a pagination-style (non-journal) cursor must not decode as a journal cursor
  expect(decodeJournalCursor(Buffer.from(JSON.stringify([1, 'a', 'b'])).toString('base64url'))).toBeNull()
  // wrong version
  expect(decodeJournalCursor(Buffer.from(JSON.stringify(['logical-v2', 9, 0, 1])).toString('base64url'))).toBeNull()
})

test('unknown, future, and older-generation cursors are unserveable', async () => {
  const db = await freshDb()
  db.write((tx) => {
    appendJournal(tx, { kind: 'upsert', logicalItemId: 'a', changeMask: 'presentation' }, NOW)
    appendJournal(tx, { kind: 'upsert', logicalItemId: 'b', changeMask: 'presentation' }, NOW)
  })
  const meta = db.read((tx) => getJournalMetadata(tx))
  expect(isServeableCursor(meta, { version: 1, resetGeneration: 0, sequence: 1 })).toBe(true)
  expect(isServeableCursor(meta, { version: 1, resetGeneration: 0, sequence: 2 })).toBe(true)
  expect(isServeableCursor(meta, { version: 1, resetGeneration: 0, sequence: 3 })).toBe(false) // future
  expect(isServeableCursor(meta, { version: 1, resetGeneration: 1, sequence: 1 })).toBe(false) // future generation
  expect(isServeableCursor(meta, { version: 1, resetGeneration: -1, sequence: 1 })).toBe(false) // older generation
})

test('an ordinary barrier reset leaves the generation unchanged', async () => {
  const db = await freshDb()
  db.write((tx) => appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, NOW))
  const meta = db.read((tx) => getJournalMetadata(tx))
  expect(meta.resetGeneration).toBe(0)
  expect(meta.highWaterSeq).toBe(1)
})

test('reconstruction increments the generation and appends its reset in one write', async () => {
  const db = await freshDb()
  db.write((tx) => appendJournal(tx, { kind: 'upsert', logicalItemId: 'a', changeMask: 'presentation' }, NOW))
  const before = db.read((tx) => getJournalMetadata(tx))
  const newGen = db.write((tx) => reconstructJournal(tx, NOW))
  const after = db.read((tx) => getJournalMetadata(tx))
  expect(newGen).toBe(before.resetGeneration + 1)
  expect(after.resetGeneration).toBe(1)
  expect(after.highWaterSeq).toBe(2) // the reconstruction reset advanced the sequence
  // the last row is the reconstruction reset
  const rows = db.read((tx) => readJournalBatch(tx, before.highWaterSeq, 10))
  expect(rows.at(-1)).toMatchObject({ kind: 'reset' })
  // a cursor from the prior generation is now unserveable
  expect(isServeableCursor(after, { version: 1, resetGeneration: 0, sequence: 1 })).toBe(false)
})

test('snapshotJournalCursor encodes the current generation and high water', async () => {
  const db = await freshDb()
  db.write((tx) => appendJournal(tx, { kind: 'upsert', logicalItemId: 'a', changeMask: 'presentation' }, NOW))
  const encoded = db.read((tx) => snapshotJournalCursor(tx))
  expect(decodeJournalCursor(encoded)).toEqual({ version: 1, resetGeneration: 0, sequence: 1 })
})
