import { randomUUID } from 'node:crypto'
import type { WriteTx } from './database.ts'
import type { NormalizedReplyReference, ParentResolutionResult } from './types.ts'

// Authoritative ancestry (spec §4.1). resolveInitialParent maps the initially
// selected delivery's reply reference to a parent logical item, or classifies it
// none/missing/ambiguous. Task 7 later adds durable late adoption of `missing`
// references; this task only resolves the initial edge and records conflicts.

// Root depth is zero; no new edge may sit more than 64 edges from its root
// (spec §4.2). A bounded walk guards against a corrupt cycle in stored edges.
const MAX_DEPTH = 64
const WALK_BOUND = 1000

// The identity-key row that owns a reference, or null. logical_identity_keys_v2
// has PK(kind,key), so a permalink/scoped-opaque key maps to at most one item —
// permalinks are never ambiguous by construction (spec §4.1).
function lookupOwner(tx: WriteTx, kind: string, key: string): string | null {
  const row = tx.prepare(`SELECT logical_item_id FROM logical_identity_keys_v2 WHERE kind = ? AND key = ?`).get(kind, key) as { logical_item_id: string } | undefined
  return row ? row.logical_item_id : null
}

function isDeletedMarker(tx: WriteTx, id: string): boolean {
  return tx.prepare(`SELECT 1 FROM logical_deleted_local_v2 WHERE logical_item_id = ?`).get(id) !== undefined
}

// Edges from `id` to its derived root; MAX_DEPTH is measured in edges (root = 0).
export function logicalDepth(tx: WriteTx, id: string): number {
  const parentOf = tx.prepare(`SELECT parent_logical_item_id FROM logical_items_v2 WHERE id = ?`)
  let depth = 0
  let cur: string | null = id
  for (let i = 0; i < WALK_BOUND && cur; i++) {
    const row = parentOf.get(cur) as { parent_logical_item_id: string | null } | undefined
    cur = row ? row.parent_logical_item_id : null
    if (cur) depth++
  }
  return depth
}

// True if placing `child` under `candidate` would close a cycle — i.e. child is
// already an ancestor of candidate (or they are the same item).
export function wouldCycle(tx: WriteTx, candidate: string, child: string): boolean {
  const parentOf = tx.prepare(`SELECT parent_logical_item_id FROM logical_items_v2 WHERE id = ?`)
  let cur: string | null = candidate
  for (let i = 0; i < WALK_BOUND && cur; i++) {
    if (cur === child) return true
    const row = parentOf.get(cur) as { parent_logical_item_id: string | null } | undefined
    cur = row ? row.parent_logical_item_id : null
  }
  return false
}

function recordConflict(tx: WriteTx, logicalItemId: string, observationVersionId: string, kind: string, reference: NormalizedReplyReference, now: string): void {
  tx.prepare(
    `INSERT INTO logical_conflicts_v2 (id, logical_item_id, observation_version_id, kind, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), logicalItemId, observationVersionId, kind, JSON.stringify(reference), now)
}

export function resolveInitialParent(
  tx: WriteTx,
  input: { observationVersionId: string; reference: NormalizedReplyReference | null; logicalItemId: string; now?: string },
): ParentResolutionResult {
  const { observationVersionId, reference, logicalItemId } = input
  const now = input.now ?? new Date().toISOString()
  const ambiguous = (kind: string): ParentResolutionResult => {
    recordConflict(tx, logicalItemId, observationVersionId, kind, reference as NormalizedReplyReference, now)
    return { state: 'ambiguous', parentLogicalItemId: null }
  }

  if (!reference) return { state: 'none', parentLogicalItemId: null }

  let candidate: string | null
  if (reference.kind === 'permalink') {
    candidate = lookupOwner(tx, 'permalink', reference.key)
  } else if (!reference.scope) {
    // Unscoped opaque: no global-uniqueness fallback in live v2 (spec §4.1).
    return ambiguous('ambiguous_reference')
  } else {
    candidate = lookupOwner(tx, `opaque:${reference.scope.kind}:${reference.scope.id}`, reference.key)
  }

  // No owner yet — `missing` stays adoptable later (Task 7), not a conflict.
  if (candidate === null) return { state: 'missing', parentLogicalItemId: null }
  // A terminal deletion marker is never a valid new parent (spec §4.2).
  if (isDeletedMarker(tx, candidate)) return { state: 'missing', parentLogicalItemId: null }
  if (candidate === logicalItemId || wouldCycle(tx, candidate, logicalItemId)) return ambiguous('cycle')
  if (logicalDepth(tx, candidate) + 1 > MAX_DEPTH) return ambiguous('excessive_depth')
  return { state: 'resolved', parentLogicalItemId: candidate }
}
