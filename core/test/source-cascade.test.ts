import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

// Task 3: the instance-governed-members cascade, wired into transition() and
// establishFederation() (spec 2026-07-25 rev 3). Exercised through the real
// repository API (createSqliteRepository + createSourceService, which is a
// thin command-envelope wrapper over repo.transition/repo.establishFederation
// — the same path source-lifecycle.test.ts and source-federation.test.ts use).

type Raw = InstanceType<typeof Database>

const PUBLIC_URL = 'https://cast.example'
const T0 = '2026-01-01T00:00:00.000Z'

function insertSourceRow(raw: Raw, opts: {
  canonicalUrl: string
  attributionMode?: 'single_publisher' | 'aggregate'
  operation?: 'enabled' | 'paused'
  governance?: 'allowed' | 'quarantined' | 'blocked'
  provenance?: 'user_subscription' | 'opml' | 'admin_federation' | 'origin_verification' | 'migration'
  overridden?: 0 | 1
}): string {
  const id = randomUUID()
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, overridden, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
  ).run(
    id, opts.canonicalUrl, opts.attributionMode ?? 'single_publisher', opts.operation ?? 'enabled',
    opts.governance ?? 'allowed', opts.provenance ?? 'user_subscription', opts.overridden ?? 1, T0,
  )
  return id
}

function insertFederation(raw: Raw, sourceId: string, status: 'pending' | 'approved' = 'approved'): void {
  raw.prepare(
    `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`,
  ).run(sourceId, status, T0, T0)
}

