import { randomUUID } from 'node:crypto'
import type { ReadTx, WriteTx } from './database.ts'
import type { CommandEnvelope, AuditCategory } from '../domain/types.ts'
import { checkCommand, storeCommand } from '../domain/source-repository.ts'
import { appendJournal } from './journal.ts'
import { projectItem } from './projector.ts'
import { applySelectionHints } from './reconcile.ts'
import { deleteLogicalNode, convertToStructuralTombstone, hasChildEdge, sweepStructuralTombstones } from './threading.ts'
import type { ProjectionViewer } from './types.ts'

// V3 Task 6 — purge and structural tombstones (spec §5). Purge is an
// administrator command valid ONLY against a blocked source; it deletes the
// source's evidence in FK order (the inventory below), writes a terminal
// tombstone + one alias per source_aliases_v2 row (copied BEFORE the source-row
// deletion cascades the originals away), converts descendant-referenced remote
// ancestors into structural tombstones, and appends exactly ONE journal reset.
//
// ponytail: one transaction, no chunked purge; a single-user instance's worst
// source fits comfortably in one SQLite write transaction (spec §5.2).

// --- purge command types (owned here; types.ts is off this task's staged set,
//     mirroring fanout.ts owning FanoutClaim — plan File map names them) -------
export interface PurgeCommandInput { command: CommandEnvelope; sourceId: string; category: AuditCategory; note: string | null; now: string }
export type PurgeResult =
  | { kind: 'purged'; tombstoneId: string }
  | { kind: 'unknown' | 'not_blocked' | 'conflict' }

// Unblock command types (owned here alongside purge; types.ts is off this task's
// staged set — same fanout.ts precedent). The success result carries the audit
// facts (action + tombstone identity + category + note): the command_ledger_v2
// row IS the audit, so result_json is where those live.
// ponytail: the ledger row is the audit; a standalone FK-less audit table adds nothing.
export interface UnblockCommandInput { command: CommandEnvelope; tombstoneId: string; category: AuditCategory; note: string | null; now: string }
export type UnblockResult =
  | { kind: 'unblocked'; action: 'unblock'; tombstoneId: string; canonicalUrl: string; category: AuditCategory; note: string | null }
  | { kind: 'unknown' | 'conflict' }

// --- the FK-graph deletion inventory (spec §5.2, plan rev 2 RC2) -------------
// The purge inventory is DERIVED from the FK graph: every blocking (RESTRICT or
// NO ACTION) child of a row purge deletes must be deleted first, else the parent
// DELETE FK-throws. PURGE_ROOT_TABLES are the five tables purge deletes rows from;
// PURGE_INVENTORY is the exact set of their blocking children — every table
// removeSourceEvidence/deleteLogicalNode issues a DELETE against. The
// `logical-purge` walking test asserts PURGE_INVENTORY names EVERY blocking edge
// pointing at a root table, so a future child table breaks THAT test instead of a
// production purge.
export const PURGE_ROOT_TABLES: ReadonlySet<string> = new Set([
  'remote_sources_v2', 'deliveries_v2', 'observation_versions_v2', 'remote_publishers_v2', 'logical_items_v2',
])
export const PURGE_INVENTORY: ReadonlySet<string> = new Set([
  // children of remote_sources_v2
  'acquisition_runs_v2', 'deliveries_v2', 'publisher_claims_v2', 'publisher_names_v2',
  'source_health_v2', 'source_validators_v2', 'policy_fanout_v2', 'verification_checks_v2',
  // children of deliveries_v2 / observation_versions_v2
  'observation_versions_v2', 'presentation_entries_v2', 'logical_conflicts_v2', 'reconciliation_jobs_v2',
  // children of remote_publishers_v2
  'publisher_feed_aliases_v2',
  // logical_items_v2 itself: a purged item row is a child of remote_publishers_v2
  // (selected_publisher_id) and of logical_items_v2 (the parent self-edge); per-item
  // deletion/conversion handles it (leaves before parents).
  'logical_items_v2',
  // children of logical_items_v2 (deleted per node; local-only children never
  // present on a remote node but named so the inventory is FK-complete)
  'item_audit_v2', 'logical_identity_keys_v2', 'logical_deleted_local_v2', 'logical_local_origins_v2',
])

const ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }

// Write the terminal block+purge tombstone and copy the source's aliases into
// tombstone_aliases_v2 BEFORE the source-row deletion cascades source_aliases_v2
// away (spec §5.1-5.2). Column-named INSERTs. Returns the tombstone id.
export function writePurgeTombstone(
  tx: WriteTx,
  input: { sourceId: string; canonicalUrl: string; category: AuditCategory; note: string | null; actorId: string | null; now: string },
): string {
  const id = randomUUID()
  tx.prepare(
    `INSERT INTO blocked_source_tombstones_v2 (id, canonical_url, action, category, actor_id, note, created_at, updated_at)
     VALUES (?, ?, 'purge', ?, ?, ?, ?, ?)`,
  ).run(id, input.canonicalUrl, input.category, input.actorId, input.note, input.now, input.now)
  const aliases = tx.prepare(`SELECT url FROM source_aliases_v2 WHERE source_id = ?`).all(input.sourceId) as { url: string }[]
  for (const a of aliases) {
    tx.prepare(`INSERT INTO tombstone_aliases_v2 (url, tombstone_id, created_at) VALUES (?, ?, ?)`).run(a.url, id, input.now)
  }
  return id
}

// The shared step-4 helper (spec §5.2 step 2-4): delete a source's evidence in FK
// order, apply the per-item reselect/delete/tombstone rules, delete fully
// unreferenced publishers, then the source row (its aliases/subscriptions/
// federation/audit cascade). Task 7's last-subscription cleanup reuses this
// VERBATIM (it writes no tombstone and appends the reset conditionally on the
// returned `ordinaryAffected`). Writes NO journal effect — the caller owns that.
export function removeSourceEvidence(tx: WriteTx, input: { sourceId: string; now: string }): { ordinaryAffected: boolean } {
  const { sourceId, now } = input

  // ---- capture the affected set + pre-state BEFORE any deletion -----------
  const affected = new Set<string>()
  for (const r of tx.prepare(
    `SELECT DISTINCT logical_item_id AS id FROM logical_identity_keys_v2
     WHERE kind = 'delivery' AND key IN (SELECT id FROM deliveries_v2 WHERE source_id = ?)`,
  ).all(sourceId) as { id: string }[]) affected.add(r.id)
  for (const r of tx.prepare(`SELECT DISTINCT logical_item_id AS id FROM publisher_claims_v2 WHERE source_id = ?`).all(sourceId) as { id: string }[]) affected.add(r.id)

  // an affected item was ordinarily visible ⇒ its removal/reselection changes
  // ordinary state (drives the caller's conditional reset in cleanup)
  let ordinaryAffected = false
  for (const id of affected) if (projectItem(tx, id, ANON) !== undefined) { ordinaryAffected = true; break }

  // candidate publishers: those this source's names/claims reference (checked for
  // full unreferencedness AFTER the deletions)
  const candidatePublishers = new Set<string>()
  for (const r of tx.prepare(`SELECT DISTINCT publisher_id AS id FROM publisher_claims_v2 WHERE source_id = ?`).all(sourceId) as { id: string }[]) candidatePublishers.add(r.id)
  for (const r of tx.prepare(`SELECT DISTINCT publisher_id AS id FROM publisher_names_v2 WHERE source_id = ?`).all(sourceId) as { id: string }[]) candidatePublishers.add(r.id)

  // ---- delete the source's evidence, children before parents (FK order) ---
  const runs = `(SELECT id FROM acquisition_runs_v2 WHERE source_id = @s)`
  const dels = `(SELECT id FROM deliveries_v2 WHERE source_id = @s)`
  const vers = `(SELECT v.id FROM observation_versions_v2 v JOIN deliveries_v2 d ON d.id = v.delivery_id WHERE d.source_id = @s)`
  const bind = { s: sourceId }
  tx.prepare(`DELETE FROM reconciliation_jobs_v2 WHERE run_id IN ${runs} OR observation_version_id IN ${vers}`).run(bind)
  tx.prepare(`DELETE FROM redirect_observations_v2 WHERE run_id IN ${runs}`).run(bind)
  tx.prepare(`DELETE FROM acquisition_findings_v2 WHERE run_id IN ${runs}`).run(bind)
  tx.prepare(`DELETE FROM acquisition_commands_v2 WHERE run_id IN ${runs}`).run(bind)
  tx.prepare(`DELETE FROM presentation_entries_v2 WHERE delivery_id IN ${dels}`).run(bind)
  tx.prepare(`DELETE FROM publisher_claims_v2 WHERE source_id = @s OR observation_version_id IN ${vers}`).run(bind)
  tx.prepare(`DELETE FROM logical_conflicts_v2 WHERE observation_version_id IN ${vers}`).run(bind)
  tx.prepare(`DELETE FROM verification_checks_v2 WHERE source_id = @s`).run(bind)
  // verification jobs whose every check has now been removed (they FK-reference
  // nothing being deleted; a dangling job would keep re-fetching an origin URL)
  tx.prepare(`DELETE FROM reconciliation_jobs_v2 WHERE kind = 'verification' AND verification_batch_key NOT IN (SELECT DISTINCT batch_key FROM verification_checks_v2)`).run()
  tx.prepare(`DELETE FROM observation_versions_v2 WHERE delivery_id IN ${dels}`).run(bind)
  tx.prepare(`DELETE FROM logical_identity_keys_v2 WHERE kind = 'delivery' AND key IN ${dels}`).run(bind)
  tx.prepare(`DELETE FROM deliveries_v2 WHERE source_id = @s`).run(bind)
  tx.prepare(`DELETE FROM publisher_names_v2 WHERE source_id = @s`).run(bind)
  tx.prepare(`DELETE FROM source_health_v2 WHERE source_id = @s`).run(bind)
  tx.prepare(`DELETE FROM source_validators_v2 WHERE source_id = @s`).run(bind)
  tx.prepare(`DELETE FROM acquisition_runs_v2 WHERE source_id = @s`).run(bind)
  tx.prepare(`DELETE FROM policy_fanout_v2 WHERE source_id = @s`).run(bind)

  // ---- per-item effects (spec §5.2 step 4) --------------------------------
  const hasDelivery = (id: string): boolean =>
    tx.prepare(`SELECT 1 FROM logical_identity_keys_v2 WHERE kind = 'delivery' AND logical_item_id = ? LIMIT 1`).get(id) !== undefined
  const unsupported = new Set<string>()
  for (const id of affected) {
    if (hasDelivery(id)) applySelectionHints(tx, id, '') // other deliveries remain ⇒ reselect
    else unsupported.add(id)
  }
  // delete unsupported leaves to a fixpoint; a surviving descendant edge blocks a
  // node (RESTRICT), so it is left for tombstone conversion. Deleting a leaf can
  // free its parent, so iterate until nothing more deletes.
  const deletedParents: Array<string | null> = []
  let changed = true
  while (changed) {
    changed = false
    for (const id of [...unsupported]) {
      if (hasChildEdge(tx, id)) continue
      const row = tx.prepare(`SELECT parent_logical_item_id AS p FROM logical_items_v2 WHERE id = ?`).get(id) as { p: string | null } | undefined
      deleteLogicalNode(tx, id)
      unsupported.delete(id)
      deletedParents.push(row ? row.p : null)
      changed = true
    }
  }
  // remaining unsupported items still have a surviving descendant → tombstone
  for (const id of unsupported) convertToStructuralTombstone(tx, id)
  // sweep any PRE-EXISTING structural tombstone left childless by the deletions
  sweepStructuralTombstones(tx, deletedParents, now)

  // ---- delete fully-unreferenced publishers (spec §5.2 step 4) ------------
  for (const p of candidatePublishers) {
    const referenced = tx.prepare(`SELECT 1 FROM publisher_claims_v2 WHERE publisher_id = ? LIMIT 1`).get(p)
      || tx.prepare(`SELECT 1 FROM publisher_names_v2 WHERE publisher_id = ? LIMIT 1`).get(p)
      || tx.prepare(`SELECT 1 FROM logical_items_v2 WHERE selected_publisher_id = ? LIMIT 1`).get(p)
    if (referenced) continue
    tx.prepare(`DELETE FROM publisher_feed_aliases_v2 WHERE publisher_id = ?`).run(p)
    tx.prepare(`DELETE FROM remote_publishers_v2 WHERE id = ?`).run(p)
  }

  // ---- delete the source row (aliases/subscriptions/federation/audit cascade)
  tx.prepare(`DELETE FROM remote_sources_v2 WHERE id = ?`).run(sourceId)
  return { ordinaryAffected }
}

