import type { Repository } from './domain/repository.ts'
import type { Config } from './config.ts'
import type { LogicalStore } from './logical/store.ts'

// Runs on server.ts's hourly sweepTimer (V4 Task 11 GAP 1): the retired v1 poll
// cycle (domain/push-in.ts, now deleted) was the ONLY caller of
// purgeExpiredSubscriptions — it deletes from the OUTBOUND `subscriptions`
// table (peers who follow OUR feeds via WebSub/rssCloud). The v2 scheduler
// purges a DIFFERENT table (push_subscriptions_v2, inbound leases) — see
// logical/scheduler.ts — so this call has no v2 equivalent and must be wired
// in explicitly, or the outbound table grows unbounded forever.
export async function sweepHousekeeping(
  repo: Pick<Repository, 'sweepAnonymousUsers' | 'purgeExpiredSubscriptions'>,
  config: Config,
  logical?: LogicalStore,
): Promise<{ anonSwept: number }> {
  const { swept } = repo.sweepAnonymousUsers(config.anonTtlDays, logical)
  await repo.purgeExpiredSubscriptions(new Date().toISOString())
  return { anonSwept: swept }
}
