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