// The purge command (spec §5.2): one ledger-backed transaction. A non-blocked or
// unknown source refuses without writing anything (the guard runs before the
// tombstone). The single reset is the uniform barrier — block already made this
// evidence ineligible, so purge changes no ordinary visibility.
export function purgeSource(tx: WriteTx, input: PurgeCommandInput): PurgeResult {
  const check = checkCommand<PurgeResult>(tx, input.command)
  if (check.kind === 'replay') return check.result
  if (check.kind === 'conflict') return { kind: 'conflict' }

  const result = decide(tx, input)
  storeCommand(tx, input.command, result, input.now) // durable: an identical retry replays this
  return result
}

function decide(tx: WriteTx, input: PurgeCommandInput): PurgeResult {
  const src = tx.prepare(`SELECT canonical_url, governance FROM remote_sources_v2 WHERE id = ?`).get(input.sourceId) as { canonical_url: string; governance: string } | undefined
  if (!src) return { kind: 'unknown' }
  if (src.governance !== 'blocked') return { kind: 'not_blocked' }

  const tombstoneId = writePurgeTombstone(tx, {
    sourceId: input.sourceId, canonicalUrl: src.canonical_url, category: input.category,
    note: input.note, actorId: input.command.actorId, now: input.now,
  })
  removeSourceEvidence(tx, { sourceId: input.sourceId, now: input.now })
  appendJournal(tx, { kind: 'reset', changeMask: 'barrier' }, input.now)
  return { kind: 'purged', tombstoneId }
}