function insertSubscription(raw: Raw, ownerId: string, sourceId: string, state: 'active' | 'pending' | 'pending_review'): void {
  raw.prepare(
    `INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), ownerId, sourceId, state, T0)
}

function governance(raw: Raw, id: string): string {
  return (raw.prepare(`SELECT governance FROM remote_sources_v2 WHERE id = ?`).get(id) as { governance: string }).governance
}

function overridden(raw: Raw, id: string): 0 | 1 {
  return (raw.prepare(`SELECT overridden FROM remote_sources_v2 WHERE id = ?`).get(id) as { overridden: 0 | 1 }).overridden
}

function policyGeneration(raw: Raw, id: string): number {
  return (raw.prepare(`SELECT policy_generation FROM remote_sources_v2 WHERE id = ?`).get(id) as { policy_generation: number }).policy_generation
}

function subStates(raw: Raw, sourceId: string): string[] {
  return (raw.prepare(`SELECT state FROM source_subscriptions_v2 WHERE source_id = ? ORDER BY state`).all(sourceId) as { state: string }[]).map((r) => r.state)
}

function count(raw: Raw, table: string, where = '', ...args: unknown[]): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args) as { n: number }).n
}

function resets(raw: Raw): number {
  return count(raw, 'logical_journal_v2', `WHERE kind = 'reset'`)
}

function cascadeAudits(raw: Raw, sourceId: string): { result_json: string }[] {
  return raw.prepare(`SELECT result_json FROM source_audit_v2 WHERE source_id = ? AND action = 'instance_cascade'`).all(sourceId) as { result_json: string }[]
}

// --- Case 1: instance quarantine ---

test('instance quarantine cascades to instance-governed allowed members, skips an overridden member, advances each moved member\'s policy generation, and audits the instance exactly once', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  const instanceId = insertSourceRow(raw, { canonicalUrl: 'https://inst1.test/f.xml', governance: 'allowed' })
  insertFederation(raw, instanceId, 'approved')
  const memberA = insertSourceRow(raw, { canonicalUrl: 'https://inst1.test/members/a', governance: 'allowed', provenance: 'origin_verification', overridden: 0 })
  const memberOverridden = insertSourceRow(raw, { canonicalUrl: 'https://inst1.test/members/b', governance: 'allowed', provenance: 'origin_verification', overridden: 1 })

  const genBefore = policyGeneration(raw, memberA)

  const result = await service.transition({
    sourceId: instanceId, action: 'quarantine', category: 'operator_policy', note: null,
    commandId: 'c1', actorId: admin.id, actorKind: 'administrator',
  })
  expect(result).toMatchObject({ kind: 'applied' })

  expect(governance(raw, memberA)).toBe('quarantined')
  expect(governance(raw, memberOverridden)).toBe('allowed') // overridden: untouched
  expect(policyGeneration(raw, memberA)).toBe(genBefore + 1)

  const audits = cascadeAudits(raw, instanceId)
  expect(audits).toHaveLength(1)
  expect(JSON.parse(audits[0].result_json)).toEqual({ moved: 1 })

  expect(resets(raw)).toBe(1) // exactly one journal reset row for the whole command

  repo.close()
})

// --- Case 2: instance allow ---

test('instance allow lifts quarantined members, skips a blocked member, and activates a pending subscription on a lifted member', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const owner = await repo.createLocalUser({ handle: 'owner', displayName: 'Owner' })
  const service = createSourceService(repo, PUBLIC_URL)

  const instanceId = insertSourceRow(raw, { canonicalUrl: 'https://inst2.test/f.xml', governance: 'quarantined' })
  insertFederation(raw, instanceId, 'approved')
  const memberA = insertSourceRow(raw, { canonicalUrl: 'https://inst2.test/members/a', governance: 'quarantined', provenance: 'origin_verification', overridden: 0 })
  const memberBlocked = insertSourceRow(raw, { canonicalUrl: 'https://inst2.test/members/b', governance: 'blocked', provenance: 'origin_verification', overridden: 0 })
  insertSubscription(raw, owner.id, memberA, 'pending')

  const result = await service.transition({
    sourceId: instanceId, action: 'allow', category: 'operator_policy', note: null,
    commandId: 'c1', actorId: admin.id, actorKind: 'administrator',
  })
  expect(result).toMatchObject({ kind: 'applied' })

  expect(governance(raw, memberA)).toBe('allowed')
  expect(governance(raw, memberBlocked)).toBe('blocked') // no legal unblock cell: skipped
  expect(subStates(raw, memberA)).toEqual(['active'])

  repo.close()
})

// --- Case 3: block / unblock are absolute (overridden included) ---

test('block moves every member — overridden included — to blocked; a later unblock returns every member to quarantined', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  const instanceId = insertSourceRow(raw, { canonicalUrl: 'https://inst3.test/f.xml', governance: 'allowed' })
  insertFederation(raw, instanceId, 'approved')
  const memberA = insertSourceRow(raw, { canonicalUrl: 'https://inst3.test/members/a', governance: 'allowed', provenance: 'origin_verification', overridden: 0 })
  const memberOverridden = insertSourceRow(raw, { canonicalUrl: 'https://inst3.test/members/b', governance: 'allowed', provenance: 'origin_verification', overridden: 1 })

  await service.transition({
    sourceId: instanceId, action: 'block', category: 'spam', note: null,
    commandId: 'c1', actorId: admin.id, actorKind: 'administrator',
  })
  expect(governance(raw, memberA)).toBe('blocked')
  expect(governance(raw, memberOverridden)).toBe('blocked')

  await service.transition({
    sourceId: instanceId, action: 'unblock', category: 'operator_policy', note: null,
    commandId: 'c2', actorId: admin.id, actorKind: 'administrator',
  })
  expect(governance(raw, memberA)).toBe('quarantined')
  expect(governance(raw, memberOverridden)).toBe('quarantined')

  repo.close()
})

// --- Case 4: establishFederation cascades as 'allow' ---

test('establishFederation on a URL whose prefix covers pre-existing quarantined origin_verification members lifts them to allowed', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  const memberA = insertSourceRow(raw, { canonicalUrl: 'https://inst4.test/members/a', governance: 'quarantined', provenance: 'origin_verification', overridden: 0 })
  const memberB = insertSourceRow(raw, { canonicalUrl: 'https://inst4.test/members/b', governance: 'quarantined', provenance: 'origin_verification', overridden: 0 })

  const result = await service.establishFederation({
    url: 'https://inst4.test/f.xml', attributionMode: 'single_publisher', category: 'operator_policy', note: 'peer',
    commandId: 'fed1', actorId: admin.id, actorKind: 'administrator',
  })
  expect(result).toMatchObject({ kind: 'established' })
  const instanceId = (result as { kind: 'established'; source: { id: string } }).source.id

  expect(governance(raw, memberA)).toBe('allowed')
  expect(governance(raw, memberB)).toBe('allowed')

  const audits = cascadeAudits(raw, instanceId)
  expect(audits).toHaveLength(1)
  expect(JSON.parse(audits[0].result_json)).toEqual({ moved: 2 })

  repo.close()
})

// --- Case 5: replay is a pure no-op, on both APIs ---

test('replaying the same commandId on transition or establishFederation returns the stored result, leaves member states unchanged, and writes no new audit row', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  // transition() replay
  const instanceId = insertSourceRow(raw, { canonicalUrl: 'https://inst5.test/f.xml', governance: 'allowed' })
  insertFederation(raw, instanceId, 'approved')
  const memberA = insertSourceRow(raw, { canonicalUrl: 'https://inst5.test/members/a', governance: 'allowed', provenance: 'origin_verification', overridden: 0 })

  const first = await service.transition({
    sourceId: instanceId, action: 'quarantine', category: 'operator_policy', note: null,
    commandId: 'c1', actorId: admin.id, actorKind: 'administrator',
  })
  expect(first).toMatchObject({ kind: 'applied' })
  expect(governance(raw, memberA)).toBe('quarantined')

  const auditsBefore = count(raw, 'source_audit_v2')
  const second = await service.transition({
    sourceId: instanceId, action: 'quarantine', category: 'operator_policy', note: null,
    commandId: 'c1', actorId: admin.id, actorKind: 'administrator',
  })
  expect(second).toEqual(first)
  expect(governance(raw, memberA)).toBe('quarantined')
  expect(count(raw, 'source_audit_v2')).toBe(auditsBefore)

  // establishFederation() replay
  const memberC = insertSourceRow(raw, { canonicalUrl: 'https://inst6.test/members/c', governance: 'quarantined', provenance: 'origin_verification', overridden: 0 })
  const fed1 = await service.establishFederation({
    url: 'https://inst6.test/f.xml', attributionMode: 'single_publisher', category: 'operator_policy', note: null,
    commandId: 'fed1', actorId: admin.id, actorKind: 'administrator',
  })
  expect(fed1).toMatchObject({ kind: 'established' })
  expect(governance(raw, memberC)).toBe('allowed')

  const auditsBefore2 = count(raw, 'source_audit_v2')
  const fed2 = await service.establishFederation({
    url: 'https://inst6.test/f.xml', attributionMode: 'single_publisher', category: 'operator_policy', note: null,
    commandId: 'fed1', actorId: admin.id, actorKind: 'administrator',
  })
  expect(fed2).toEqual(fed1)
  expect(count(raw, 'source_audit_v2')).toBe(auditsBefore2)

  repo.close()
})

// --- Case 6: the sticky override bit, set only by a governance judgment ---

test('a direct administrator governance transition on a member sets its overridden bit; pause does not', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  const memberA = insertSourceRow(raw, { canonicalUrl: 'https://inst7.test/members/a', governance: 'allowed', provenance: 'origin_verification', overridden: 0 })
  await service.transition({
    sourceId: memberA, action: 'quarantine', category: 'operator_policy', note: null,
    commandId: 'c1', actorId: admin.id, actorKind: 'administrator',
  })
  expect(overridden(raw, memberA)).toBe(1)

  const memberB = insertSourceRow(raw, { canonicalUrl: 'https://inst7.test/members/b', governance: 'allowed', provenance: 'origin_verification', overridden: 0 })
  await service.transition({
    sourceId: memberB, action: 'pause', category: null, note: null,
    commandId: 'c2', actorId: admin.id, actorKind: 'administrator',
  })
  expect(overridden(raw, memberB)).toBe(0)

  repo.close()
})
