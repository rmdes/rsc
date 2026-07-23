import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

type Raw = InstanceType<typeof Database>

const PUBLIC_URL = 'https://cast.example'

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
