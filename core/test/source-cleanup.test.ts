import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { reapSourceIfOrphaned, fingerprintRequest, DEAD_SOURCE_FAILURES } from '../src/domain/source-repository.ts'
import { trimSourceToCap } from '../src/logical/tombstones.ts'
import type { CommandEnvelope } from '../src/domain/types.ts'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

type Raw = InstanceType<typeof Database>

const PUBLIC_URL = 'https://cast.example'
const NOW = '2026-07-24T00:00:00.000Z'

function countRows(raw: Raw, table: string): number {
  const { n } = raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
  return n
}

function insertSourceRow(raw: Raw, opts: { canonicalUrl: string; governance?: 'allowed' | 'quarantined' | 'blocked'; adminRetained?: boolean }): string {
  const id = randomUUID()
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', ?, 'user_subscription', NULL, ?, ?)`,
  ).run(id, opts.canonicalUrl, opts.governance ?? 'allowed', opts.adminRetained ? 1 : 0, '2026-01-01T00:00:00.000Z')
  return id
}

function insertFederationRow(raw: Raw, sourceId: string): void {
  raw.prepare(
    `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'approved', NULL, ?, ?)`,
  ).run(sourceId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
}

function insertSubscription(raw: Raw, ownerId: string, sourceId: string, state: 'active' | 'pending' | 'pending_review'): void {
  raw.prepare(
    `INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), ownerId, sourceId, state, '2026-01-01T00:00:00.000Z')
}

function insertAudit(raw: Raw, sourceId: string): void {
  raw.prepare(
    `INSERT INTO source_audit_v2 (id, source_id, command_id, actor_id, actor_kind, action, category, note, result_json, created_at)
     VALUES (?, ?, ?, 'admin-1', 'administrator', 'noted', NULL, NULL, '{}', ?)`,
  ).run(randomUUID(), sourceId, `audit-cmd-${randomUUID()}`, NOW)
}

// Mirrors the operator route's own fingerprint scheme (app.ts:
// fingerprintRequest(['reap', id])) so a reused commandId against a
// different sourceId conflicts here exactly as it would over HTTP.
function reapCmd(commandId: string, sourceId: string): CommandEnvelope {
  return { actorScope: 'administrator', actorId: 'admin-1', commandId, requestFingerprint: fingerprintRequest(['reap', sourceId]) }
}

// --- Step 2: cleanup matrix — last-subscriber deletion, retention, ledger ---

test('unsubscribe removes an allowed self-service source outright on its last subscriber, is ledgered/idempotent, and conflicts on command-id reuse against a different source', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner', displayName: 'Owner' })
  const service = createSourceService(repo, PUBLIC_URL)

  const orphan = insertSourceRow(raw, { canonicalUrl: 'https://orphan.test/feed' })
  insertSubscription(raw, owner.id, orphan, 'active')

  const quarantined = insertSourceRow(raw, { canonicalUrl: 'https://q.test/feed', governance: 'quarantined' })
  insertSubscription(raw, owner.id, quarantined, 'pending')

  const removed = await service.unsubscribe(owner.id, orphan, 'unsub-1')
  expect(removed).toEqual({ kind: 'removed', sourceRemoved: true })
  expect(countRows(raw, 'remote_sources_v2')).toBe(1) // orphan gone, quarantined survives
  expect(countRows(raw, 'source_subscriptions_v2')).toBe(1)
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  // Identical retry (same command id, same source) replays the stored result.
  const replay = await service.unsubscribe(owner.id, orphan, 'unsub-1')
  expect(replay).toEqual(removed)
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  // Same command id reused against a DIFFERENT source -> conflict, nothing written.
  const conflict = await service.unsubscribe(owner.id, quarantined, 'unsub-1')
  expect(conflict).toEqual({ kind: 'conflict' })
  expect(countRows(raw, 'source_subscriptions_v2')).toBe(1)
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  repo.close()
})

test('quarantined, blocked, federated, and admin-retained sources all survive their last unsubscribe', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner2', displayName: 'Owner2' })
  const service = createSourceService(repo, PUBLIC_URL)

  const quarantined = insertSourceRow(raw, { canonicalUrl: 'https://a.test/feed', governance: 'quarantined' })
  insertSubscription(raw, owner.id, quarantined, 'pending')

  const blocked = insertSourceRow(raw, { canonicalUrl: 'https://b.test/feed', governance: 'blocked' })
  insertSubscription(raw, owner.id, blocked, 'active')

  const federated = insertSourceRow(raw, { canonicalUrl: 'https://c.test/feed' })
  insertFederationRow(raw, federated)
  insertSubscription(raw, owner.id, federated, 'active')

  const adminRetained = insertSourceRow(raw, { canonicalUrl: 'https://d.test/feed', adminRetained: true })
  insertSubscription(raw, owner.id, adminRetained, 'active')

  for (const sourceId of [quarantined, blocked, federated, adminRetained]) {
    const result = await service.unsubscribe(owner.id, sourceId, `unsub-${sourceId}`)
    expect(result).toEqual({ kind: 'removed', sourceRemoved: false })
  }
  expect(countRows(raw, 'remote_sources_v2')).toBe(4) // none deleted
  expect(countRows(raw, 'source_subscriptions_v2')).toBe(0) // all four subscriptions removed

  repo.close()
})

test('an allowed source survives when other owners remain subscribed', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner3', displayName: 'Owner3' })
  const other = await repo.createLocalUser({ handle: 'other', displayName: 'Other' })
  const service = createSourceService(repo, PUBLIC_URL)

  const shared = insertSourceRow(raw, { canonicalUrl: 'https://shared.test/feed' })
  insertSubscription(raw, owner.id, shared, 'active')
  insertSubscription(raw, other.id, shared, 'active')

  const result = await service.unsubscribe(owner.id, shared, 'u1')
  expect(result).toEqual({ kind: 'removed', sourceRemoved: false })
  expect(countRows(raw, 'remote_sources_v2')).toBe(1)
  expect(countRows(raw, 'source_subscriptions_v2')).toBe(1) // other's subscription remains

  repo.close()
})

// --- Retention of moderation history (source_audit_v2.source_id is ON DELETE
// CASCADE, so deleting the source destroys its audit trail) ---

test('a source an administrator has audited survives its last unsubscribe, audit history intact', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner5', displayName: 'Owner5' })
  const service = createSourceService(repo, PUBLIC_URL)

  const audited = insertSourceRow(raw, { canonicalUrl: 'https://audited.test/feed' })
  insertSubscription(raw, owner.id, audited, 'active')

  // Quarantine then allow: governance is back to 'allowed' and nothing else
  // retains the source — only the two audit rows do.
  const admin = { actorId: 'admin-1', actorKind: 'administrator' as const, note: null }
  const q = await service.transition({ ...admin, sourceId: audited, action: 'quarantine', category: 'spam', commandId: 'adm-q' })
  expect(q.kind).toBe('applied')
  const a = await service.transition({ ...admin, sourceId: audited, action: 'allow', category: 'other', commandId: 'adm-a' })
  expect(a.kind).toBe('applied')
  expect(countRows(raw, 'source_audit_v2')).toBe(2)

  const result = await service.unsubscribe(owner.id, audited, 'unsub-audited')
  expect(result).toEqual({ kind: 'removed', sourceRemoved: false })
  expect(countRows(raw, 'remote_sources_v2')).toBe(1)
  expect(countRows(raw, 'source_audit_v2')).toBe(2)
  expect(countRows(raw, 'source_subscriptions_v2')).toBe(0)

  repo.close()
})

// --- Account deletion is the other exit from "the last subscriber left" ---

test('deleting an account removes the sources it orphans but keeps audited and federated ones', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner6', displayName: 'Owner6' })
  const other = await repo.createLocalUser({ handle: 'other6', displayName: 'Other6' })
  const service = createSourceService(repo, PUBLIC_URL)

  const orphaned = insertSourceRow(raw, { canonicalUrl: 'https://orphaned.test/feed' })
  insertSubscription(raw, owner.id, orphaned, 'active')

  const audited = insertSourceRow(raw, { canonicalUrl: 'https://kept-audit.test/feed' })
  insertSubscription(raw, owner.id, audited, 'active')
  const t = await service.transition({ sourceId: audited, action: 'quarantine', category: 'spam', note: null, commandId: 'adm-q6', actorId: 'admin-1', actorKind: 'administrator' })
  expect(t.kind).toBe('applied')
  await service.transition({ sourceId: audited, action: 'allow', category: 'other', note: null, commandId: 'adm-a6', actorId: 'admin-1', actorKind: 'administrator' })

  const federated = insertSourceRow(raw, { canonicalUrl: 'https://kept-fed.test/feed' })
  insertFederationRow(raw, federated)
  insertSubscription(raw, owner.id, federated, 'active')

  const shared = insertSourceRow(raw, { canonicalUrl: 'https://kept-shared.test/feed' })
  insertSubscription(raw, owner.id, shared, 'active')
  insertSubscription(raw, other.id, shared, 'active')

  repo.deleteUserCascade(owner.id)

  expect(countRows(raw, 'source_subscriptions_v2')).toBe(1) // only other's
  const surviving = (raw.prepare(`SELECT id FROM remote_sources_v2 ORDER BY canonical_url`).all() as { id: string }[]).map((r) => r.id)
  expect(surviving.sort()).toEqual([audited, federated, shared].sort())
  expect(countRows(raw, 'source_audit_v2')).toBe(2)

  repo.close()
})

// --- V3 Task 7: evidence-aware cleanup (replaces V2's interim retain-if-referenced) ---

// A remote item + a delivery/version supported ONLY by `sourceId`, plus an
// optional verified_origin publisher claim from that source. Returns the item id.
function seedEvidence(raw: Raw, sourceId: string, opts: { verified?: boolean } = {}): string {
  const itemId = randomUUID()
  const deliveryId = randomUUID()
  const versionId = randomUUID()
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'remote', ?, 'none', NULL, ?, NULL, ?)`).run(itemId, NOW, deliveryId, NOW)
  raw.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, 'opaque', ?, ?, ?, ?, 1)`).run(deliveryId, sourceId, itemId, NOW, NOW, randomUUID())
  raw.prepare(`INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json) VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?, ?, 1, '{}', '{}')`).run(versionId, deliveryId, randomUUID(), Buffer.from('m'), NOW, randomUUID(), NOW, randomUUID())
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('delivery', ?, ?)`).run(deliveryId, itemId)
  if (opts.verified) {
    const pub = randomUUID()
    raw.prepare(`INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, 'feed_anchored', ?)`).run(pub, `https://pub-${pub}.test/f`, NOW)
    raw.prepare(`INSERT INTO publisher_claims_v2 (id, logical_item_id, publisher_id, source_id, observation_version_id, evidence_level, first_seen_at) VALUES (?, ?, ?, ?, ?, 'verified_origin', ?)`).run(randomUUID(), itemId, pub, sourceId, versionId, NOW)
  }
  return itemId
}

