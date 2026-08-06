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
  const config = loadConfig({ RSC_TOKEN: 'x', RSC_AUTH_SECRET: 'x' })
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
  const config = loadConfig({ RSC_TOKEN: 'x', RSC_AUTH_SECRET: 'x' })

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

// F-3 (email-flows review): the sweep reclaimed only anonymous rows, so an
// abandoned sign-up or an SMTP-down outage left a never-verified `user` row
// that nothing ever cleaned up. Safe to hard-delete because `auth.ts:266` sets
// requireEmailVerification: true — better-auth then issues NO session token at
// sign-up (docs, email-enumeration-protection), so such a row can never sign
// in, and therefore never posted, followed or subscribed. `createdAt` is its
// only clock.
const unverifiedEnv = { RSC_TOKEN: 'x', RSC_AUTH_SECRET: 'x' }
const insertAuthUser = (
  repo: Awaited<ReturnType<typeof createSqliteRepository>>,
  id: string,
  opts: { verified: boolean; anonymous: boolean; ageDays: number },
) => {
  const at = new Date(Date.now() - opts.ageDays * 86400_000).toISOString()
  repo.raw
    .prepare(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, isAnonymous) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, id, `${id}@example.test`, opts.verified ? 1 : 0, at, at, opts.anonymous ? 1 : null)
}

test('sweepHousekeeping reclaims a never-verified account past the TTL', async () => {
  const repo = await createSqliteRepository(':memory:')
  const config = loadConfig(unverifiedEnv)
  insertAuthUser(repo, 'stale-signup', { verified: false, anonymous: false, ageDays: 8 })

  const { unverifiedSwept } = await sweepHousekeeping(repo, config)
  expect(unverifiedSwept).toBe(1)
  expect(repo.raw.prepare(`SELECT id FROM user WHERE id = ?`).get('stale-signup')).toBeUndefined()
})

test('sweepHousekeeping spares verified, recent, and anonymous rows', async () => {
  const repo = await createSqliteRepository(':memory:')
  const config = loadConfig(unverifiedEnv)
  insertAuthUser(repo, 'verified-old', { verified: true, anonymous: false, ageDays: 400 })
  insertAuthUser(repo, 'unverified-fresh', { verified: false, anonymous: false, ageDays: 1 })
  // Anonymous rows are the anon sweep's job and are counted there, not here —
  // otherwise one row would be swept (and counted) twice.
  insertAuthUser(repo, 'anon-old', { verified: false, anonymous: true, ageDays: 30 })

  const { anonSwept, unverifiedSwept } = await sweepHousekeeping(repo, config)
  expect(unverifiedSwept).toBe(0)
  expect(anonSwept).toBe(1)
  expect(repo.raw.prepare(`SELECT id FROM user WHERE id = ?`).get('verified-old')).toBeDefined()
  expect(repo.raw.prepare(`SELECT id FROM user WHERE id = ?`).get('unverified-fresh')).toBeDefined()
})

test('a never-verified account with a core user and an api key is fully reclaimed', async () => {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const logical = createLogicalStore(db)
  const config = loadConfig(unverifiedEnv)
  insertAuthUser(repo, 'stale-with-rows', { verified: false, anonymous: false, ageDays: 8 })
  await repo.createLocalUser({ handle: 'stale', displayName: 'stale', authUserId: 'stale-with-rows' })
  // Pins the deleteAuthRows apikey lesson (sqlite.ts:410-417) for this new
  // entry point too: a surviving key resurrects the identity via ensureCoreUser.
  const at = new Date().toISOString()
  repo.raw
    .prepare(`INSERT INTO apikey (id, configId, referenceId, key, createdAt, updatedAt) VALUES (?, 'user', ?, ?, ?, ?)`)
    .run('key-1', 'stale-with-rows', 'hashed', at, at)

  const { unverifiedSwept } = await sweepHousekeeping(repo, config, logical)
  expect(unverifiedSwept).toBe(1)
  expect(await repo.getUserByHandle('stale')).toBeUndefined()
  expect(repo.raw.prepare(`SELECT id FROM apikey WHERE referenceId = ?`).get('stale-with-rows')).toBeUndefined()
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
  const config = loadConfig({ RSC_TOKEN: 'x', RSC_AUTH_SECRET: 'x' })

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
