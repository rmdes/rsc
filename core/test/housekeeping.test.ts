import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { loadConfig } from '../src/config.ts'
import { sweepHousekeeping } from '../src/housekeeping.ts'

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