test('the last unsubscribe of an allowed source with evidence removes the source AND its evidence, writing no block tombstone', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'ownerE', displayName: 'OwnerE' })
  const service = createSourceService(repo, PUBLIC_URL)

  const src = insertSourceRow(raw, { canonicalUrl: 'https://ev.test/feed' })
  insertSubscription(raw, owner.id, src, 'active')
  seedEvidence(raw, src) // a delivery/version/item supported only by this source

  const result = await service.unsubscribe(owner.id, src, 'unsub-ev')
  // Behavior change from V2's interim rule: cleanup now REMOVES the evidence and
  // the source instead of retaining it because a RESTRICT child exists.
  expect(result).toEqual({ kind: 'removed', sourceRemoved: true })
  expect(countRows(raw, 'remote_sources_v2')).toBe(0)
  expect(countRows(raw, 'deliveries_v2')).toBe(0)
  expect(countRows(raw, 'logical_items_v2')).toBe(0) // unsupported item deleted
  expect(countRows(raw, 'blocked_source_tombstones_v2')).toBe(0) // cleanup is not a moderation action

  repo.close()
})

test('a source whose deliveries are current verification evidence is never removed even with no subscribers', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const service = createSourceService(repo, PUBLIC_URL)

  const verified = insertSourceRow(raw, { canonicalUrl: 'https://verified.test/feed' })
  seedEvidence(raw, verified, { verified: true }) // a verified_origin claim, no subscription

  const kept = raw.transaction(() => reapSourceIfOrphaned(raw, verified, NOW))()
  expect(kept).toBe(false)
  expect(countRows(raw, 'remote_sources_v2')).toBe(1) // the verification-evidence source survives
  expect(countRows(raw, 'publisher_claims_v2')).toBe(1)

  void service // constructed to mirror the other cases; the guard is tested directly
  repo.close()
})

