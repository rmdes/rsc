import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { AuditCategory } from '../src/domain/types.ts'

type Raw = InstanceType<typeof Database>

const PUBLIC_URL = 'https://cast.example'
const T0 = '2026-01-01T00:00:00.000Z'

function insertSourceRow(raw: Raw, opts: {
  canonicalUrl: string
  attributionMode?: 'single_publisher' | 'aggregate'
  operation?: 'enabled' | 'paused'
  governance?: 'allowed' | 'quarantined' | 'blocked'
}): string {
  const id = randomUUID()
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, ?, ?, 'user_subscription', NULL, 0, ?)`,
  ).run(id, opts.canonicalUrl, opts.attributionMode ?? 'single_publisher', opts.operation ?? 'enabled', opts.governance ?? 'allowed', T0)
  return id
}

function insertSubscription(raw: Raw, ownerId: string, sourceId: string, state: 'active' | 'pending' | 'pending_review'): void {
  raw.prepare(
    `INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), ownerId, sourceId, state, T0)
}

function countFederationRows(raw: Raw, sourceId: string): number {
  return (raw.prepare(`SELECT count(*) AS n FROM federation_relationships_v2 WHERE source_id = ?`).get(sourceId) as { n: number }).n
}

function countAuditRows(raw: Raw, sourceId: string): number {
  return (raw.prepare(`SELECT count(*) AS n FROM source_audit_v2 WHERE source_id = ?`).get(sourceId) as { n: number }).n
}

function countLedgerRows(raw: Raw): number {
  return (raw.prepare(`SELECT count(*) AS n FROM command_ledger_v2`).get() as { n: number }).n
}

function subStates(raw: Raw, sourceId: string): string[] {
  return (raw.prepare(`SELECT state FROM source_subscriptions_v2 WHERE source_id = ? ORDER BY state`).all(sourceId) as { state: string }[]).map((r) => r.state)
}

function sourceRow(raw: Raw, id: string): { attribution_mode: string; operation: string; governance: string; provenance: string } {
  return raw.prepare(`SELECT attribution_mode, operation, governance, provenance FROM remote_sources_v2 WHERE id = ?`).get(id) as never
}

// --- Step 1: new and retained federation establishment ---

test('a new URL federates at the administrator-selected mode with enabled/allowed/approved, one audit and one ledger row', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  const result = await service.establishFederation({
    url: 'https://Aggregator.test/Feed?b=2#frag',
    attributionMode: 'aggregate',
    category: 'operator_policy',
    note: 'partner instance',
    commandId: 'fed-new',
    actorId: admin.id,
    actorKind: 'administrator',
  })

  expect(result).toMatchObject({
    kind: 'established',
    source: {
      canonicalUrl: 'https://aggregator.test/Feed?b=2', // normalized: host lowercased, fragment stripped
      attributionMode: 'aggregate',
      operation: 'enabled',
      governance: 'allowed',
      provenance: 'admin_federation',
    },
    federation: { status: 'approved', provenanceNote: 'partner instance' },
  })

  const id = (raw.prepare(`SELECT id FROM remote_sources_v2`).get() as { id: string }).id
  expect(countFederationRows(raw, id)).toBe(1)
  expect(countAuditRows(raw, id)).toBe(1)
  expect(countLedgerRows(raw)).toBe(1)
  const audit = raw.prepare(`SELECT actor_id, actor_kind, category, note, command_id FROM source_audit_v2 WHERE source_id = ?`).get(id) as { actor_id: string; actor_kind: string; category: string; note: string; command_id: string }
  expect(audit).toMatchObject({ actor_id: admin.id, actor_kind: 'administrator', category: 'operator_policy', note: 'partner instance', command_id: 'fed-new' })

  repo.close()
})

test('a retained allowed source keeps its mode and operation and gains an approved relationship', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  // Retained: single_publisher + paused, and the administrator asks for aggregate.
  const retainedId = insertSourceRow(raw, { canonicalUrl: 'https://retained.test/feed', attributionMode: 'single_publisher', operation: 'paused' })

  const established = await service.establishFederation({
    url: 'https://retained.test/feed',
    attributionMode: 'aggregate',
    category: 'operator_policy',
    note: null,
    commandId: 'fed-1',
    actorId: admin.id,
    actorKind: 'administrator',
  })
  expect(established).toMatchObject({
    kind: 'established',
    source: { id: retainedId, attributionMode: 'single_publisher', operation: 'paused' },
    federation: { status: 'approved' },
  })
  expect(countFederationRows(raw, retainedId)).toBe(1)
  expect(countAuditRows(raw, retainedId)).toBe(1)
  expect(sourceRow(raw, retainedId)).toMatchObject({ attribution_mode: 'single_publisher', operation: 'paused', provenance: 'user_subscription' })

  repo.close()
})

