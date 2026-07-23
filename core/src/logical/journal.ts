import type { ReadTx, WriteTx } from './database.ts'
import type { JournalEffect, JournalChangeMask, JournalMetadata, JournalCursor } from './types.ts'

// The durable journal (spec §5.1-5.2). Rows carry only sequence, kind, nullable
// logical-item ID, a bounded change mask, and a timestamp — no DTO, content, or
// evidence. Sequences strictly increase and are never reused; there is no
// retention ring or pruned floor.
// ponytail: no pruning; add retention when the journal table measurably matters.

// Bounded change mask → one bit per named change. Stored as an INTEGER so a
// future multi-change effect can OR bits without a schema change.
const MASK_BIT: Record<JournalChangeMask, number> = {
  presentation: 1, author: 2, visibility: 4, classification: 8,
  ancestry: 16, reply_counts: 32, history: 64, barrier: 128,
}

export interface JournalRow {
  sequence: number
  kind: 'upsert' | 'remove' | 'reset'
  logicalItemId: string | null
  changeMask: number
  createdAt: string
}

function readMeta(tx: ReadTx): { high_water_seq: number; reset_generation: number } {
  return tx.prepare(
    `SELECT high_water_seq, reset_generation FROM logical_journal_meta_v2 WHERE singleton = 1`,
  ).get() as { high_water_seq: number; reset_generation: number }
}

// Appends one journal record inside the caller's write transaction and advances
// the high-water sequence. Returns the new sequence.
export function appendJournal(tx: WriteTx, effect: JournalEffect, now: string): number {
  const sequence = readMeta(tx).high_water_seq + 1
  const logicalItemId = effect.kind === 'reset' ? null : effect.logicalItemId
  tx.prepare(
    `INSERT INTO logical_journal_v2 (sequence, kind, logical_item_id, change_mask, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sequence, effect.kind, logicalItemId, MASK_BIT[effect.changeMask], now)
  tx.prepare(`UPDATE logical_journal_meta_v2 SET high_water_seq = ? WHERE singleton = 1`).run(sequence)
  return sequence
}

export function getJournalMetadata(tx: ReadTx): JournalMetadata {
  const m = readMeta(tx)
  return { highWaterSeq: m.high_water_seq, resetGeneration: m.reset_generation }
}

// Explicit journal reconstruction: increment the reset generation and append its
// initial reset atomically (spec §5.1). Returns the new generation. Ordinary
// barrier resets go through appendJournal and leave the generation unchanged.
export function reconstructJournal(tx: WriteTx, now: string): number {
  tx.prepare(`UPDATE logical_journal_meta_v2 SET reset_generation = reset_generation + 1 WHERE singleton = 1`).run()
  const generation = readMeta(tx).reset_generation
  appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, now)
  return generation
}

export function readJournalBatch(tx: ReadTx, afterSequence: number, limit: number): JournalRow[] {
  const rows = tx.prepare(
    `SELECT sequence, kind, logical_item_id, change_mask, created_at
     FROM logical_journal_v2 WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`,
  ).all(afterSequence, limit) as { sequence: number; kind: JournalRow['kind']; logical_item_id: string | null; change_mask: number; created_at: string }[]
  return rows.map((r) => ({ sequence: r.sequence, kind: r.kind, logicalItemId: r.logical_item_id, changeMask: r.change_mask, createdAt: r.created_at }))
}

// Opaque, model- and generation-qualified. Clients never parse the sequence.
export function encodeJournalCursor(cursor: JournalCursor): string {
  return Buffer.from(JSON.stringify(['logical-v2', cursor.version, cursor.resetGeneration, cursor.sequence])).toString('base64url')
}

export function decodeJournalCursor(s: string): JournalCursor | null {
  try {
    const arr: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
    if (!Array.isArray(arr) || arr[0] !== 'logical-v2' || arr[1] !== 1) return null
    const [, , generation, sequence] = arr
    if (!Number.isInteger(generation) || !Number.isInteger(sequence)) return null
    return { version: 1, resetGeneration: generation, sequence }
  } catch {
    return null
  }
}

export function snapshotJournalCursor(tx: ReadTx): string {
  const m = getJournalMetadata(tx)
  return encodeJournalCursor({ version: 1, resetGeneration: m.resetGeneration, sequence: m.highWaterSeq })
}

// A cursor is serveable only from the current generation and no further ahead
// than the current high water (spec §5.2). Unknown, future, and older-generation
// cursors are all unserveable and the caller answers with a single reset.
export function isServeableCursor(meta: JournalMetadata, cursor: JournalCursor): boolean {
  return cursor.resetGeneration === meta.resetGeneration && cursor.sequence >= 0 && cursor.sequence <= meta.highWaterSeq
}