test('unsubscribing from a source never subscribed to returns unknown, ledgered idempotently', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner4', displayName: 'Owner4' })
  const service = createSourceService(repo, PUBLIC_URL)
  const source = insertSourceRow(raw, { canonicalUrl: 'https://never.test/feed' })

  const result = await service.unsubscribe(owner.id, source, 'u1')
  expect(result).toEqual({ kind: 'unknown' })
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  const replay = await service.unsubscribe(owner.id, source, 'u1')
  expect(replay).toEqual({ kind: 'unknown' })
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  repo.close()
})

// --- Task 2 (admin-governance-visibility): operator reap (POST /admin/sources/:id/reap) ---

test('operator reap refuses a non-allowed-governance source', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const quarantined = insertSourceRow(raw, { canonicalUrl: 'https://reap-q.test/feed', governance: 'quarantined' })

  const result = await repo.reapSource({ command: reapCmd('r1', quarantined), sourceId: quarantined, force: true, now: NOW })
  expect(result).toEqual({ kind: 'refused', reason: 'not_allowed' })
  expect(countRows(raw, 'remote_sources_v2')).toBe(1)

  repo.close()
})

test('operator reap refuses a source with any subscription, even force', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'reap-owner-1', displayName: 'ReapOwner1' })
  const src = insertSourceRow(raw, { canonicalUrl: 'https://reap-sub.test/feed' })
  insertSubscription(raw, owner.id, src, 'pending')

  const result = await repo.reapSource({ command: reapCmd('r2', src), sourceId: src, force: true, now: NOW })
  expect(result).toEqual({ kind: 'refused', reason: 'has_subscribers' })
  expect(countRows(raw, 'remote_sources_v2')).toBe(1)

  repo.close()
})

