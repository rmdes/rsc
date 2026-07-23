import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { encodeCursor as encodeTupleCursor, decodeCursor as decodeTupleCursor } from './cursor.ts'
import type { CommandEnvelope, RemoteSource, SourceSubscription, SourceAuditEvent, Page, SourceSummary, SourceDetail, OwnerSourceFollow, PublicLocalFollow, OwnerFollowingView, PublicFollowingEntry, AttributionMode, AuditCategory, FederationRelationship, FederationStatus, SourceGovernance, SourceOperation, SourceTransitionResult } from './types.ts'

// Plain assignment instead of a parameter property everywhere in this file:
// Node's native type stripping can't erase parameter properties (core/CLAUDE.md).
type Db = InstanceType<typeof Database>

export interface Cursor { createdAt: string; id: string }

// Owner-projected outcome of a subscribe command — never carries governance
// detail beyond 'available'/'awaiting_review'/'unavailable' (design §4:
// quarantined/blocked reveal nothing about why).
export type SubscribeResult =
  | { kind: 'source'; created: boolean; subscription: OwnerSourceFollow }
  | { kind: 'local'; created: boolean; follow: PublicLocalFollow }
  | { kind: 'unavailable' | 'not_subscribable' | 'cap' | 'conflict' }

// Owner-projected outcome of the batch OPML import command (Task 4) — the
// counting analogue of SubscribeResult for a mixed local/remote import.
// unavailable folds both pre-write SSRF/URL-parse rejects and any blocked
// source found during the write into one generic bucket (design §4: blocked
// and never-existed must look identical to the caller).
export interface ImportSourcesResult {
  localFollowed: number
  active: number
  pending: number
  unavailable: number
  notSubscribable: number
  capSkipped: number
}

// Outcome of the unsubscribe command (Task 5). 'unknown' means no matching
// subscription exists for (ownerId, sourceId) — still ledgered, same as every
// other negative result in this file, so a retry replays instead of re-reading.
export type UnsubscribeResult = { kind: 'removed'; sourceRemoved: boolean } | { kind: 'unknown' | 'conflict' }

// Outcome of administrator federation establishment (Task 6). 'exists' means the
// resolved source already carries a relationship — a second, different command
// converges on the one row (federation_relationships_v2's PK is source_id);
// 'unavailable' is the blocked source, which reveals nothing more (design §4).
export type EstablishFederationResult =
  | { kind: 'established'; source: RemoteSource; federation: FederationRelationship }
  | { kind: 'exists' | 'unavailable' | 'conflict' }

export type SourceTransitionAction =
  | 'pause' | 'resume' | 'quarantine' | 'allow' | 'approve' | 'reject' | 'revoke'
  | 'block' | 'unblock' | 'set_attribution_mode'

// The three independent lifecycle axes (design §5). A transition patches the
// axes it names and preserves the rest: a pause never touches governance, a
// quarantine never touches operation.
export interface SourceAxes {
  operation: SourceOperation
  governance: SourceGovernance
  federation: 'none' | FederationStatus
}

// The COMPLETE transition matrix (rev 5, review Finding 5 — every cell is
// pinned). null = invalid transition, which is refused as a conflict and writes
// nothing. Deliberate, non-obvious cells:
//   - block is permitted from quarantined as well as allowed: it applies
//     regardless of operation and is not restricted to allowed (design §5);
//   - quarantine/allow from blocked are refused — the only source-governance
//     exits from blocked are explicit unblock or purge;
//   - unblock returns a source to quarantine, never straight to allowed;
//   - approve needs a non-blocked source and lifts a quarantined candidate to
//     allowed; reject/revoke stay permitted while blocked (they only end a
//     relationship), and so do pause/resume (the operation axis is independent).
export const SOURCE_TRANSITIONS: Record<SourceTransitionAction, (a: SourceAxes) => Partial<SourceAxes> | null> = {
  pause: (a) => (a.operation === 'enabled' ? { operation: 'paused' } : null),
  resume: (a) => (a.operation === 'paused' ? { operation: 'enabled' } : null),
  quarantine: (a) => (a.governance === 'allowed' ? { governance: 'quarantined' } : null),
  allow: (a) => (a.governance === 'quarantined' ? { governance: 'allowed' } : null),
  approve: (a) =>
    a.federation === 'pending' && a.governance !== 'blocked'
      ? { federation: 'approved', governance: a.governance === 'quarantined' ? 'allowed' : a.governance }
      : null,
  reject: (a) => (a.federation === 'pending' ? { federation: 'none' } : null),
  revoke: (a) => (a.federation === 'approved' ? { federation: 'none' } : null),
  block: (a) => (a.governance !== 'blocked' ? { governance: 'blocked' } : null),
  unblock: (a) => (a.governance === 'blocked' ? { governance: 'quarantined' } : null),
  // Mode is not an axis of this table; the caller-supplied attributionMode is
  // applied (and its subscription effect run) alongside the empty patch.
  set_attribution_mode: () => ({}),
}

