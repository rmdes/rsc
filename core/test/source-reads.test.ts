import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { decodeCursor } from '../src/domain/source-repository.ts'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

type Raw = InstanceType<typeof Database>

// All rows below share EQUAL created_at timestamps on purpose — pagination
// must still be stable (no dupes, no gaps) because the DESC ordering's
// second sort column (id) is what breaks the tie.
const T = '2026-07-01T00:00:00.000Z'

function insertSource(raw: Raw, id: string) {
  raw.prepare(
    `INSERT INTO remote_sources_v2
       (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'user_subscription', NULL, 0, ?)`,
  ).run(id, `https://example.test/${id}/feed.xml`, T)
}

function insertSubscription(raw: Raw, id: string, ownerId: string, sourceId: string, state: string) {
  raw.prepare(
    `INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, ownerId, sourceId, state, T)
}

function insertAudit(raw: Raw, id: string, sourceId: string, createdAt: string) {
  raw.prepare(
    `INSERT INTO source_audit_v2 (id, source_id, command_id, actor_id, actor_kind, action, category, note, result_json, created_at)
     VALUES (?, ?, ?, 'admin-1', 'administrator', 'noted', NULL, NULL, '{}', ?)`,
  ).run(id, sourceId, `cmd-${id}`, createdAt)
}

test('listSourceSummaries paginates stably across equal timestamps and SourceSummary carries only the three DTO keys', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const sourceA = randomUUID()
  const sourceB = randomUUID()
  insertSource(raw, sourceA)
  insertSource(raw, sourceB)

  const first = await repo.listSourceSummaries(undefined, 1)
  expect(first.items).toHaveLength(1)
  expect(first.nextCursor).not.toBeNull()
  expect(Object.keys(first.items[0]).sort()).toEqual(['federationStatus', 'source', 'subscriptionCounts'])

  const second = await repo.listSourceSummaries(decodeCursor(first.nextCursor!), 1)
  expect(second.items).toHaveLength(1)
  expect(second.nextCursor).toBeNull()

  const ids = new Set([...first.items, ...second.items].map((x) => x.source.id))
  expect(ids.size).toBe(2)
  expect(ids).toEqual(new Set([sourceA, sourceB]))

  repo.close()
})

test('getSourceDetail reports federationStatus none/status, subscriptionCounts, and the single newest audit row', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const sourceId = randomUUID()
  insertSource(raw, sourceId)

  expect((await repo.getSourceDetail(sourceId))!.federationStatus).toBe('none')

  raw.prepare(
    `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'approved', NULL, ?, ?)`,
  ).run(sourceId, T, T)

  // UNIQUE(owner_id, source_id): one row per distinct owner.
  const owners = await Promise.all(
    ['alice', 'carol', 'dave', 'erin'].map((h) => repo.createLocalUser({ handle: h, displayName: h })),
  )
  insertSubscription(raw, randomUUID(), owners[0].id, sourceId, 'active')
  insertSubscription(raw, randomUUID(), owners[1].id, sourceId, 'active')
  insertSubscription(raw, randomUUID(), owners[2].id, sourceId, 'pending')
  insertSubscription(raw, randomUUID(), owners[3].id, sourceId, 'pending_review')

  const olderAudit = randomUUID()
  const newerAudit = randomUUID()
  insertAudit(raw, olderAudit, sourceId, T)
  // Equal timestamp, later id — must win as "newest" via the id tie-break.
  insertAudit(raw, newerAudit, sourceId, T)
  const newestSeededAudit = [olderAudit, newerAudit].sort().at(-1)!

  const detail = await repo.getSourceDetail(sourceId)
  expect(detail!.federationStatus).toBe('approved')
  expect(detail!.subscriptionCounts).toEqual({ active: 2, pending: 1, pendingReview: 1 })
  expect(detail!.latestAudit).toMatchObject({ id: newestSeededAudit })

  repo.close()
})

test('getSource / listSourceSubscriptions / listSourceAudit: undefined on unknown id, stable cursor pagination', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  expect(await repo.getSource('missing')).toBeUndefined()

  const ownerA = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
  const ownerB = await repo.createLocalUser({ handle: 'fred', displayName: 'Fred' })
  const sourceId = randomUUID()
  insertSource(raw, sourceId)
  expect((await repo.getSource(sourceId))!.id).toBe(sourceId)

  const subA = randomUUID()
  const subB = randomUUID()
  insertSubscription(raw, subA, ownerA.id, sourceId, 'active')
  insertSubscription(raw, subB, ownerB.id, sourceId, 'active')

  const subsFirst = await repo.listSourceSubscriptions(sourceId, undefined, 1)
  const subsSecond = await repo.listSourceSubscriptions(sourceId, decodeCursor(subsFirst.nextCursor!), 1)
  expect(subsSecond.nextCursor).toBeNull()
  const subIds = new Set([...subsFirst.items, ...subsSecond.items].map((s) => s.id))
  expect(subIds).toEqual(new Set([subA, subB]))

  const auditA = randomUUID()
  const auditB = randomUUID()
  insertAudit(raw, auditA, sourceId, T)
  insertAudit(raw, auditB, sourceId, T)

  const auditFirst = await repo.listSourceAudit(sourceId, undefined, 1)
  const auditSecond = await repo.listSourceAudit(sourceId, decodeCursor(auditFirst.nextCursor!), 1)
  expect(auditSecond.nextCursor).toBeNull()
  const auditIds = new Set([...auditFirst.items, ...auditSecond.items].map((a) => a.id))
  expect(auditIds).toEqual(new Set([auditA, auditB]))

  repo.close()
})

test('limit is clamped to 1-100', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  for (let i = 0; i < 3; i++) insertSource(raw, randomUUID())

  const zero = await repo.listSourceSummaries(undefined, 0)
  expect(zero.items).toHaveLength(1)

  const huge = await repo.listSourceSummaries(undefined, 1000)
  expect(huge.items).toHaveLength(3)
  expect(huge.nextCursor).toBeNull()

  repo.close()
})