test('operator reap refuses a federated source, even force', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://reap-fed.test/feed' })
  insertFederationRow(raw, src)

  const result = await repo.reapSource({ command: reapCmd('r3', src), sourceId: src, force: true, now: NOW })
  expect(result).toEqual({ kind: 'refused', reason: 'federated' })
  expect(countRows(raw, 'remote_sources_v2')).toBe(1)

  repo.close()
})

test('operator reap refuses verified-origin evidence without force, but force removes source AND evidence', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://reap-verified.test/feed' })
  seedEvidence(raw, src, { verified: true })

  const refused = await repo.reapSource({ command: reapCmd('r4a', src), sourceId: src, force: false, now: NOW })
  expect(refused).toEqual({ kind: 'refused', reason: 'verified_origin_evidence' })
  expect(countRows(raw, 'remote_sources_v2')).toBe(1)
  expect(countRows(raw, 'publisher_claims_v2')).toBe(1)

  const forced = await repo.reapSource({ command: reapCmd('r4b', src), sourceId: src, force: true, now: NOW })
  expect(forced).toEqual({ kind: 'reaped' })
  expect(countRows(raw, 'remote_sources_v2')).toBe(0)
  expect(countRows(raw, 'publisher_claims_v2')).toBe(0) // the evidence was actually removed, not just the source row

  repo.close()
})

// Highest-risk regression check for this task: admin_retained and
// source_audit_v2 are gated INSIDE the shared reapSource on `!opts.force` —
// they are NOT unconditionally bypassed by the operator route. force: false
// (or omitted) refuses on either signal, exactly like auto-reap; force: true
// lifts both.
test('operator reap refuses an admin_retained source without force, force lifts it', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://reap-retained.test/feed', adminRetained: true })

  const keptByAutoReap = raw.transaction(() => reapSourceIfOrphaned(raw, src, NOW))()
  expect(keptByAutoReap).toBe(false)

  const refused = await repo.reapSource({ command: reapCmd('r5a', src), sourceId: src, force: false, now: NOW })
  expect(refused).toEqual({ kind: 'refused', reason: 'admin_retained' })
  expect(countRows(raw, 'remote_sources_v2')).toBe(1)

  const forced = await repo.reapSource({ command: reapCmd('r5b', src), sourceId: src, force: true, now: NOW })
  expect(forced).toEqual({ kind: 'reaped' })
  expect(countRows(raw, 'remote_sources_v2')).toBe(0)

  repo.close()
})

test('operator reap refuses a source with audit history without force, force lifts it', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://reap-audited.test/feed' })
  insertAudit(raw, src)

  const keptByAutoReap = raw.transaction(() => reapSourceIfOrphaned(raw, src, NOW))()
  expect(keptByAutoReap).toBe(false)

  const refused = await repo.reapSource({ command: reapCmd('r5c', src), sourceId: src, force: false, now: NOW })
  expect(refused).toEqual({ kind: 'refused', reason: 'audit_history' })
  expect(countRows(raw, 'remote_sources_v2')).toBe(1)
  expect(countRows(raw, 'source_audit_v2')).toBe(1)

  const forced = await repo.reapSource({ command: reapCmd('r5d', src), sourceId: src, force: true, now: NOW })
  expect(forced).toEqual({ kind: 'reaped' })
  expect(countRows(raw, 'remote_sources_v2')).toBe(0)
  expect(countRows(raw, 'source_audit_v2')).toBe(0) // cascade-deleted with the source row

  repo.close()
})

test('operator reap is ledgered and idempotent on replay, no second effect', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://reap-replay.test/feed' })

  const cmd = reapCmd('r6', src)
  const first = await repo.reapSource({ command: cmd, sourceId: src, force: false, now: NOW })
  expect(first).toEqual({ kind: 'reaped' })
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  const replay = await repo.reapSource({ command: cmd, sourceId: src, force: false, now: NOW })
  expect(replay).toEqual(first)
  expect(countRows(raw, 'command_ledger_v2')).toBe(1) // no second ledger row

  repo.close()
})

