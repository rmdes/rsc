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

// A verified_origin publisher claim needs real logical_items_v2/deliveries_v2/
// observation_versions_v2/remote_publishers_v2 rows underneath it — every FK
// column on publisher_claims_v2 is NOT NULL and foreign_keys=ON (sqlite.ts).
// Mirrors source-cleanup.test.ts's seedEvidence helper (verified branch).
function insertVerifiedOriginClaim(raw: Raw, sourceId: string) {
  const itemId = randomUUID()
  const deliveryId = randomUUID()
  const versionId = randomUUID()
  const pub = randomUUID()
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at)
     VALUES (?, 'remote', ?, 'none', NULL, ?, NULL, ?)`,
  ).run(itemId, T, deliveryId, T)
  raw.prepare(
    `INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, 'opaque', ?, ?, ?, ?, 1)`,
  ).run(deliveryId, sourceId, itemId, T, T, randomUUID())
  raw.prepare(
    `INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json)
     VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?, ?, 1, '{}', '{}')`,
  ).run(versionId, deliveryId, randomUUID(), Buffer.from('m'), T, randomUUID(), T, randomUUID())
  raw.prepare(
    `INSERT INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, 'feed_anchored', ?)`,
  ).run(pub, `https://pub-${pub}.test/f`, T)
  raw.prepare(
    `INSERT INTO publisher_claims_v2 (id, logical_item_id, publisher_id, source_id, observation_version_id, evidence_level, first_seen_at) VALUES (?, ?, ?, ?, ?, 'verified_origin', ?)`,
  ).run(randomUUID(), itemId, pub, sourceId, versionId, T)
}

test('listSourceSummaries paginates stably across equal timestamps and SourceSummary carries the expected DTO keys', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const sourceA = randomUUID()
  const sourceB = randomUUID()
  insertSource(raw, sourceA)
  insertSource(raw, sourceB)

  const first = await repo.listSourceSummaries(undefined, 1)
  expect(first.items).toHaveLength(1)
  expect(first.nextCursor).not.toBeNull()
  // 'push' joined the DTO in V4 Task 1 (all-null until a lease exists);
  // 'retention'/'addedBy' joined in the admin-governance-visibility Task 1.
  expect(Object.keys(first.items[0]).sort()).toEqual(['addedBy', 'federationStatus', 'push', 'retention', 'source', 'subscriptionCounts'])
  expect(first.items[0].push).toEqual({ mode: null, state: null, endpointFingerprint: null })
  expect(first.items[0].retention).toBeNull()
  expect(first.items[0].addedBy).toEqual([])

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
  // Equal timestamp — m2 (whole-branch review): "newest" is decided by
  // insertion order (rowid), not by comparing the random ids lexicographically
  // — the row inserted SECOND always wins, regardless of which UUID sorts
  // higher (deterministic across runs, unlike the old id DESC tie-break).
  insertAudit(raw, newerAudit, sourceId, T)

  const detail = await repo.getSourceDetail(sourceId)
  expect(detail!.federationStatus).toBe('approved')
  expect(detail!.subscriptionCounts).toEqual({ active: 2, pending: 1, pendingReview: 1 })
  expect(detail!.latestAudit).toMatchObject({ id: newerAudit })

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

test('q searches canonical_url; filter=orphan returns only zero-subscription allowed non-federated sources', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const orphanId = randomUUID()
  const subscribedId = randomUUID()
  insertSource(raw, orphanId)
  insertSource(raw, subscribedId)
  // owner_id is FK-checked (foreign_keys=ON) — a real user row is required.
  const owner = await repo.createLocalUser({ handle: 'owner1', displayName: 'Owner1' })
  insertSubscription(raw, randomUUID(), owner.id, subscribedId, 'active')

  const orphans = await repo.listSourceSummaries(undefined, 50, 'orphan')
  expect(orphans.items.map((i) => i.source.id)).toEqual([orphanId])
  expect(orphans.items[0].retention).toBe('reapable')

  const searched = await repo.listSourceSummaries(undefined, 50, undefined, orphanId)
  expect(searched.items.map((i) => i.source.id)).toEqual([orphanId])
  const noMatch = await repo.listSourceSummaries(undefined, 50, undefined, 'no-such-substring-xyz')
  expect(noMatch.items).toEqual([])
  repo.close()
})

