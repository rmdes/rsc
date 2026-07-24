import type { WriteTx } from './database.ts'
import { applySelectionHints } from './reconcile.ts'

// Generation-qualified policy fan-out (spec §4.1). A governance/federation/
// attribution-mode transition already commits atomically with ONE journal reset
// and a policy-generation advance (V2 §3.7); reads are immediately correct from
// current policy. What stays stale is only the MATERIALIZED selection hints, and
// this module converges them on the V2 reconciliation drain — no journal, no
// visibility, no audit (spec §2, §4.1). There is no second loop: the transition
// enqueues one durable row per source; the drain claims and processes it in
// bounded batches, and a stale-generation batch self-aborts.
//
// ponytail: one drain in the one Core process; leases/fences only if fan-out ever
// leaves the process. Batching bounds the SQLite writer-lock hold of a full-source
// hint recompute — not result size (rev 2, TP3): one unbounded transaction would
// hold the single writer lock for the whole recompute.

export interface FanoutClaim { sourceId: string; generation: number; lastItemCursor: string | null }
export type FanoutBatchResult = { kind: 'progress' | 'done' | 'superseded'; processed: number }

export const FANOUT_BATCH_SIZE = 100

// Enqueue: upsert the source's row with its NEW generation and a cleared cursor,
// back to 'pending'. Called inside the transition's own transaction (next to the
// generation advance, sqlite.ts) so it commits — or rolls back — atomically with
// the reset. A newer transition overwrites older work by generation alone.
export function scheduleFanout(tx: WriteTx, input: { sourceId: string; generation: number; now: string }): void {
  tx.prepare(
    `INSERT INTO policy_fanout_v2 (source_id, generation, last_item_cursor, state, updated_at)
     VALUES (?, ?, NULL, 'pending', ?)
     ON CONFLICT(source_id) DO UPDATE SET
       generation = excluded.generation, last_item_cursor = NULL, state = 'pending', updated_at = excluded.updated_at`,
  ).run(input.sourceId, input.generation, input.now)
}

// Claim: take one pending/running row and mark it 'running'. 'running' is
// re-claimable so a restart resumes mid-fan-out from the durable cursor.
export function claimFanout(tx: WriteTx, now: string): FanoutClaim | null {
  const row = tx.prepare(
    `SELECT source_id, generation, last_item_cursor FROM policy_fanout_v2
     WHERE state IN ('pending','running') ORDER BY source_id ASC LIMIT 1`,
  ).get() as { source_id: string; generation: number; last_item_cursor: string | null } | undefined
  if (!row) return null
  tx.prepare(`UPDATE policy_fanout_v2 SET state = 'running', updated_at = ? WHERE source_id = ?`).run(now, row.source_id)
  return { sourceId: row.source_id, generation: row.generation, lastItemCursor: row.last_item_cursor }
}

// One bounded batch, in ONE transaction (the caller's db.write). Rechecks the
// source's CURRENT policy_generation first: a mismatch means a newer transition
// superseded this work — return 'superseded' and write NOTHING (the newer
// transition already re-upserted the row to its generation, pending). Otherwise
// recompute hints for up to FANOUT_BATCH_SIZE items in ascending logical-item ID
// over items holding any delivery from the source, through the SHARED comparator
// (applySelectionHints, currentVersionId='' — every job is already terminal), and
// persist the cursor. Fewer than a full batch ⇒ 'done'.
export function processFanoutBatch(tx: WriteTx, input: { claim: FanoutClaim; now: string }): FanoutBatchResult {
  const { claim, now } = input
  const src = tx.prepare(`SELECT policy_generation FROM remote_sources_v2 WHERE id = ?`).get(claim.sourceId) as { policy_generation: number } | undefined
  if (!src || src.policy_generation !== claim.generation) {
    return { kind: 'superseded', processed: 0 } // stale: newer work owns the row now
  }

  const items = tx.prepare(
    `SELECT DISTINCT ik.logical_item_id AS id FROM logical_identity_keys_v2 ik
     JOIN deliveries_v2 d ON d.id = ik.key
     WHERE ik.kind = 'delivery' AND d.source_id = ? AND ik.logical_item_id > ?
     ORDER BY ik.logical_item_id ASC LIMIT ?`,
  ).all(claim.sourceId, claim.lastItemCursor ?? '', FANOUT_BATCH_SIZE) as { id: string }[]

  for (const it of items) applySelectionHints(tx, it.id, '')

  const processed = items.length
  const cursor = processed > 0 ? items[processed - 1].id : claim.lastItemCursor
  const done = processed < FANOUT_BATCH_SIZE
  tx.prepare(`UPDATE policy_fanout_v2 SET last_item_cursor = ?, state = ?, updated_at = ? WHERE source_id = ? AND generation = ?`)
    .run(cursor, done ? 'done' : 'running', now, claim.sourceId, claim.generation)
  return { kind: done ? 'done' : 'progress', processed }
}