test('a refused reap is never ledgered, so the same commandId re-judges against live state and can succeed', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://reap-retry.test/feed' })
  seedEvidence(raw, src, { verified: true })

  const refused = await repo.reapSource({ command: reapCmd('r7a', src), sourceId: src, force: false, now: NOW })
  expect(refused).toEqual({ kind: 'refused', reason: 'verified_origin_evidence' })
  expect(countRows(raw, 'command_ledger_v2')).toBe(0) // refusals are never ledgered, unlike 'reaped'

  // Same commandId, now with force:true -> refusal was never stored, so this
  // re-evaluates against live state (not a replay) and succeeds.
  const sameIdRetry = await repo.reapSource({ command: reapCmd('r7a', src), sourceId: src, force: true, now: NOW })
  expect(sameIdRetry).toEqual({ kind: 'reaped' })
  expect(countRows(raw, 'remote_sources_v2')).toBe(0)
  expect(countRows(raw, 'command_ledger_v2')).toBe(1) // the successful reap IS ledgered

  repo.close()
})

test('operator reap on an unknown source returns unknown, ledgered idempotently', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw

  const result = await repo.reapSource({ command: reapCmd('r8', 'missing-source'), sourceId: 'missing-source', force: true, now: NOW })
  expect(result).toEqual({ kind: 'unknown' })
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  const replay = await repo.reapSource({ command: reapCmd('r8', 'missing-source'), sourceId: 'missing-source', force: true, now: NOW })
  expect(replay).toEqual({ kind: 'unknown' })
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  repo.close()
})

// --- remote-content-retention: trimSourceToCap (standalone, core/src/logical/tombstones.ts) ---

// Seeds a remote item with a specific timeline_sort_at (unlike seedEvidence,
// which always uses NOW) so count/age ordering tests can control which items
// rank as "oldest." Mirrors seedEvidence's shape exactly, minus the verified
// option (not needed here).
function seedItemAt(raw: Raw, sourceId: string, sortAt: string): string {
  const itemId = randomUUID()
  const deliveryId = randomUUID()
  const versionId = randomUUID()
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'remote', ?, 'none', NULL, ?, NULL, ?)`).run(itemId, sortAt, deliveryId, NOW)
  raw.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, 'opaque', ?, ?, ?, ?, 1)`).run(deliveryId, sourceId, itemId, NOW, NOW, randomUUID())
  raw.prepare(`INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json) VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?, ?, 1, '{}', '{}')`).run(versionId, deliveryId, randomUUID(), Buffer.from('m'), sortAt, randomUUID(), NOW, randomUUID())
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('delivery', ?, ?)`).run(deliveryId, itemId)
  return itemId
}

test('trimSourceToCap: 0/0 is a no-op fast path', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-noop.test/feed' })
  seedItemAt(raw, src, NOW)
  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 0, maxAgeDays: 0, now: NOW }))()
  expect(result).toEqual({ trimmedCount: 0, removedItemIds: [] })
  expect(countRows(raw, 'logical_items_v2')).toBe(1)
  repo.close()
})

test('trimSourceToCap: count cap keeps the N most recent, deletes the rest', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-count.test/feed' })
  const oldest = seedItemAt(raw, src, '2020-01-01T00:00:00.000Z')
  const middle = seedItemAt(raw, src, '2023-01-01T00:00:00.000Z')
  const newest = seedItemAt(raw, src, '2026-01-01T00:00:00.000Z')
  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 2, maxAgeDays: 0, now: NOW }))()
  expect(result).toEqual({ trimmedCount: 1, removedItemIds: [oldest] })
  const remaining = raw.prepare(`SELECT id FROM logical_items_v2`).all().map((r) => (r as { id: string }).id)
  expect(remaining.sort()).toEqual([middle, newest].sort())
  expect(remaining).not.toContain(oldest)
  expect(countRows(raw, 'deliveries_v2')).toBe(2)
  repo.close()
})

test('trimSourceToCap: age cap deletes anything older than the cutoff, regardless of count', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-age.test/feed' })
  const NOW_MS = Date.parse(NOW)
  const old = seedItemAt(raw, src, new Date(NOW_MS - 40 * 86400000).toISOString()) // 40 days old
  const recent = seedItemAt(raw, src, new Date(NOW_MS - 5 * 86400000).toISOString()) // 5 days old
  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 0, maxAgeDays: 30, now: NOW }))()
  expect(result).toEqual({ trimmedCount: 1, removedItemIds: [old] })
  const remaining = raw.prepare(`SELECT id FROM logical_items_v2`).all().map((r) => (r as { id: string }).id)
  expect(remaining).toEqual([recent])
  repo.close()
})

test('trimSourceToCap: count and age union — whichever catches an item removes it', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-union.test/feed' })
  const NOW_MS = Date.parse(NOW)
  // 3 items, all within the count cap (maxCount=5), but the oldest is past the age cap.
  const veryOld = seedItemAt(raw, src, new Date(NOW_MS - 100 * 86400000).toISOString())
  const mid = seedItemAt(raw, src, new Date(NOW_MS - 10 * 86400000).toISOString())
  const recent = seedItemAt(raw, src, NOW)
  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 5, maxAgeDays: 30, now: NOW }))()
  expect(result).toEqual({ trimmedCount: 1, removedItemIds: [veryOld] })
  const remaining = raw.prepare(`SELECT id FROM logical_items_v2`).all().map((r) => (r as { id: string }).id)
  expect(remaining.sort()).toEqual([mid, recent].sort())
  repo.close()
})

test('trimSourceToCap: local items are never selected regardless of settings', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-local.test/feed' })
  const local = randomUUID()
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'local', ?, 'none', NULL, NULL, NULL, ?)`).run(local, '2020-01-01T00:00:00.000Z', NOW)
  seedItemAt(raw, src, NOW)
  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 1, maxAgeDays: 1, now: NOW }))()
  expect(result.trimmedCount).toBe(0) // the one remote item is within maxCount=1; the local item is never a candidate
  expect(countRows(raw, 'logical_items_v2')).toBe(2)
  repo.close()
})