test('establishing on a quarantined single-publisher source allows it and activates ordinary pending subscriptions only', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
  const b = await repo.createLocalUser({ handle: 'b', displayName: 'B' })
  const service = createSourceService(repo, PUBLIC_URL)

  const id = insertSourceRow(raw, { canonicalUrl: 'https://q.test/feed', governance: 'quarantined' })
  insertSubscription(raw, a.id, id, 'pending')
  insertSubscription(raw, b.id, id, 'pending_review')

  const result = await service.establishFederation({
    url: 'https://q.test/feed', attributionMode: 'single_publisher', category: 'operator_policy',
    note: null, commandId: 'fed-q', actorId: admin.id, actorKind: 'administrator',
  })
  expect(result).toMatchObject({ kind: 'established', source: { governance: 'allowed' } })
  expect(sourceRow(raw, id).governance).toBe('allowed')
  expect(subStates(raw, id)).toEqual(['active', 'pending_review'])
  expect(countAuditRows(raw, id)).toBe(1)

  repo.close()
})

test('establishing on an already-allowed single-publisher source preserves active subscriptions', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
  const service = createSourceService(repo, PUBLIC_URL)

  const id = insertSourceRow(raw, { canonicalUrl: 'https://ok.test/feed' })
  insertSubscription(raw, a.id, id, 'active')

  const result = await service.establishFederation({
    url: 'https://ok.test/feed', attributionMode: 'single_publisher', category: 'operator_policy',
    note: null, commandId: 'fed-ok', actorId: admin.id, actorKind: 'administrator',
  })
  expect(result).toMatchObject({ kind: 'established' })
  expect(subStates(raw, id)).toEqual(['active'])

  repo.close()
})

test('a blocked source is unavailable: no relationship, no audit, ledgered once', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  const id = insertSourceRow(raw, { canonicalUrl: 'https://blocked.test/feed', governance: 'blocked' })

  const result = await service.establishFederation({
    url: 'https://blocked.test/feed', attributionMode: 'single_publisher', category: 'operator_policy',
    note: null, commandId: 'fed-b', actorId: admin.id, actorKind: 'administrator',
  })
  expect(result).toEqual({ kind: 'unavailable' })
  expect(countFederationRows(raw, id)).toBe(0)
  expect(countAuditRows(raw, id)).toBe(0)
  expect(countLedgerRows(raw)).toBe(1)
  expect(sourceRow(raw, id).governance).toBe('blocked')

  repo.close()
})

test('identical retry replays; the same command id with a changed URL or mode conflicts; a different command converges to one relationship', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)
  insertSourceRow(raw, { canonicalUrl: 'https://other.test/feed' })

  const base = {
    url: 'https://one.test/feed', attributionMode: 'single_publisher' as const, category: 'operator_policy' as const,
    note: null, commandId: 'fed-1', actorId: admin.id, actorKind: 'administrator' as const,
  }
  const first = await service.establishFederation(base)
  expect(first).toMatchObject({ kind: 'established' })
  const id = (raw.prepare(`SELECT id FROM remote_sources_v2 WHERE canonical_url = ?`).get('https://one.test/feed') as { id: string }).id
  expect(countLedgerRows(raw)).toBe(1)

  // Identical retry: stored result, nothing new written.
  expect(await service.establishFederation(base)).toEqual(first)
  expect(countLedgerRows(raw)).toBe(1)
  expect(countFederationRows(raw, id)).toBe(1)
  expect(countAuditRows(raw, id)).toBe(1)

  // Same command id, changed URL -> conflict.
  expect(await service.establishFederation({ ...base, url: 'https://other.test/feed' })).toEqual({ kind: 'conflict' })
  // Same command id, changed mode -> conflict.
  expect(await service.establishFederation({ ...base, attributionMode: 'aggregate' })).toEqual({ kind: 'conflict' })
  expect(countLedgerRows(raw)).toBe(1)

  // A DIFFERENT command against the same URL converges on the one relationship.
  expect(await service.establishFederation({ ...base, commandId: 'fed-2' })).toEqual({ kind: 'exists' })
  expect(countFederationRows(raw, id)).toBe(1)
  expect(countAuditRows(raw, id)).toBe(1)
  expect(countLedgerRows(raw)).toBe(2)

  repo.close()
})

test('establishment without an audit category conflicts and writes nothing', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  // Category is non-nullable in TypeScript; the cast simulates an untyped caller
  // (Task 7's route body) slipping a null through the enum.
  const result = await service.establishFederation({
    url: 'https://nocat.test/feed', attributionMode: 'single_publisher',
    category: null as unknown as AuditCategory,
    note: null, commandId: 'fed-nc', actorId: admin.id, actorKind: 'administrator',
  })
  expect(result).toEqual({ kind: 'conflict' })
  expect((raw.prepare(`SELECT count(*) AS n FROM remote_sources_v2`).get() as { n: number }).n).toBe(0)
  expect((raw.prepare(`SELECT count(*) AS n FROM source_audit_v2`).get() as { n: number }).n).toBe(0)
  expect(countLedgerRows(raw)).toBe(0) // a conflict never writes — not even to the ledger

  repo.close()
})
