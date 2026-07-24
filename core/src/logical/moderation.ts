import { randomUUID } from 'node:crypto'
import type { WriteTx } from './database.ts'
import type { ItemAuditEvent } from './types.ts'
import type { AuditCategory } from '../domain/types.ts'

// Item audit (spec §1.2): mirrors V1's source_audit_v2 write shape
// (core/src/storage/sqlite.ts insertAudit/rowToSourceAuditV2) but item_audit_v2
// owns its OWN nine-value SQL CHECK (schema.ts) — never a mirror of the
// narrower TS AuditCategory. appendItemAudit takes the caller's WriteTx so it
// commits atomically with the item mutation it audits, inside the caller's
// ONE db.write() (plan Appendix D fault-injection pattern): a throw anywhere
// before that write commits rolls back the audit row together with the item
// effect.
//
// Task 1 wires only the primitive; hide/restore (Task 2) and the system-actor
// emitters (Tasks 4-5) are the first callers.

export interface ItemAuditRow {
  id: string
  logical_item_id: string
  command_id: string
  actor_id: string | null
  actor_kind: 'administrator' | 'system'
  action: string
  category: AuditCategory | null
  note: string | null
  result_json: string
  created_at: string
}

export function rowToItemAuditEvent(r: ItemAuditRow): ItemAuditEvent {
  return {
    id: r.id, logicalItemId: r.logical_item_id, commandId: r.command_id, actorId: r.actor_id,
    actorKind: r.actor_kind, action: r.action, category: r.category, note: r.note,
    resultJson: r.result_json, createdAt: r.created_at,
  }
}

export interface AppendItemAuditInput {
  logicalItemId: string
  commandId: string
  actorId: string | null
  actorKind: 'administrator' | 'system'
  action: string
  category: AuditCategory | null
  note: string | null
  result: unknown
  now: string
}

export function appendItemAudit(tx: WriteTx, event: AppendItemAuditInput): ItemAuditEvent {
  const row: ItemAuditRow = {
    id: randomUUID(), logical_item_id: event.logicalItemId, command_id: event.commandId,
    actor_id: event.actorId, actor_kind: event.actorKind, action: event.action,
    category: event.category, note: event.note, result_json: JSON.stringify(event.result), created_at: event.now,
  }
  tx.prepare(
    `INSERT INTO item_audit_v2 (id, logical_item_id, command_id, actor_id, actor_kind, action, category, note, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.logical_item_id, row.command_id, row.actor_id, row.actor_kind, row.action, row.category, row.note, row.result_json, row.created_at)
  return rowToItemAuditEvent(row)
}