test('trimSourceToCap: a reply surviving its trimmed parent becomes a structural tombstone', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-reply.test/feed' })
  const parent = seedItemAt(raw, src, '2020-01-01T00:00:00.000Z') // will be trimmed (beyond maxCount=1)
  const reply = seedItemAt(raw, src, NOW) // survives, under the cap
  raw.prepare(`UPDATE logical_items_v2 SET parent_logical_item_id = ?, parent_state = 'resolved' WHERE id = ?`).run(parent, reply)

  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 1, maxAgeDays: 0, now: NOW }))()
  // finding 2: a tombstoned item is no longer ordinarily visible either, so it
  // is a removed id too, exactly like a fully-deleted one -- the caller
  // (runtime.ts) journals a 'remove' for every id in this list.
  expect(result).toEqual({ trimmedCount: 1, removedItemIds: [parent] })
  const parentRow = raw.prepare(`SELECT structural_tombstone, selected_delivery_id FROM logical_items_v2 WHERE id = ?`).get(parent) as { structural_tombstone: number; selected_delivery_id: string | null }
  expect(parentRow.structural_tombstone).toBe(1)
  expect(parentRow.selected_delivery_id).toBeNull()
  expect(countRows(raw, 'logical_items_v2')).toBe(2) // parent survives as a tombstone, not deleted
  repo.close()
})

test('trimSourceToCap: an excess item with a surviving delivery from a DIFFERENT source reselects instead of being deleted', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-reselect-src.test/feed' })
  const otherSrc = insertSourceRow(raw, { canonicalUrl: 'https://trim-reselect-other.test/feed' })
  const trimmed = seedItemAt(raw, src, '2020-01-01T00:00:00.000Z') // this source's delivery for it will be removed
  seedItemAt(raw, src, NOW) // keeps `src` at exactly maxCount=1, pushing `trimmed` out

  // The SAME logical item also has a delivery from otherSrc (a cross-source
  // merge, e.g. the two feeds carry identical content) -- add a second
  // identity key + delivery pointing at the same logical item id, from otherSrc.
  const otherDeliveryId = randomUUID()
  raw.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, 'opaque', ?, ?, ?, ?, 1)`).run(otherDeliveryId, otherSrc, trimmed, NOW, NOW, randomUUID())
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('delivery', ?, ?)`).run(otherDeliveryId, trimmed)

  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 1, maxAgeDays: 0, now: NOW }))()
  // finding 2: reselected onto a surviving delivery ⇒ still ordinarily visible
  // ⇒ NOT a removed id (no 'remove' journal effect for it).
  expect(result).toEqual({ trimmedCount: 1, removedItemIds: [] })
  // Reselected, not deleted or tombstoned: the item row still exists, not a tombstone.
  const row = raw.prepare(`SELECT structural_tombstone FROM logical_items_v2 WHERE id = ?`).get(trimmed) as { structural_tombstone: number } | undefined
  expect(row).toBeDefined()
  expect(row!.structural_tombstone).toBe(0)
  expect(countRows(raw, 'logical_items_v2')).toBe(2)
  repo.close()
})

