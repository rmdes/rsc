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
  repo: Pick<Repository, 'sweepAnonymousUsers' | 'sweepUnverifiedUsers' | 'sweepDeadSources' | 'purgeExpiredSubscriptions'>,
  config: Config,
  logical?: LogicalStore,
): Promise<{ anonSwept: number; unverifiedSwept: number; deadSourcesSwept: number }> {
  const { swept } = repo.sweepAnonymousUsers(config.anonTtlDays, logical)
  // F-3: anonymous first, so a row that is both (guests are emailVerified = 0)
  // is claimed by the sweep that owns it and counted once.
  const { swept: unverifiedSwept } = repo.sweepUnverifiedUsers(config.unverifiedTtlDays, logical)
  // AFTER the user sweeps: sweeping a guest deletes its posts, which is what
  // strands its per-user-feed source in the first place. Running dead sources
  // last lets the same pass clean up what the sweep above just orphaned.
  const { swept: deadSourcesSwept } = repo.sweepDeadSources()
  await repo.purgeExpiredSubscriptions(new Date().toISOString())
  return { anonSwept: swept, unverifiedSwept, deadSourcesSwept }
}
