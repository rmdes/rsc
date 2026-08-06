import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository, healStrandedMembers } from '../src/storage/sqlite.ts'
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

// Task 4 — healStrandedMembers (one-time recovery heal, migration #23). The
// pre-fix reap bug already deleted some instance-governed members' source
// rows before Task 1's guard landed, leaving their verification_checks_v2
// row stuck 'verified' for a source that no longer exists, and its
// verification job stuck terminal. The heal resets both to their
// fresh-scheduleVerification shape so the normal drain re-mints the member.

function seedItem(raw: Raw, id: string): void {
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'remote', ?, 'none', NULL, NULL, NULL, ?)`,
  ).run(id, NOW, NOW)
}

function seedVerifiedCheck(raw: Raw, opts: { id: string; itemId: string; sourceId: string; batchKey: string }): void {
  raw.prepare(
    `INSERT INTO verification_checks_v2 (id, logical_item_id, source_id, publisher_feed_url, batch_key, state, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, 'verified', ?, ?)`,
  ).run(opts.id, opts.itemId, opts.sourceId, opts.batchKey, opts.batchKey, NOW, NOW)
}

function seedVerificationJob(raw: Raw, opts: { id: string; batchKey: string }): void {
  raw.prepare(
    `INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at) VALUES (?, 'verification', NULL, NULL, ?, 'reconciled', 3, ?, 'operational_exhausted', 'boom', ?)`,
  ).run(opts.id, opts.batchKey, NOW, NOW)
}

test('healStrandedMembers resets a verified check + its verification job stranded by a deleted origin source, leaves live-member and tombstoned checks untouched, and is idempotent', async () => {
  const { raw } = await fresh()
  seedSource(raw, { id: 'agg', url: 'https://rss.chat/hub.xml', provenance: 'admin_federation' })
  seedItem(raw, 'item-stranded')
  seedItem(raw, 'item-covered')
  seedItem(raw, 'item-tombstoned')

  // stranded: verified check whose origin source was reaped away — no
  // remote_sources_v2 row exists for its batch_key.
  seedVerifiedCheck(raw, { id: 'chk-stranded', itemId: 'item-stranded', sourceId: 'agg', batchKey: 'https://rss.chat/users/reaped.xml' })
  seedVerificationJob(raw, { id: 'job-stranded', batchKey: 'https://rss.chat/users/reaped.xml' })

  // covered: verified check whose batch_key DOES have a live remote_sources_v2 row.
  seedSource(raw, { id: 'covered-src', url: 'https://rss.chat/users/covered.xml' })
  seedVerifiedCheck(raw, { id: 'chk-covered', itemId: 'item-covered', sourceId: 'agg', batchKey: 'https://rss.chat/users/covered.xml' })

  // tombstoned: verified check whose batch_key was deliberately purged — never resurrect it.
  raw.prepare(
    `INSERT INTO blocked_source_tombstones_v2 (id, canonical_url, action, category, actor_id, note, created_at, updated_at) VALUES (?, ?, 'purge', 'abuse', NULL, NULL, ?, ?)`,
  ).run('tomb-1', 'https://rss.chat/users/blocked.xml', NOW, NOW)
  seedVerifiedCheck(raw, { id: 'chk-tombstoned', itemId: 'item-tombstoned', sourceId: 'agg', batchKey: 'https://rss.chat/users/blocked.xml' })

  healStrandedMembers(raw)

  const stranded = raw.prepare(`SELECT state, resolved_at FROM verification_checks_v2 WHERE id = ?`).get('chk-stranded') as { state: string; resolved_at: string | null }
  expect(stranded.state).toBe('pending')
  expect(stranded.resolved_at).toBeNull()

  const job = raw.prepare(`SELECT status, attempts, failure_category, diagnostic FROM reconciliation_jobs_v2 WHERE id = ?`).get('job-stranded') as { status: string; attempts: number; failure_category: string | null; diagnostic: string | null }
  expect(job.status).toBe('pending')
  expect(job.attempts).toBe(0)
  expect(job.failure_category).toBeNull()
  expect(job.diagnostic).toBeNull()

  const covered = raw.prepare(`SELECT state FROM verification_checks_v2 WHERE id = ?`).get('chk-covered') as { state: string }
  expect(covered.state).toBe('verified')

  const tombstoned = raw.prepare(`SELECT state FROM verification_checks_v2 WHERE id = ?`).get('chk-tombstoned') as { state: string }
  expect(tombstoned.state).toBe('verified')

  // idempotent: a second run leaves everything exactly where the first left it.
  healStrandedMembers(raw)
  const strandedAgain = raw.prepare(`SELECT state, resolved_at FROM verification_checks_v2 WHERE id = ?`).get('chk-stranded') as { state: string; resolved_at: string | null }
  expect(strandedAgain).toEqual(stranded)
  const jobAgain = raw.prepare(`SELECT status, attempts, failure_category, diagnostic FROM reconciliation_jobs_v2 WHERE id = ?`).get('job-stranded') as typeof job
  expect(jobAgain).toEqual(job)
})
