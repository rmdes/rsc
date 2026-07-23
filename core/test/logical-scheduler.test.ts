import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createScheduler } from '../src/logical/scheduler.ts'
import type { AcquisitionEngine } from '../src/logical/acquisition.ts'
import type { AcquisitionRun, AcquisitionReason, AdminFetchProjection } from '../src/logical/types.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-23T00:00:00.000Z'

function at(seconds: number): string {
  return new Date(Date.parse(NOW) + seconds * 1000).toISOString()
}

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  return { raw: repo.raw as Raw, db, store: createLogicalStore(db), repo }
}

function seedSource(raw: Raw, id: string, opts: { operation?: string; governance?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', ?, ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, `https://feed.test/${id}`, opts.operation ?? 'enabled', opts.governance ?? 'allowed', NOW)
}

async function seedSubscribed(raw: Raw, repo: { createLocalUser: (u: { handle: string; displayName: string }) => Promise<{ id: string }> }, id: string, opts: { operation?: string; governance?: string } = {}): Promise<void> {
  seedSource(raw, id, opts)
  const owner = await repo.createLocalUser({ handle: `owner-${id}`, displayName: id })
  raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`)
    .run(`sub-${id}`, owner.id, id, NOW)
}

// A stub engine: records the order of acquireSource calls and returns a chosen
// terminal outcome. The scheduler only depends on acquireSource + inFlight.
function stubEngine(opts: { order?: string[]; outcomeFor?: (id: string) => AdminFetchProjection['outcome']; inFlight?: Set<string> } = {}): AcquisitionEngine {
  let n = 0
  return {
    async acquireSource(sourceId: string, _reason: AcquisitionReason): Promise<AcquisitionRun> {
      opts.order?.push(sourceId)
      return { runId: `run-${sourceId}-${n++}`, sourceId, status: 'terminal', outcome: opts.outcomeFor?.(sourceId) ?? 'parsed' }
    },
    inFlight: (id: string) => opts.inFlight?.has(id) ?? false,
  }
}

const CONFIG = { pollSeconds: 60 }

test('one pass polls every schedulable source once, in stable sourceId order', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 'c')
  await seedSubscribed(raw, repo, 'a')
  await seedSubscribed(raw, repo, 'b')
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG })

  const polled = await sched.pollDue(NOW)
  expect(polled).toBe(3)
  expect(order).toEqual(['a', 'b', 'c']) // stable id order, each exactly once
  raw.close()
})

test('skip-if-recent: a source polled within RSC_POLL_SECONDS is skipped next pass', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG })

  expect(await sched.pollDue(NOW)).toBe(1)
  // 30s later, still inside the 60s interval → skip
  expect(await sched.pollDue(at(30))).toBe(0)
  // 61s later, interval elapsed → polls again
  expect(await sched.pollDue(at(61))).toBe(1)
  expect(order).toEqual(['s1', 's1'])
  raw.close()
})

test('a source with an in-flight acquisition is refused a second one in the same pass', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  await seedSubscribed(raw, repo, 's2')
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order, inFlight: new Set(['s1']) }), config: CONFIG })

  expect(await sched.pollDue(NOW)).toBe(1) // s1 in flight, only s2 polled
  expect(order).toEqual(['s2'])
  raw.close()
})

test('paused and blocked sources are never scheduled', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 'ok')
  await seedSubscribed(raw, repo, 'paused', { operation: 'paused' })
  await seedSubscribed(raw, repo, 'blocked', { governance: 'blocked' })
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG })

  expect(await sched.pollDue(NOW)).toBe(1)
  expect(order).toEqual(['ok'])
  raw.close()
})

test('a source with no active subscription and no federation is not scheduled', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 'lonely') // exists, enabled+allowed, but no subscriber
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG })

  expect(await sched.pollDue(NOW)).toBe(0)
  expect(order).toEqual([])
  raw.close()
})

test('consecutive failures count up on operational failure and reset on success', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  let outcome: AdminFetchProjection['outcome'] = 'operational_failure'
  const sched = createScheduler({ store, acquisition: stubEngine({ outcomeFor: () => outcome }), config: CONFIG })

  await sched.pollDue(NOW)
  await sched.pollDue(at(61))
  let h = raw.prepare(`SELECT consecutive_failures, last_failure_at, last_success_at FROM source_health_v2 WHERE source_id = 's1'`).get() as { consecutive_failures: number; last_failure_at: string | null; last_success_at: string | null }
  expect(h.consecutive_failures).toBe(2)
  expect(h.last_failure_at).toBe(at(61))
  expect(h.last_success_at).toBeNull()

  outcome = 'parsed'
  await sched.pollDue(at(122))
  h = raw.prepare(`SELECT consecutive_failures, last_success_at FROM source_health_v2 WHERE source_id = 's1'`).get() as { consecutive_failures: number; last_failure_at: string | null; last_success_at: string | null }
  expect(h.consecutive_failures).toBe(0) // reset by success
  expect(h.last_success_at).toBe(at(122))
  raw.close()
})

test('a later pass may start a new run after the earlier run is no longer in flight', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG })

  await sched.pollDue(NOW)
  await sched.pollDue(at(61)) // engine reports not in flight (stub) → a second run starts
  expect(order).toEqual(['s1', 's1'])
  raw.close()
})

test('start/stop/wake are present and stop halts the loop', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, now: () => NOW })
  expect(typeof sched.start).toBe('function')
  expect(typeof sched.stop).toBe('function')
  expect(typeof sched.wake).toBe('function')
  sched.stop() // idempotent before start
  raw.close()
})
