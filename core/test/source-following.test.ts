import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

type Raw = InstanceType<typeof Database>

const PUBLIC_URL = 'https://cast.example'

function insertSourceRow(raw: Raw, opts: { canonicalUrl: string; attributionMode?: 'single_publisher' | 'aggregate'; governance?: 'allowed' | 'quarantined' | 'blocked' }): string {
  const id = randomUUID()
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, 'enabled', ?, 'user_subscription', NULL, 0, ?)`,
  ).run(id, opts.canonicalUrl, opts.attributionMode ?? 'single_publisher', opts.governance ?? 'allowed', '2026-01-01T00:00:00.000Z')
  return id
}

function insertSubscription(raw: Raw, ownerId: string, sourceId: string, state: 'active' | 'pending' | 'pending_review'): void {
  raw.prepare(
    `INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), ownerId, sourceId, state, '2026-01-01T00:00:00.000Z')
}

// --- Step 1: owner projection boundary ---

test('ownerFollowing projects exactly sourceId/url/attributionMode/subscriptionState/availability, pinning pending_review to awaiting_review regardless of governance', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner', displayName: 'Owner' })
  const service = createSourceService(repo, PUBLIC_URL)

  const allowedId = insertSourceRow(raw, { canonicalUrl: 'https://example.test/feed' })
  insertSubscription(raw, owner.id, allowedId, 'active')

  const quarantinedId = insertSourceRow(raw, { canonicalUrl: 'https://quarantined.test/feed', governance: 'quarantined' })
  insertSubscription(raw, owner.id, quarantinedId, 'pending')

  // pending_review is pinned to awaiting_review even though this source's
  // own governance is 'allowed' (rev 5 — previously undefined cell).
  const reviewId = insertSourceRow(raw, { canonicalUrl: 'https://review.test/feed' })
  insertSubscription(raw, owner.id, reviewId, 'pending_review')

  const view = await service.ownerFollowing(owner.id)
  const bySource = new Map(view.sourceSubscriptions.map((s) => [s.sourceId, s]))

  expect(bySource.get(allowedId)).toEqual({ sourceId: allowedId, url: 'https://example.test/feed', attributionMode: 'single_publisher', subscriptionState: 'active', availability: 'available' })
  expect(bySource.get(quarantinedId)).toEqual({ sourceId: quarantinedId, url: 'https://quarantined.test/feed', attributionMode: 'single_publisher', subscriptionState: 'pending', availability: 'awaiting_review' })
  expect(bySource.get(reviewId)).toEqual({ sourceId: reviewId, url: 'https://review.test/feed', attributionMode: 'single_publisher', subscriptionState: 'pending_review', availability: 'awaiting_review' })

  // Frozen field set — never wider (no governance/provenance/etc leaking through).
  for (const s of view.sourceSubscriptions) {
    expect(Object.keys(s).sort()).toEqual(['attributionMode', 'availability', 'sourceId', 'subscriptionState', 'url'])
  }

  repo.close()
})

test('ownerFollowing includes local-account follows alongside source subscriptions', async () => {
  const repo = await createSqliteRepository(':memory:')
  const target = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const owner = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
  await repo.addFollow(owner.id, target.id)
  const service = createSourceService(repo, PUBLIC_URL)

  const view = await service.ownerFollowing(owner.id)
  expect(view.localFollows).toEqual([{ kind: 'local', id: target.id, handle: 'alice', displayName: 'Alice' }])
  expect(view.sourceSubscriptions).toEqual([])

  repo.close()
})

// --- Step 1: public projection boundary — active + allowed only, no admin data ---

test('publicFollowing exposes only active subscriptions on allowed sources, hides governance/provenance/admin keys, and derives displayName from hostname', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'pubowner', displayName: 'PubOwner' })
  const service = createSourceService(repo, PUBLIC_URL)

  const allowedId = insertSourceRow(raw, { canonicalUrl: 'https://example.test/feed' })
  insertSubscription(raw, owner.id, allowedId, 'active')

  const pendingId = insertSourceRow(raw, { canonicalUrl: 'https://hidden.test/feed', governance: 'quarantined' })
  insertSubscription(raw, owner.id, pendingId, 'pending')

  const entries = await service.publicFollowing(owner.id)
  const publicJson = JSON.stringify(entries)
  for (const key of ['governance', 'operation', 'provenance', 'provenanceNote', 'adminRetained'])
    expect(publicJson).not.toContain(key)
  expect(publicJson).not.toContain(pendingId)

  const sourceEntry = entries.find((e) => e.kind === 'source')
  expect(sourceEntry).toMatchObject({ kind: 'source', sourceId: allowedId, url: 'https://example.test/feed', displayName: 'example.test' })

  repo.close()
})

test('publicFollowing falls back to the full canonical URL when hostname derivation fails', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'fallbackowner', displayName: 'FallbackOwner' })
  const service = createSourceService(repo, PUBLIC_URL)

  const corruptUrl = 'not-a-valid-url'
  const sourceId = insertSourceRow(raw, { canonicalUrl: corruptUrl })
  insertSubscription(raw, owner.id, sourceId, 'active')

  const entries = await service.publicFollowing(owner.id)
  expect(entries).toEqual([{ kind: 'source', sourceId, url: corruptUrl, displayName: corruptUrl }])

  repo.close()
})