test('a pending_review-only source is NOT an orphan (C1 regression)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const sourceId = randomUUID()
  insertSource(raw, sourceId)
  const owner = await repo.createLocalUser({ handle: 'owner2', displayName: 'Owner2' })
  insertSubscription(raw, randomUUID(), owner.id, sourceId, 'pending_review')
  const orphans = await repo.listSourceSummaries(undefined, 50, 'orphan')
  expect(orphans.items.map((i) => i.source.id)).not.toContain(sourceId)
  repo.close()
})

test('retention ladder: verified_origin beats admin_retained beats audit_history beats reapable', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const reapableId = randomUUID()
  const auditedId = randomUUID()
  const retainedId = randomUUID()
  const verifiedId = randomUUID()
  insertSource(raw, reapableId)
  insertSource(raw, auditedId)
  insertSource(raw, retainedId)
  insertSource(raw, verifiedId)
  insertAudit(raw, randomUUID(), auditedId, T)
  raw.prepare(`UPDATE remote_sources_v2 SET admin_retained = 1 WHERE id = ?`).run(retainedId)
  insertVerifiedOriginClaim(raw, verifiedId)
  const orphans = await repo.listSourceSummaries(undefined, 50, 'orphan')
  const byId = new Map(orphans.items.map((i) => [i.source.id, i.retention]))
  expect(byId.get(reapableId)).toBe('reapable')
  expect(byId.get(auditedId)).toBe('audit_history')
  expect(byId.get(retainedId)).toBe('admin_retained')
  expect(byId.get(verifiedId)).toBe('verified_origin')
  repo.close()
})

test('addedBy resolves the first 3 subscriber handles in created_at order, empty for orphans', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const sourceId = randomUUID()
  insertSource(raw, sourceId)
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, created_at) VALUES ('u1', 'local', 'alice', 'Alice', ?)`).run(T)
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, created_at) VALUES ('u2', 'local', 'bob', 'Bob', ?)`).run(T)
  insertSubscription(raw, randomUUID(), 'u1', sourceId, 'active')
  insertSubscription(raw, randomUUID(), 'u2', sourceId, 'active')
  const page = await repo.listSourceSummaries(undefined, 50)
  const row = page.items.find((i) => i.source.id === sourceId)!
  expect(row.addedBy.map((a) => a.handle)).toEqual(['alice', 'bob'])
  repo.close()
})

// Members match the orphan predicate BY DEFINITION (no subscribers, no
// federation row of their own — their items arrive via the aggregate). The
// 2026-08-06 reap fix labelled them 'instance_member' so they'd stop being
// deleted, but left them listed here: on rsc.rmdes.be that made 60 of 60
// orphan rows members, so the section described itself falsely and a real
// orphan would be buried across pages. They already appear under their
// aggregate ("Show members", same per-row actions), so they are excluded here.
test('filter=orphan excludes instance-governed members but keeps real orphans', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const instanceId = randomUUID()
  const memberId = randomUUID()
  const realOrphanId = randomUUID()

  // An approved federated aggregate, plus a member nested under its prefix.
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, 'https://peer.test/users/rss.xml', 'aggregate', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
  ).run(instanceId, T)
  raw.prepare(
    `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'approved', NULL, ?, ?)`,
  ).run(instanceId, T, T)
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, 'https://peer.test/users/alice/rss.xml', 'single_publisher', 'enabled', 'allowed', 'origin_verification', NULL, 0, ?)`,
  ).run(memberId, T)
  insertSource(raw, realOrphanId) // ordinary orphan on a different host

  const orphans = await repo.listSourceSummaries(undefined, 50, 'orphan')
  const ids = orphans.items.map((i) => i.source.id)
  expect(ids).toContain(realOrphanId)
  expect(ids).not.toContain(memberId)

  // The member is still a real, listable source — only this ONE list excludes it.
  expect(await repo.getSource(memberId)).toBeDefined()
  repo.close()
})
