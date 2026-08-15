import { randomUUID } from 'node:crypto'
import type { ReadTx, WriteTx } from './database.ts'
import { appendJournal, snapshotJournalCursor } from './journal.ts'
import { isStructuralTombstone } from './projector.ts'
import type {
  NormalizedReplyReference, ParentResolutionResult,
  NewOrphanWork, OrphanClaim, AdoptOrphansInput, AdoptOrphansResult,
  LogicalThreadEnvelope, LogicalItemDto,
} from './types.ts'

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

export function isDeletedMarker(tx: WriteTx, id: string): boolean {
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
  // A terminal deletion marker or a structural tombstone is never a valid new
  // parent (spec §4.2, §5.3) — both leave the reference `missing`, adoptable if a
  // live owner appears later.
  if (isDeletedMarker(tx, candidate) || isStructuralTombstone(tx, candidate)) return { state: 'missing', parentLogicalItemId: null }
  if (candidate === logicalItemId || wouldCycle(tx, candidate, logicalItemId)) return ambiguous('cycle')
  if (logicalDepth(tx, candidate) + 1 > MAX_DEPTH) return ambiguous('excessive_depth')
  return { state: 'resolved', parentLogicalItemId: candidate }
}

// ===========================================================================
// Durable late adoption — the orphan worker (spec §4.2)
// ===========================================================================
// Only `missing` references adopt automatically. A new resolvable alias schedules
// durable work bounded by a stable candidate high-water mark; work re-checks
// scope, cycle safety, and the subtree-aware depth bound in EVERY write
// transaction (state can change between batches), and each ripe candidate leaves
// the `missing` set (adopted -> resolved, or too-deep/cyclic/unprovable ->
// ambiguous), so batches make monotonic progress with no per-work cursor.

const SUBTREE_NODE_BOUND = 500

// ponytail: local copy of reconcile.ts/acquisition.ts's permalink normalization
// (hash-strip, http(s)-only). The orphan worker must key EXACTLY as convergence
// did when it minted the alias, or a missing item never matches its owner. All
// three copies are the same 6 lines; keep them in sync (a shared export would
// force reconcile.ts into this task's staged paths).
function normalizeReferencePermalink(raw: string | null): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

function buildReference(inReplyTo: string | null, publisherId: string): NormalizedReplyReference | null {
  if (!inReplyTo) return null
  const perma = normalizeReferencePermalink(inReplyTo)
  if (perma) return { kind: 'permalink', key: perma, scope: null, raw: inReplyTo }
  return { kind: 'opaque', key: inReplyTo, scope: { kind: 'publisher', id: publisherId }, raw: inReplyTo }
}

// The reference a `missing` item is waiting on, recomputed from its first-arrival
// evidence — the frozen schema stores no reference column, so this mirrors
// reconcile.ts's createRemoteItem derivation (its first publisher claim's
// observation-version normalized inReplyTo + that claim's publisher scope).
function awaitedReference(tx: ReadTx, itemId: string): NormalizedReplyReference | null {
  const row = tx.prepare(
    `SELECT pc.publisher_id, v.normalized_json
     FROM publisher_claims_v2 pc
     JOIN observation_versions_v2 v ON v.id = pc.observation_version_id
     WHERE pc.logical_item_id = ?
     ORDER BY v.arrival_at ASC, v.id ASC LIMIT 1`,
  ).get(itemId) as { publisher_id: string; normalized_json: string } | undefined
  if (!row) return null
  const inReplyTo = (JSON.parse(row.normalized_json) as { inReplyTo: string | null }).inReplyTo
  return buildReference(inReplyTo, row.publisher_id)
}

// The live logical item currently owning a reference's identity key, or null.
function referenceOwner(tx: ReadTx, ref: NormalizedReplyReference): string | null {
  if (ref.kind === 'permalink') return lookupOwner(tx, 'permalink', ref.key)
  if (!ref.scope) return null // unscoped opaque never resolves in live v2 (§4.1)
  return lookupOwner(tx, `opaque:${ref.scope.kind}:${ref.scope.id}`, ref.key)
}