test('trimSourceToCap: an excess item with TWO deliveries from the SAME trimmed source is fully removed, not reselected onto itself', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-dup-delivery.test/feed' })
  const trimmed = seedItemAt(raw, src, '2020-01-01T00:00:00.000Z') // will be excess (beyond maxCount=1)
  seedItemAt(raw, src, NOW) // keeps `src` at exactly maxCount=1, pushing `trimmed` out

  // The SAME logical item ALSO has a second delivery from the SAME source
  // (e.g. the feed re-issued a GUID for the same permalink) -- an older,
  // not-selected delivery pointing at the same logical item id.
  const otherDeliveryId = randomUUID()
  raw.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, 'opaque', ?, ?, ?, ?, 1)`).run(otherDeliveryId, src, `${trimmed}-reissued-guid`, NOW, NOW, randomUUID())
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('delivery', ?, ?)`).run(otherDeliveryId, trimmed)

  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 1, maxAgeDays: 0, now: NOW }))()
  expect(result).toEqual({ trimmedCount: 1, removedItemIds: [trimmed] })
  // Both of this source's deliveries for the item are gone -- none survive to wrongly reselect onto.
  expect(countRows(raw, 'deliveries_v2')).toBe(1) // only the surviving (non-excess) item's delivery remains
  expect(countRows(raw, 'logical_identity_keys_v2')).toBe(1)
  // The item itself is deleted (no child edges), not left behind reselected.
  const row = raw.prepare(`SELECT id FROM logical_items_v2 WHERE id = ?`).get(trimmed)
  expect(row).toBeUndefined()
  expect(countRows(raw, 'logical_items_v2')).toBe(1)
  repo.close()
})

test('trimSourceToCap never touches source-scoped tables or the source row itself', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-scope.test/feed' })
  seedItemAt(raw, src, '2020-01-01T00:00:00.000Z')
  seedItemAt(raw, src, NOW)
  raw.prepare(`INSERT INTO source_health_v2 (source_id, last_poll_at, consecutive_failures) VALUES (?, ?, 0)`).run(src, NOW)
  raw.prepare(`INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, outcome, counters_json) VALUES (?, ?, 'scheduled', 'terminal', ?, 'parsed', '{}')`).run(randomUUID(), src, NOW)

  raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 1, maxAgeDays: 0, now: NOW }))()
  expect(countRows(raw, 'remote_sources_v2')).toBe(1)
  expect(countRows(raw, 'source_health_v2')).toBe(1)
  expect(countRows(raw, 'acquisition_runs_v2')).toBe(1)
  repo.close()
})

// finding 1 (critical): trimSourceToCap builds three dynamic IN (...) clauses
// (excess ids, delivery ids, observation-version ids) whose placeholder count
// scales with result-set size. Below better-sqlite3's real bound-parameter
// ceiling (32766, probed directly) this worked; past it `prepare()` throws
// "too many SQL variables" and a scheduled poll's db.write rolls back with no
// partial progress, so the source is stuck failing identically forever. This
// seeds enough excess items to force the excess-id list alone past the
// chunking helper's 500-per-chunk size (proving it chunks, not that it
// reaches the real 32766 ceiling -- that would be needlessly slow to seed).
test('trimSourceToCap chunks its dynamic IN (...) clauses so an excess set past one chunk still trims correctly', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const src = insertSourceRow(raw, { canonicalUrl: 'https://trim-chunk.test/feed' })
  const TOTAL = 600
  const base = Date.parse('2020-01-01T00:00:00.000Z')
  for (let i = 0; i < TOTAL; i++) seedItemAt(raw, src, new Date(base + i * 1000).toISOString())

  const result = raw.transaction(() => trimSourceToCap(raw, { sourceId: src, maxCount: 1, maxAgeDays: 0, now: NOW }))()
  expect(result.trimmedCount).toBe(TOTAL - 1)
  expect(result.removedItemIds.length).toBe(TOTAL - 1)
  expect(countRows(raw, 'logical_items_v2')).toBe(1)
  expect(countRows(raw, 'deliveries_v2')).toBe(1)
  repo.close()
})

// --- dead-source sweep (2026-08-18) -------------------------------------------
// A guest posts, verification mints a source for its per-user feed, the guest is
// swept, and that feed 404s forever while its items keep displaying from it.
// Measured across the fleet before this shipped: 34 never-succeeded sources, of
// which 11 were REAL user subscriptions to broken feeds (a blog, several
// podcasts, 5000+ consecutive failures each). Deleting those would silently
// unsubscribe people, so the sweep selects only on health and lets reapSource
// decide what may actually go.