// pause/resume are operational rather than moderation decisions, so they alone
// may carry a null category (design §5); every other action requires one.
export const CATEGORY_OPTIONAL_ACTIONS: ReadonlySet<SourceTransitionAction> = new Set<SourceTransitionAction>(['pause', 'resume'])

export interface SourceRepository {
  getSource(id: string): Promise<RemoteSource | undefined>
  listSourceSummaries(cursor: Cursor | undefined, limit: number): Promise<Page<SourceSummary>>
  getSourceDetail(id: string): Promise<SourceDetail | undefined>
  listSourceSubscriptions(sourceId: string, cursor: Cursor | undefined, limit: number): Promise<Page<SourceSubscription>>
  listSourceAudit(sourceId: string, cursor: Cursor | undefined, limit: number): Promise<Page<SourceAuditEvent>>
  // Each is a single ledger-backed BEGIN IMMEDIATE transaction (Task 3).
  followLocalAccount(input: { command: CommandEnvelope; ownerId: string; targetId: string; now: string }): Promise<SubscribeResult>
  resolveAndSubscribeSource(input: { command: CommandEnvelope; ownerId: string; canonicalUrl: string; cap: number; now: string }): Promise<SubscribeResult>
  // One ledger-backed BEGIN IMMEDIATE transaction for the whole import (Task
  // 4). Parsing, local-feed resolution, normalization, and SSRF checks all
  // happen in source-service.ts BEFORE this is called — this method only
  // writes: ledger check, local follows, resolve/create sources, cap, store.
  importSourceSubscriptions(input: {
    command: CommandEnvelope
    ownerId: string
    localTargetIds: string[]
    canonicalUrls: string[]
    unavailableCount: number
    cap: number
    now: string
  }): Promise<ImportSourcesResult | { kind: 'conflict' }>

  // Ordinary reads (Task 5) — plain queries, not commands. Never project
  // governance/operation/provenance/provenanceNote/adminRetained/audit/counts;
  // see OwnerSourceFollow/PublicFollowingEntry in types.ts for the frozen shapes.
  ownerFollowing(ownerId: string): Promise<OwnerFollowingView>
  publicFollowing(ownerId: string): Promise<PublicFollowingEntry[]>

  // One ledger-backed BEGIN IMMEDIATE transaction (Task 5): ledger check,
  // delete the subscription, evaluate last-subscription retention
  // (reapSourceIfOrphaned), store, commit.
  unsubscribe(input: { command: CommandEnvelope; ownerId: string; sourceId: string; now: string }): Promise<UnsubscribeResult>

  // Two more ledger-backed BEGIN IMMEDIATE transactions (Task 6). Each writes
  // exactly one audit row and one ledger row on success; a conflict writes
  // nothing at all, not even to the ledger.
  establishFederation(input: {
    command: CommandEnvelope
    canonicalUrl: string
    attributionMode: AttributionMode
    category: AuditCategory
    note: string | null
    actorKind: 'administrator'
    now: string
  }): Promise<EstablishFederationResult>
  transition(input: {
    command: CommandEnvelope
    sourceId: string
    action: SourceTransitionAction
    category: AuditCategory | null
    note: string | null
    attributionMode?: AttributionMode
    actorKind: 'administrator' | 'system'
    now: string
  }): Promise<SourceTransitionResult>
}

