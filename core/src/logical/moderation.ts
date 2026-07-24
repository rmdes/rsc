import { randomUUID } from 'node:crypto'
import type { WriteTx } from './database.ts'
import type { ItemAuditEvent, ModerationCommandInput, ItemModerationResult, ProjectionViewer } from './types.ts'
import type { AuditCategory } from '../domain/types.ts'
import { checkCommand, storeCommand } from '../domain/source-repository.ts'
import { appendJournal } from './journal.ts'
import { projectItem } from './projector.ts'

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

// ---- hide / restore commands (spec §1.1, §6) --------------------------------
// Each runs inside the store's ONE db.write() (BEGIN IMMEDIATE): the V1 command
// ledger check, the hidden_at state change, ONE item-audit record, and the §6
// journal effect commit atomically. A reused command ID with the same fingerprint
// replays the stored result; a varied fingerprint conflicts (both via checkCommand
// — the route folds command/item/actor/category into the fingerprint, note is
// excluded). hide-on-hidden / restore-on-visible are DISTINCT state conflicts
// (not_applicable), not idempotency conflicts.
//
// The §6 journal effect follows the item's ORDINARY visibility, which hide/restore
// do not otherwise change: selection/classification hints are a pure function of
// deliveries/claims/versions (none of which these commands touch), so the shared
// read-time projector re-derives the SAME hints — reusing projectItem to decide
// visibility is both the required shared-comparator path and lazier than rewriting
// identical hint columns.
const ANON_VIEWER: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }

interface ItemStateRow { origin: 'local' | 'remote'; hidden_at: string | null }

export function hideItem(tx: WriteTx, input: ModerationCommandInput): ItemModerationResult {
  return moderate(tx, input, 'hide')
}
export function restoreItem(tx: WriteTx, input: ModerationCommandInput): ItemModerationResult {
  return moderate(tx, input, 'restore')
}

function moderate(tx: WriteTx, input: ModerationCommandInput, action: 'hide' | 'restore'): ItemModerationResult {
  const check = checkCommand<ItemModerationResult>(tx, input.command)
  if (check.kind === 'replay') return check.result
  if (check.kind === 'conflict') return { kind: 'conflict' }

  const result = decide(tx, input, action)
  storeCommand(tx, input.command, result, input.now) // durable: an identical retry replays this
  return result
}

function decide(tx: WriteTx, input: ModerationCommandInput, action: 'hide' | 'restore'): ItemModerationResult {
  const { logicalItemId, command, category, note, now } = input
  const row = tx.prepare(`SELECT origin, hidden_at FROM logical_items_v2 WHERE id = ?`).get(logicalItemId) as ItemStateRow | undefined
  if (!row) return { kind: 'unknown' }
  if (row.origin === 'local') return { kind: 'local_origin' } // local moderation is the deletion path
  const isHidden = row.hidden_at != null

  if (action === 'hide') {
    if (isHidden) return { kind: 'not_applicable' }
    // Ordinary visibility BEFORE the hide decides the §6 effect (visible → remove).
    const wasVisible = projectItem(tx, logicalItemId, ANON_VIEWER) !== undefined
    tx.prepare(`UPDATE logical_items_v2 SET hidden_at = ? WHERE id = ?`).run(now, logicalItemId)
    const result: ItemModerationResult = { kind: 'applied', logicalItemId, hiddenAt: now }
    appendItemAudit(tx, { logicalItemId, commandId: command.commandId, actorId: command.actorId, actorKind: 'administrator', action: 'hide', category, note, result, now })
    if (wasVisible) appendJournal(tx, { kind: 'remove', logicalItemId, changeMask: 'visibility' }, now)
    return result
  }

  if (!isHidden) return { kind: 'not_applicable' }
  tx.prepare(`UPDATE logical_items_v2 SET hidden_at = NULL WHERE id = ?`).run(logicalItemId)
  // Ordinary visibility AFTER clearing hidden decides the effect; the projector's
  // eligibility gate still applies, so previously-ineligible evidence stays hidden.
  const nowVisible = projectItem(tx, logicalItemId, ANON_VIEWER) !== undefined
  const result: ItemModerationResult = { kind: 'applied', logicalItemId, hiddenAt: null }
  appendItemAudit(tx, { logicalItemId, commandId: command.commandId, actorId: command.actorId, actorKind: 'administrator', action: 'restore', category, note, result, now })
  if (nowVisible) appendJournal(tx, { kind: 'upsert', logicalItemId, changeMask: 'visibility' }, now)
  return result
}