function seedHealth(raw: Raw, sourceId: string, failures: number, succeeded: boolean): void {
  raw.prepare(
    `INSERT INTO source_health_v2 (source_id, last_poll_at, last_success_at, last_failure_at, consecutive_failures) VALUES (?, ?, ?, ?, ?)`,
  ).run(sourceId, NOW, succeeded ? NOW : null, NOW, failures)
}
function seedVerificationSource(raw: Raw, url: string): string {
  const id = randomUUID()
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, overridden, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'origin_verification', NULL, 0, 0, ?)`,
  ).run(id, url, '2026-01-01T00:00:00.000Z')
  return id
}

test('the dead-source sweep removes a never-succeeded verification source', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const dead = seedVerificationSource(raw, 'https://peer.test/users/guest-x/feed.xml')
  seedHealth(raw, dead, 40, false)
  expect(repo.sweepDeadSources()).toEqual({ swept: 1 })
  expect(raw.prepare(`SELECT 1 FROM remote_sources_v2 WHERE id = ?`).get(dead)).toBeUndefined()
  raw.close()
})

// THE safety property. Without it this sweep silently unsubscribes people from
// feeds that are merely broken.
test('the sweep NEVER removes a subscribed feed, however long it has been failing', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const subscribed = insertSourceRow(raw, { canonicalUrl: 'https://john.example/feed.rss' })
  const owner = await repo.createLocalUser({ handle: 'sub', displayName: 'Sub' })
  raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`)
    .run(randomUUID(), owner.id, subscribed, NOW)
  seedHealth(raw, subscribed, 5670, false) // the real number measured on rsc.rmdes.be

  expect(repo.sweepDeadSources()).toEqual({ swept: 0 })
  expect(raw.prepare(`SELECT 1 FROM remote_sources_v2 WHERE id = ?`).get(subscribed)).toBeDefined()
  raw.close()
})

test('the sweep spares a federated peer and an admin-retained source', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const fed = insertSourceRow(raw, { canonicalUrl: 'https://peer.test/users/rss.xml' })
  insertFederationRow(raw, fed)
  seedHealth(raw, fed, 900, false)
  const retained = insertSourceRow(raw, { canonicalUrl: 'https://kept.test/feed', adminRetained: true })
  seedHealth(raw, retained, 900, false)

  expect(repo.sweepDeadSources()).toEqual({ swept: 0 })
  expect(raw.prepare(`SELECT 1 FROM remote_sources_v2 WHERE id = ?`).get(fed)).toBeDefined()
  expect(raw.prepare(`SELECT 1 FROM remote_sources_v2 WHERE id = ?`).get(retained)).toBeDefined()
  raw.close()
})

test('a source that has ever succeeded is spared, and one below the threshold is too', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const flaky = seedVerificationSource(raw, 'https://peer.test/users/a/feed.xml')
  seedHealth(raw, flaky, 900, true) // failing now, but it worked once — a real outage
  const young = seedVerificationSource(raw, 'https://peer.test/users/b/feed.xml')
  seedHealth(raw, young, 3, false) // transient; below the threshold

  expect(repo.sweepDeadSources()).toEqual({ swept: 0 })
  expect(raw.prepare(`SELECT 1 FROM remote_sources_v2 WHERE id = ?`).get(flaky)).toBeDefined()
  expect(raw.prepare(`SELECT 1 FROM remote_sources_v2 WHERE id = ?`).get(young)).toBeDefined()
  raw.close()
})

// THE test for the guard narrowing. The four above pass with the narrowing
// reverted -- their fixtures trip neither guard -- so on their own they prove
// only that the sweep is wired up. This one reproduces what a stranded guest
// feed actually IS: an origin_verification member of an approved instance that
// also carries a verified_origin claim. Both guards refuse it while it is
// merely unreachable; both must yield once it is provably dead.
test('a dead instance member with a verified_origin claim is swept; alive, both guards still refuse it', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const instance = insertSourceRow(raw, { canonicalUrl: 'https://peer.test/users/rss.xml' })
  insertFederationRow(raw, instance) // approved -> the member is instance-governed
  const member = seedVerificationSource(raw, 'https://peer.test/users/guest-x/feed.xml')
  const itemId = seedEvidence(raw, member, { verified: true })

  // alive (never polled): both guards hold, exactly as before this change
  expect(reapSourceIfOrphaned(raw, member)).toBe(false)
  expect(raw.prepare(`SELECT 1 FROM remote_sources_v2 WHERE id = ?`).get(member)).toBeDefined()

  // now provably dead
  seedHealth(raw, member, DEAD_SOURCE_FAILURES, false)
  expect(repo.sweepDeadSources()).toEqual({ swept: 1 })
  expect(raw.prepare(`SELECT 1 FROM remote_sources_v2 WHERE id = ?`).get(member)).toBeUndefined()
  // its evidence went with it, and the item it solely supported is gone too
  expect(countRows(raw, 'publisher_claims_v2')).toBe(0)
  expect(raw.prepare(`SELECT 1 FROM logical_items_v2 WHERE id = ?`).get(itemId)).toBeUndefined()
  raw.close()
})