// Every mutation command's requestFingerprint is SHA-256 of [operation, ...parts]
// — never secrets. Shared so later verticals (Task 4 OPML, Task 6 federation)
// fingerprint identically instead of re-deriving the scheme.
export function fingerprintRequest(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

// Cursor = the displayed (created_at, id) pair — the exact tuple every v2
// listing orders DESC by, so ties on created_at still resolve deterministically
// off the stable id. These are thin adapters over the ONE shared tuple codec in
// ./cursor.ts (Task 2 correction A, 2026-07-23): both verticals encode through
// the neutral module, so this V1 source plane never imports the logical
// vertical. decodeCursor preserves throw-on-bad-input so app.ts's 400 path is
// unchanged. The opaque wire format changed with the unification — safe today
// (opaque + ephemeral + nothing deployed), FROZEN after the first deploy.
export function encodeCursor(c: Cursor): string {
  return encodeTupleCursor(1, [c.createdAt, c.id])
}

export function decodeCursor(s: string): Cursor {
  const decoded = decodeTupleCursor(s)
  if (!decoded || decoded.tuple.length !== 2) throw new Error('cursor invalid')
  return { createdAt: decoded.tuple[0], id: decoded.tuple[1] }
}

export function clampLimit(n: number): number {
  return Math.max(1, Math.min(100, Math.trunc(n)))
}

export type LedgerCheck<T> = { kind: 'new' } | { kind: 'replay'; result: T } | { kind: 'conflict' }

interface LedgerRow { request_fingerprint: string; result_json: string }

// Runs INSIDE the caller's own BEGIN IMMEDIATE transaction — never opens one
// itself. Every later mutation composes checkCommand then, if 'new', does its
// writes and finishes with storeCommand, all inside one transaction() callback
// on the same `tx` handle. Same (actorScope,actorId,commandId) key with the
// same requestFingerprint replays the stored result; a changed fingerprint on
// the same key conflicts and writes nothing.
export function checkCommand<T>(tx: Db, command: CommandEnvelope): LedgerCheck<T> {
  const row = tx.prepare(
    `SELECT request_fingerprint, result_json FROM command_ledger_v2
     WHERE actor_scope = ? AND actor_id = ? AND command_id = ?`,
  ).get(command.actorScope, command.actorId, command.commandId) as LedgerRow | undefined
  if (!row) return { kind: 'new' }
  if (row.request_fingerprint !== command.requestFingerprint) return { kind: 'conflict' }
  return { kind: 'replay', result: JSON.parse(row.result_json) as T }
}

// Last-subscription retention, shared by unsubscribe and account deletion so
// the two exits from "a source lost its last subscriber" cannot drift. Runs
// INSIDE the caller's own transaction; returns true iff the source row was
// deleted. A source is kept when anything still depends on it: a remaining
// subscriber, non-allowed governance, a federation relationship, the
// administrative retention flag, or ANY audit history — source_audit_v2.source_id
// is ON DELETE CASCADE, so keeping the source row is the only way to keep a
// moderation record. (The origin_verification evidence branch is Vertical 3 —
// rev 5 deferral; do not add it here.)
export function reapSourceIfOrphaned(tx: Db, sourceId: string): boolean {
  const { n } = tx.prepare(`SELECT COUNT(*) AS n FROM source_subscriptions_v2 WHERE source_id = ?`).get(sourceId) as { n: number }
  if (n > 0) return false
  const source = tx.prepare(`SELECT governance, admin_retained FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { governance: SourceGovernance; admin_retained: 0 | 1 } | undefined
  if (!source || source.governance !== 'allowed' || source.admin_retained !== 0) return false
  if (tx.prepare(`SELECT 1 FROM federation_relationships_v2 WHERE source_id = ?`).get(sourceId)) return false
  if (tx.prepare(`SELECT 1 FROM source_audit_v2 WHERE source_id = ? LIMIT 1`).get(sourceId)) return false
  // Interim RESTRICT-aware cleanup (rev 5 RC4 — V3 plan lockstep amendment 2,
  // applied broadened). Once Vertical 2 acquisition/reconciliation has written v2
  // child rows under ON DELETE RESTRICT foreign keys, DELETE FROM remote_sources_v2
  // would FK-throw. Retain the source row while ANY RESTRICT child still references
  // it, deleting only what can be deleted and reporting the retention. These six
  // are exactly the ON DELETE RESTRICT children of remote_sources_v2 in
  // logical/schema.ts; source_aliases_v2 is ON DELETE CASCADE and does NOT block
  // deletion, so it is deliberately absent. INTERIM: Vertical 3's Task 7 replaces
  // this with evidence-aware cleanup.
  const RESTRICT_CHILDREN = ['deliveries_v2', 'source_health_v2', 'source_validators_v2', 'acquisition_runs_v2', 'publisher_names_v2', 'publisher_claims_v2'] as const
  for (const child of RESTRICT_CHILDREN) {
    if (tx.prepare(`SELECT 1 FROM ${child} WHERE source_id = ? LIMIT 1`).get(sourceId)) return false
  }
  tx.prepare(`DELETE FROM remote_sources_v2 WHERE id = ?`).run(sourceId)
  return true
}

export function storeCommand<T>(tx: Db, command: CommandEnvelope, result: T, now: string): void {
  // Explicit column list (frozen contract): later verticals add columns to
  // command_ledger_v2, and a positional INSERT would silently break.
  tx.prepare(
    `INSERT INTO command_ledger_v2 (actor_scope, actor_id, command_id, request_fingerprint, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(command.actorScope, command.actorId, command.commandId, command.requestFingerprint, JSON.stringify(result), now)
}