// Bounded proof of an orphan's descendant subtree: the maximum depth below the
// orphan (orphan itself = 0), refusing to prove past SUBTREE_NODE_BOUND nodes or
// through a cycle (spec §4.2). Returns null when the maximum cannot be proven.
function proveSubtree(tx: ReadTx, orphanId: string): { maxDepth: number } | null {
  const childrenOf = tx.prepare(`SELECT id FROM logical_items_v2 WHERE parent_logical_item_id = ?`)
  const seen = new Set<string>()
  let maxDepth = 0
  let frontier: Array<{ id: string; depth: number }> = [{ id: orphanId, depth: 0 }]
  while (frontier.length) {
    const next: Array<{ id: string; depth: number }> = []
    for (const node of frontier) {
      if (seen.has(node.id)) return null // cycle
      seen.add(node.id)
      if (seen.size > SUBTREE_NODE_BOUND) return null // structural bound overrun
      if (node.depth > maxDepth) maxDepth = node.depth
      for (const c of childrenOf.all(node.id) as { id: string }[]) next.push({ id: c.id, depth: node.depth + 1 })
    }
    frontier = next
  }
  return { maxDepth }
}

// Adopt one ripe orphan under its (live) candidate parent, or transition it
// terminally to `ambiguous` with a conflict when cycle/depth/subtree checks fail.
// Only the direct parent edge changes (spec §4.2); an ambiguous item is never
// re-selected, so it cannot later adopt automatically.
function adoptOne(tx: WriteTx, orphanId: string, parentId: string, now: string): 'adopted' | 'ambiguous' {
  const ambiguate = (kind: string): 'ambiguous' => {
    tx.prepare(`UPDATE logical_items_v2 SET parent_state = 'ambiguous' WHERE id = ?`).run(orphanId)
    tx.prepare(
      `INSERT INTO logical_conflicts_v2 (id, logical_item_id, observation_version_id, kind, evidence_json, created_at)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    ).run(randomUUID(), orphanId, kind, JSON.stringify({ candidateParent: parentId }), now)
    return 'ambiguous'
  }
  if (parentId === orphanId || wouldCycle(tx, parentId, orphanId)) return ambiguate('adoption_cycle')
  const proof = proveSubtree(tx, orphanId)
  if (!proof) return ambiguate('adoption_unprovable_subtree')
  if (logicalDepth(tx, parentId) + 1 + proof.maxDepth > MAX_DEPTH) return ambiguate('adoption_excessive_depth')
  tx.prepare(`UPDATE logical_items_v2 SET parent_state = 'resolved', parent_logical_item_id = ? WHERE id = ?`).run(parentId, orphanId)
  return 'adopted'
}

// Persist orphan work when a new resolvable alias is minted. Called inside the
// caller's alias-minting write transaction (the tx is passed in), so scheduling
// commits atomically with the alias (spec §4.2).
export function scheduleOrphanWork(tx: WriteTx, input: NewOrphanWork): void {
  tx.prepare(
    `INSERT INTO orphan_work_v2 (id, alias_kind, alias_key, candidate_high_water, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(randomUUID(), input.aliasKind, input.aliasKey, input.candidateHighWater, input.createdAt)
}

export function claimOrphanWork(tx: WriteTx): OrphanClaim | null {
  const row = tx.prepare(
    `SELECT id, candidate_high_water FROM orphan_work_v2 WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 1`,
  ).get() as { id: string; candidate_high_water: string } | undefined
  if (!row) return null
  tx.prepare(`UPDATE orphan_work_v2 SET status = 'processing' WHERE id = ?`).run(row.id)
  return { workId: row.id, candidateHighWater: row.candidate_high_water }
}

export function adoptOrphans(tx: WriteTx, input: AdoptOrphansInput): AdoptOrphansResult {
  const { claim, now, limit } = input
  const work = tx.prepare(`SELECT candidate_high_water FROM orphan_work_v2 WHERE id = ?`).get(claim.workId) as { candidate_high_water: string } | undefined
  if (!work) return { adopted: 0, ambiguous: 0, remaining: false }

  // Candidate set: still-`missing` items created no later than the captured
  // high-water. Items created after scheduling resolve on their own initial
  // resolution (the alias now exists) and are deliberately excluded.
  const candidates = tx.prepare(
    `SELECT id FROM logical_items_v2 WHERE parent_state = 'missing' AND created_at <= ? ORDER BY created_at ASC, id ASC`,
  ).all(work.candidate_high_water) as { id: string }[]

  let adopted = 0
  let ambiguous = 0
  let ripeRemaining = false
  for (const { id } of candidates) {
    const ref = awaitedReference(tx, id)
    const owner = ref ? referenceOwner(tx, ref) : null
    // Not ripe: no live owner yet, or the only owner is a terminal deleted
    // marker or a structural tombstone (never a valid adoption target, spec
    // §2.6/§5.3). Leave it missing — it consumes no batch budget and does not
    // block completion.
    if (!owner || isDeletedMarker(tx, owner) || isStructuralTombstone(tx, owner)) continue
    if (adopted + ambiguous >= limit) { ripeRemaining = true; break }
    if (adoptOne(tx, id, owner, now) === 'adopted') adopted++
    else ambiguous++
  }
  // Exactly one reset per SUCCESSFUL batch (spec §4.2): adoption reparents whole
  // subtrees, so clients re-fetch via a single reset barrier rather than per-item
  // upserts. An ambiguation-only batch changes no ancestry edge and appends none.
  if (adopted > 0) appendJournal(tx, { kind: 'reset', changeMask: 'ancestry' }, now)
  // Complete only once every candidate through the high-water has been examined.
  if (!ripeRemaining) tx.prepare(`UPDATE orphan_work_v2 SET status = 'complete' WHERE id = ?`).run(claim.workId)
  return { adopted, ambiguous, remaining: ripeRemaining }
}

// ===========================================================================
// Structural-tombstone graph operations (spec §5.3) — Task 6
// ===========================================================================
// A remote logical node whose evidence a purge (or last-subscription cleanup)
// removed either vanishes entirely (unreferenced) or degrades to a structural
// tombstone (a surviving descendant references it). The tombstone retains ONLY
// logical ID, parent/root edges, and the immutable sort key; it is swept the
// moment the deletion of its last referencing descendant leaves it childless
// (`ponytail: swept at descendant-deletion time only; no background reaper`).

// True if any logical node still edges to `id` as its parent — the RESTRICT
// self-edge that blocks a full node deletion.
export function hasChildEdge(tx: WriteTx, id: string): boolean {
  return tx.prepare(`SELECT 1 FROM logical_items_v2 WHERE parent_logical_item_id = ? LIMIT 1`).get(id) !== undefined
}

// Delete a remote logical node and every row that references it (its identity
// keys, claims, conflicts, item-audit, verification checks, and the never-present
// local-only children — defensive, so the inventory names every logical_items_v2
// child). The caller guarantees no surviving descendant edges to it.
export function deleteLogicalNode(tx: WriteTx, id: string): void {
  tx.prepare(`DELETE FROM logical_identity_keys_v2 WHERE logical_item_id = ?`).run(id)
  tx.prepare(`DELETE FROM publisher_claims_v2 WHERE logical_item_id = ?`).run(id)
  tx.prepare(`DELETE FROM logical_conflicts_v2 WHERE logical_item_id = ?`).run(id)
  tx.prepare(`DELETE FROM item_audit_v2 WHERE logical_item_id = ?`).run(id)
  tx.prepare(`DELETE FROM verification_checks_v2 WHERE logical_item_id = ?`).run(id)
  tx.prepare(`DELETE FROM logical_deleted_local_v2 WHERE logical_item_id = ?`).run(id)
  tx.prepare(`DELETE FROM logical_local_origins_v2 WHERE logical_item_id = ?`).run(id)
  tx.prepare(`DELETE FROM logical_items_v2 WHERE id = ?`).run(id)
}

// Convert a remote node to a structural tombstone: strip all content/author/
// source/publisher/evidence/moderation, keep the row + its parent/root edge +
// immutable sort key (spec §5.3). NOT applied to local items — those become
// deleted_local markers instead (the anchor asymmetry, spec §5.3).
export function convertToStructuralTombstone(tx: WriteTx, id: string): void {
  tx.prepare(`DELETE FROM logical_identity_keys_v2 WHERE logical_item_id = ?`).run(id)
  tx.prepare(`DELETE FROM publisher_claims_v2 WHERE logical_item_id = ?`).run(id)
  tx.prepare(`DELETE FROM logical_conflicts_v2 WHERE logical_item_id = ?`).run(id)
  tx.prepare(`DELETE FROM verification_checks_v2 WHERE logical_item_id = ?`).run(id)
  tx.prepare(`UPDATE logical_items_v2 SET structural_tombstone = 1, selected_delivery_id = NULL, selected_publisher_id = NULL, hidden_at = NULL WHERE id = ?`).run(id)
}

// Sweep the tombstone chain above the parents of just-deleted nodes: a structural
// tombstone with no remaining child edge is deleted, and the sweep continues up to
// ITS parent (a chain of tombstones collapses in one pass). A non-tombstone parent,
// or a tombstone that still has children, stops the walk. Called from the existing
// descendant-deletion paths in local.ts and from purge itself (tombstones.ts).
export function sweepStructuralTombstones(tx: WriteTx, parentIds: Array<string | null>, _now: string): void {
  for (const start of parentIds) {
    let cur: string | null = start
    while (cur) {
      const row = tx.prepare(`SELECT structural_tombstone, parent_logical_item_id FROM logical_items_v2 WHERE id = ?`).get(cur) as { structural_tombstone: number; parent_logical_item_id: string | null } | undefined
      if (!row || row.structural_tombstone !== 1 || hasChildEdge(tx, cur)) break
      const next = row.parent_logical_item_id
      deleteLogicalNode(tx, cur)
      cur = next
    }
  }
}

// ===========================================================================
// Bounded thread projection (spec §4.3)
// ===========================================================================
// Walk UP to the derived root, load the bounded descendant graph (STRUCTURAL
// bounds first), then apply visibility (POLICY) via the injected per-item
// projector. Roots are derived, never stored. The projector returns undefined
// for any item that is not ordinary-visible; Task 8 supplies the real one.

const THREAD_NODE_BUDGET = 500

interface ThreadNode {
  id: string
  parent: string | null
  timelineSortAt: string
  depth: number // measured from the top of the reserved path (the root when reached)
}

type ItemRow = { id: string; parent_state: string; parent_logical_item_id: string | null; timeline_sort_at: string }

export function projectThread(
  tx: ReadTx,
  requestedLogicalItemId: string,
  projectItem: (id: string) => LogicalItemDto | undefined,
): LogicalThreadEnvelope | undefined {
  const itemRow = tx.prepare(`SELECT id, parent_state, parent_logical_item_id, timeline_sort_at FROM logical_items_v2 WHERE id = ?`)
  const childrenOf = tx.prepare(`SELECT id, parent_logical_item_id, timeline_sort_at FROM logical_items_v2 WHERE parent_logical_item_id = ?`)
  const requested = itemRow.get(requestedLogicalItemId) as ItemRow | undefined
  if (!requested) return undefined // the item does not exist -> ordinary 404

  const truncated = { depth: false, nodes: false, cycle: false }

  // --- 1. bounded upward walk to the derived root --------------------------
  const climbed: Array<{ id: string; parent: string | null; timelineSortAt: string }> = []
  const seenUp = new Set<string>()
  let rootReached = false
  let cur: ItemRow | undefined = requested
  while (cur) {
    if (seenUp.has(cur.id)) { truncated.cycle = true; break }
    seenUp.add(cur.id)
    climbed.push({ id: cur.id, parent: cur.parent_logical_item_id, timelineSortAt: cur.timeline_sort_at })
    if (cur.parent_state !== 'resolved' || !cur.parent_logical_item_id) { rootReached = true; break }
    if (climbed.length > MAX_DEPTH) { truncated.depth = true; break } // more than 64 edges from requested
    cur = itemRow.get(cur.parent_logical_item_id) as ItemRow | undefined
  }
  // climbed is [requested .. top]; the reserved path is root-to-requested.
  const path = climbed.slice().reverse()
  const rootId = rootReached ? path[0].id : null

  // --- 2. collect the bounded structural node set (path + descendants) -----
  const nodes = new Map<string, ThreadNode>()
  path.forEach((n, idx) => nodes.set(n.id, { id: n.id, parent: n.parent, timelineSortAt: n.timelineSortAt, depth: idx }))
  const requestedDepth = nodes.get(requestedLogicalItemId)!.depth

  // Fill the remaining budget breadth-first by depth, siblings by
  // (timelineSortAt ASC, logicalItemId ASC). The reserved path already counts.
  let level: ThreadNode[] = (childrenOf.all(requestedLogicalItemId) as { id: string; parent_logical_item_id: string; timeline_sort_at: string }[])
    .map((c) => ({ id: c.id, parent: c.parent_logical_item_id, timelineSortAt: c.timeline_sort_at, depth: requestedDepth + 1 }))
  outer: while (level.length) {
    level.sort(byOrder)
    const nextLevel: ThreadNode[] = []
    for (const node of level) {
      if (nodes.has(node.id)) { truncated.cycle = true; continue } // diamond/cycle
      if (node.depth > MAX_DEPTH) { truncated.depth = true; continue }
      if (nodes.size >= THREAD_NODE_BUDGET) { truncated.nodes = true; break outer } // 501st sentinel, not returned
      nodes.set(node.id, node)
      for (const c of childrenOf.all(node.id) as { id: string; parent_logical_item_id: string; timeline_sort_at: string }[]) {
        nextLevel.push({ id: c.id, parent: c.parent_logical_item_id, timelineSortAt: c.timeline_sort_at, depth: node.depth + 1 })
      }
    }
    level = nextLevel
  }

  // --- 3. apply visibility (policy) after the structural bounds ------------
  const dto = new Map<string, LogicalItemDto>()
  for (const id of nodes.keys()) {
    const d = projectItem(id)
    if (d) dto.set(id, d)
  }
  // collected parent->children within the bounded set (a tree — cycle nodes
  // were never added), used to prune branches with no ordinary-visible node.
  const childrenWithin = new Map<string, string[]>()
  for (const n of nodes.values()) {
    if (n.parent && nodes.has(n.parent)) {
      const arr = childrenWithin.get(n.parent) ?? []
      arr.push(n.id)
      childrenWithin.set(n.parent, arr)
    }
  }
  const keepMemo = new Map<string, boolean>()
  const keepDescendant = (id: string): boolean => {
    const memo = keepMemo.get(id)
    if (memo !== undefined) return memo
    let keep = dto.has(id)
    for (const c of childrenWithin.get(id) ?? []) if (keepDescendant(c)) keep = true
    keepMemo.set(id, keep)
    return keep
  }
  // An unavailable requested item is returned only when its placeholder connects
  // ordinary-visible descendants; an unavailable leaf (no visible descendant) is
  // an ordinary 404 even with visible ancestors (spec §4.3).
  if (!keepDescendant(requestedLogicalItemId)) return undefined

  // --- 4. assemble kept nodes: reserved ancestors (connective) + kept D ----
  const kept: string[] = []
  for (const n of nodes.values()) {
    if (n.depth < requestedDepth) kept.push(n.id) // reserved ancestor path
    else if (keepDescendant(n.id)) kept.push(n.id) // requested + surviving descendants
  }
  kept.sort((a, b) => byOrder(nodes.get(a)!, nodes.get(b)!))

  const out: LogicalThreadEnvelope['nodes'] = kept.map((id) => {
    const d = dto.get(id)
    if (d) return { kind: 'item', item: d }
    const n = nodes.get(id)!
    return { kind: 'placeholder', logicalItemId: id, parentLogicalItemId: n.parent, timelineSortAt: n.timelineSortAt, placeholderKind: 'unavailable' }
  })

  return {
    model: 'logical-v2',
    requestedLogicalItemId,
    rootId,
    nodes: out,
    truncated,
    journalCursor: snapshotJournalCursor(tx),
  }
}

// Thread ordering: depth ascending, then (timelineSortAt ASC, logicalItemId ASC).
function byOrder(a: ThreadNode, b: ThreadNode): number {
  if (a.depth !== b.depth) return a.depth - b.depth
  if (a.timelineSortAt !== b.timelineSortAt) return a.timelineSortAt < b.timelineSortAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
