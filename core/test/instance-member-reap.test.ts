import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { reapSource } from '../src/domain/source-repository.ts'

// Task 1 — reapSource must refuse to auto-reap a source that is a live
// member of an approved instance (design 2026-08-06 rev 2): a per-user
// origin_verification member's verified_origin claim churns away far more
// often than its membership does, so gating reap on the claim alone
// silently deletes still-governed members and decays admin member counts
// to 0. This guard checks membership directly instead.

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  return { raw: repo.raw as Raw }
}

function seedSource(raw: Raw, opts: {
  id: string; url: string; provenance?: string; governance?: string
}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, overridden, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', ?, ?, NULL, 0, 0, ?)`,
  ).run(opts.id, opts.url, opts.governance ?? 'allowed', opts.provenance ?? 'origin_verification', NOW)
}

function approveFederation(raw: Raw, sourceId: string): void {
  raw.prepare(
    `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'approved', NULL, ?, ?)`,
  ).run(sourceId, NOW, NOW)
}

test('reapSource refuses an instance-governed member with no verified_origin claim, force still reaps, and revoking the instance restores ordinary reap', async () => {
  const { raw } = await fresh()
  seedSource(raw, { id: 'inst', url: 'https://rss.chat/hub.xml', provenance: 'admin_federation' })
  approveFederation(raw, 'inst')
  seedSource(raw, { id: 'member', url: 'https://rss.chat/users/a.xml' }) // origin_verification, in prefix range, no claim

  const refused = reapSource(raw, 'member', { force: false }, NOW)
  expect(refused).toEqual({ kind: 'refused', reason: 'instance_member' })

  const forced = reapSource(raw, 'member', { force: true }, NOW)
  expect(forced).toEqual({ kind: 'reaped' })
})

test('revoking the instance (deleting its federation_relationships_v2 row) restores ordinary reap for the former member', async () => {
  const { raw } = await fresh()
  seedSource(raw, { id: 'inst', url: 'https://rss.chat/hub.xml', provenance: 'admin_federation' })
  approveFederation(raw, 'inst')
  seedSource(raw, { id: 'member', url: 'https://rss.chat/users/a.xml' })

  raw.prepare(`DELETE FROM federation_relationships_v2 WHERE source_id = ?`).run('inst')

  const result = reapSource(raw, 'member', { force: false }, NOW)
  expect(result).toEqual({ kind: 'reaped' })
})

test('an ordinary orphan (opml provenance, no instance covers it) is still reaped', async () => {
  const { raw } = await fresh()
  seedSource(raw, { id: 'orphan', url: 'https://standalone.test/feed.xml', provenance: 'opml' })

  const result = reapSource(raw, 'orphan', { force: false }, NOW)
  expect(result).toEqual({ kind: 'reaped' })
})

test('a row that is itself approved-federated is refused federated, not instance_member, even though its prefix falls inside a covering instance', async () => {
  const { raw } = await fresh()
  seedSource(raw, { id: 'inst', url: 'https://rss.chat/hub.xml', provenance: 'admin_federation' })
  approveFederation(raw, 'inst')
  // self-governing: origin_verification provenance AND its own approved relationship.
  seedSource(raw, { id: 'self-fed', url: 'https://rss.chat/users/b.xml' })
  approveFederation(raw, 'self-fed')

  const result = reapSource(raw, 'self-fed', { force: false }, NOW)
  expect(result).toEqual({ kind: 'refused', reason: 'federated' })
})

// Task 2 — retentionFor (the admin orphan-list's display classifier) must
// agree with reapSource's guard: a live instance member surfaces
// retention === 'instance_member', not 'reapable', even with no
// verified_origin claim. Exercised through getSourceDetail, the public read
// that wraps the private retentionFor.
test('getSourceDetail surfaces retention "instance_member" for a live instance member with no verified_origin claim', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  seedSource(raw, { id: 'inst', url: 'https://rss.chat/hub.xml', provenance: 'admin_federation' })
  approveFederation(raw, 'inst')
  seedSource(raw, { id: 'member', url: 'https://rss.chat/users/a.xml' })

  const detail = await repo.getSourceDetail('member')
  expect(detail?.retention).toBe('instance_member')
})