// Source resolution (subscribe, OPML, federation, every redirect hop) checks
// tombstones AND tombstone aliases and returns the generic unavailable result
// (spec §5.1). Task 7 is the first caller. A tombstoned URL is indistinguishable
// from any other unavailable URL — no oracle.
export function isTombstoned(tx: ReadTx, url: string): boolean {
  if (tx.prepare(`SELECT 1 FROM blocked_source_tombstones_v2 WHERE canonical_url = ? LIMIT 1`).get(url)) return true
  if (tx.prepare(`SELECT 1 FROM tombstone_aliases_v2 WHERE url = ? LIMIT 1`).get(url)) return true
  return false
}

// The unblock command (spec §5): ONE ledger-backed transaction. It deletes the
// tombstone and its alias rows (tombstone_aliases_v2 also cascade via ON DELETE
// CASCADE — deleted explicitly for clarity), creating NO source; the next
// resolution of that URL is an ordinary fresh creation. Requires a category
// (remediated is its first emitter). No item/source audit row — the ledger row
// (with result_json carrying action + note + tombstone identity) is the audit.
export function unblockTombstone(tx: WriteTx, input: UnblockCommandInput): UnblockResult {
  const check = checkCommand<UnblockResult>(tx, input.command)
  if (check.kind === 'replay') return check.result
  if (check.kind === 'conflict') return { kind: 'conflict' }

  const result = decideUnblock(tx, input)
  storeCommand(tx, input.command, result, input.now) // durable: an identical retry replays this
  return result
}

function decideUnblock(tx: WriteTx, input: UnblockCommandInput): UnblockResult {
  const row = tx.prepare(`SELECT canonical_url FROM blocked_source_tombstones_v2 WHERE id = ?`).get(input.tombstoneId) as { canonical_url: string } | undefined
  if (!row) return { kind: 'unknown' }
  tx.prepare(`DELETE FROM tombstone_aliases_v2 WHERE tombstone_id = ?`).run(input.tombstoneId)
  tx.prepare(`DELETE FROM blocked_source_tombstones_v2 WHERE id = ?`).run(input.tombstoneId)
  return { kind: 'unblocked', action: 'unblock', tombstoneId: input.tombstoneId, canonicalUrl: row.canonical_url, category: input.category, note: input.note }
}
