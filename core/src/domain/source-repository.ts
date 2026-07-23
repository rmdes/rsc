import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { CommandEnvelope, RemoteSource, SourceSubscription, SourceAuditEvent, Page, SourceSummary, SourceDetail, OwnerSourceFollow, PublicLocalFollow, OwnerFollowingView, PublicFollowingEntry } from './types.ts'

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
  // delete the subscription, evaluate last-subscription retention, store,
  // commit. V1 retention checks ONLY the federation relationship and the
  // admin_retained flag — the origin_verification evidence branch is
  // Vertical 3 (rev 5 deferral).
  unsubscribe(input: { command: CommandEnvelope; ownerId: string; sourceId: string; now: string }): Promise<UnsubscribeResult>
}

// Every mutation command's requestFingerprint is SHA-256 of [operation, ...parts]
// — never secrets. Shared so later verticals (Task 4 OPML, Task 6 federation)
// fingerprint identically instead of re-deriving the scheme.
export function fingerprintRequest(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

// Cursor = base64url JSON of the displayed (created_at, id) pair — the exact
// tuple every v2 listing orders DESC by, so ties on created_at still resolve
// deterministically off the stable id. Shared by every read method here and
// by later verticals' listings (rev 5, V4 §10 pin).
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url')
}

export function decodeCursor(s: string): Cursor {
  return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor
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

export function storeCommand<T>(tx: Db, command: CommandEnvelope, result: T, now: string): void {
  // Explicit column list (frozen contract): later verticals add columns to
  // command_ledger_v2, and a positional INSERT would silently break.
  tx.prepare(
    `INSERT INTO command_ledger_v2 (actor_scope, actor_id, command_id, request_fingerprint, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(command.actorScope, command.actorId, command.commandId, command.requestFingerprint, JSON.stringify(result), now)
}
