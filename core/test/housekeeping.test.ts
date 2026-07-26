import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { loadConfig } from '../src/config.ts'
import { sweepHousekeeping } from '../src/housekeeping.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'

test('sweepHousekeeping purges expired outbound subscriptions', async () => {
  const repo = await createSqliteRepository(':memory:')
  const now = new Date()
  const expired = new Date(now.getTime() - 1000).toISOString()
  const future = new Date(now.getTime() + 3600_000).toISOString()
  await repo.upsertSubscription({
    id: 'sub-expired', protocol: 'websub', topic: 'https://a.example/feed.xml',
    callback: 'https://hub.example/cb1', callbackHost: 'hub.example',
    secret: null, expiresAt: expired, createdAt: now.toISOString(),
  })
  await repo.upsertSubscription({
    id: 'sub-live', protocol: 'websub', topic: 'https://b.example/feed.xml',
    callback: 'https://hub.example/cb2', callbackHost: 'hub.example',
    secret: null, expiresAt: future, createdAt: now.toISOString(),
  })
  const config = loadConfig({ ...process.env, RSC_SOURCE_MODEL_V2: undefined })
  // Cutoff far in the past: expires_at > cutoff is true for every realistic row,
  // so this counts rows actually present in the table, irrespective of expiry.
  const epoch = '1970-01-01T00:00:00.000Z'
  const beforeCount = await repo.countActiveSubscriptions({}, epoch)
  expect(beforeCount).toBe(2)
  await sweepHousekeeping(repo, config)
  const afterCount = await repo.countActiveSubscriptions({}, epoch)
  expect(afterCount).toBe(1) // sub-expired was actually deleted by purgeExpiredSubscriptions
})

// Task 8c (V1 retirement): reproduces a real production bug found during Task
// 8b. logical_local_origins_v2.post_id is ON DELETE RESTRICT; the anonymous
// account below posts THROUGH THE V2 PATH (store.createLocalPost — the same
// call service.createLocalPostAs's v2 branch makes), which is what actually
// populates that bridge row. A raw `DELETE FROM posts` (deleteUserCascade)
// against an account that has one violates the FK; deleteUserCascade must not
// be reached for this account once a `logical` store is available.
test('sweepHousekeeping reclaims an idle anonymous account that posted under v2, without an FK violation', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const logical = createLogicalStore(db)
  const config = loadConfig({ ...process.env, RSC_SOURCE_MODEL_V2: undefined })

  const authUserId = 'anon-auth-1'
  const old = new Date(Date.now() - 8 * 86400_000).toISOString() // beyond the 7-day default anonTtlDays
  repo.raw.prepare(
    `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, isAnonymous) VALUES (?, ?, ?, 0, ?, ?, 1)`,
  ).run(authUserId, 'guest', 'guest@example.test', old, old)
  const author = await repo.createLocalUser({ handle: 'idle-guest', displayName: 'idle-guest', authUserId })
  logical.createLocalPost({ author, content: 'hello from v2', replyToId: null, now: new Date().toISOString(), publicUrl: null })

  const { anonSwept } = await sweepHousekeeping(repo, config, logical)
  expect(anonSwept).toBe(1)
  expect(await repo.getUserByHandle('idle-guest')).toBeUndefined() // reclaimed, not just "didn't throw"
})

// Independently re-verified review finding (Task 8c follow-up): deleteLocalAccount
// (logical/local.ts) deletes follows/push_subscriptions/users but never read
// source_subscriptions_v2 nor called reapSourceIfOrphaned, unlike its sibling
// deleteUserCascade (storage/sqlite.ts). source_subscriptions_v2.owner_id is ON
// DELETE CASCADE, so the subscription row vanishes silently with the user, but
// nothing then checks whether the subscribed remote_sources_v2 row was left with
// zero subscribers. This test makes the swept anonymous account the SOLE active
// subscriber of an 'allowed'-governance source with no audit/federation/
// verification history — the one shape reapSourceIfOrphaned will actually reap —
// and asserts the source row is gone after the sweep, not just the subscription.
test('sweepHousekeeping reaps a source left orphaned by the swept account\'s deletion', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const logical = createLogicalStore(db)
  const config = loadConfig({ ...process.env, RSC_SOURCE_MODEL_V2: undefined })

  const authUserId = 'anon-auth-2'
  const old = new Date(Date.now() - 8 * 86400_000).toISOString()
  repo.raw.prepare(
    `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, isAnonymous) VALUES (?, ?, ?, 0, ?, ?, 1)`,
  ).run(authUserId, 'guest', 'guest2@example.test', old, old)
  const author = await repo.createLocalUser({ handle: 'idle-subscriber', displayName: 'idle-subscriber', authUserId })
  logical.createLocalPost({ author, content: 'hello from v2', replyToId: null, now: new Date().toISOString(), publicUrl: null })

  repo.raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'user_subscription', 0, ?)`,
  ).run('source-1', 'https://orphan.example/feed.xml', old)
  repo.raw.prepare(
    `INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`,
  ).run('sub-1', author.id, 'source-1', old)

  const { anonSwept } = await sweepHousekeeping(repo, config, logical)
  expect(anonSwept).toBe(1)
  expect(repo.raw.prepare(`SELECT id FROM remote_sources_v2 WHERE id = ?`).get('source-1')).toBeUndefined()
})
