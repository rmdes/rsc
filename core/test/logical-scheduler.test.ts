import { test, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createScheduler } from '../src/logical/scheduler.ts'
import { createLogicalPush } from '../src/logical/push.ts'
import type { PushClaim } from '../src/logical/push.ts'
import { loadConfig } from '../src/config.ts'
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
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined })

  const polled = await sched.pollDue(NOW)
  expect(polled).toBe(3)
  expect(order).toEqual(['a', 'b', 'c']) // stable id order, each exactly once
  raw.close()
})

test('skip-if-recent: a source polled within RSC_POLL_SECONDS is skipped next pass', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined })

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
  const sched = createScheduler({ store, acquisition: stubEngine({ order, inFlight: new Set(['s1']) }), config: CONFIG, drainVerification: undefined })

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
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined })

  expect(await sched.pollDue(NOW)).toBe(1)
  expect(order).toEqual(['ok'])
  raw.close()
})

test('a source with no active subscription and no federation is not scheduled', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 'lonely') // exists, enabled+allowed, but no subscriber
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined })

  expect(await sched.pollDue(NOW)).toBe(0)
  expect(order).toEqual([])
  raw.close()
})

test('consecutive failures count up on operational failure and reset on success', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  let outcome: AdminFetchProjection['outcome'] = 'operational_failure'
  const sched = createScheduler({ store, acquisition: stubEngine({ outcomeFor: () => outcome }), config: CONFIG, drainVerification: undefined })

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
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined })

  await sched.pollDue(NOW)
  await sched.pollDue(at(61)) // engine reports not in flight (stub) → a second run starts
  expect(order).toEqual(['s1', 's1'])
  raw.close()
})

// --- the background verification drain rides THIS loop (pre-V4 fix I1) --------
// Verification's bounded fetch is network I/O, so it may not run on the pre-listen
// startup path or on a request path. It rides the poll tick instead — no second
// timer — which also means `stop()` halts it and `tick()`'s catch contains it.

// One turn of the event loop: `start()` fires its tick immediately, and the tick
// awaits before it reaches the background drain.
const turn = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

test('the poll tick runs the background verification drain', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  let drains = 0
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, now: () => NOW, drainVerification: async () => { drains++ } })
  sched.start()
  await turn()
  expect(drains).toBe(1)
  sched.stop()
  raw.close()
})

test('the tick drains verification even when the poll pass polls nothing', async () => {
  const { raw, store } = await fresh() // no schedulable source at all
  let drains = 0
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, now: () => NOW, drainVerification: async () => { drains++ } })
  sched.start()
  await turn()
  expect(drains).toBe(1) // the drain is not conditional on there being work to poll
  sched.stop()
  raw.close()
})

test('stop() halts the background drain too — a tick already in flight starts none', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  let drains = 0
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, now: () => NOW, drainVerification: async () => { drains++ } })
  sched.start() // the tick is now suspended inside the poll pass
  sched.stop()
  await turn()
  expect(drains).toBe(0)
  // …and the same loop, not stopped, does run it — so the zero above is the stop,
  // never an absent wiring.
  sched.start()
  await turn()
  expect(drains).toBe(1)
  sched.stop()
  raw.close()
})

test('a throwing background drain is contained by the tick and never takes the process down', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const errors: unknown[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args[0]) })
  const sched = createScheduler({
    store, acquisition: stubEngine(), config: CONFIG, now: () => NOW,
    drainVerification: async () => { throw new Error('verification exploded') },
  })
  sched.start()
  await turn()
  sched.stop()
  spy.mockRestore()
  expect(errors).toContain('poll loop failed:')
  raw.close()
})

// --- the v2 push lifecycle rides THIS pass (V4 Task 2, spec §1.3) ------------
// Registration after each successful acquisition commit, one renewal sweep plus
// the expired-row purge at pass end, and the reduced cadence for a live lease —
// v1's runPollCycle tail (push-in.ts:264,271-272) rebuilt over sources.

function stubPush(opts: { claim?: PushClaim | null; active?: Set<string> } = {}) {
  const registered: Array<{ sourceId: string; claim: PushClaim | null }> = []
  const passes: string[] = []
  return {
    registered,
    passes,
    hasActivePush: (sourceId: string) => opts.active?.has(sourceId) ?? false,
    latestClaim: () => opts.claim ?? null,
    async maybeRegister(sourceId: string, claim: PushClaim | null) { registered.push({ sourceId, claim }) },
    async renewDue() { passes.push('renew') },
    purgeExpired() { passes.push('purge') },
  }
}

const CLAIM: PushClaim = { mode: 'websub', endpoint: 'https://hub.test/hub', topic: 'https://blog.test/feed.xml' }

test('a successful poll registers from the latest run’s claim; each pass ends with one renewal sweep then the purge', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const push = stubPush({ claim: CLAIM })
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, drainVerification: undefined, push })

  expect(await sched.pollDue(NOW)).toBe(1)
  expect(push.registered).toEqual([{ sourceId: 's1', claim: CLAIM }])
  expect(push.passes).toEqual(['renew', 'purge']) // exactly once per pass, in order
  raw.close()
})

test('a failed poll registers nothing, and the sweep still ends the pass', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const push = stubPush({ claim: CLAIM })
  const sched = createScheduler({ store, acquisition: stubEngine({ outcomeFor: () => 'operational_failure' }), config: CONFIG, drainVerification: undefined, push })

  await sched.pollDue(NOW)
  expect(push.registered).toEqual([])
  expect(push.passes).toEqual(['renew', 'purge'])
  raw.close()
})

test('an active push lease reduces the cadence to 10 × the base interval — durable, no tick state', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined, push: stubPush({ active: new Set(['s1']) }) })

  expect(await sched.pollDue(NOW)).toBe(1)
  expect(await sched.pollDue(at(61))).toBe(0) // past the base interval, inside the push one
  expect(await sched.pollDue(at(599))).toBe(0)
  expect(await sched.pollDue(at(601))).toBe(1) // 10 × 60 s elapsed since lastPollAt
  expect(order).toEqual(['s1', 's1'])
  raw.close()
})

test('a pending push row does not reduce the cadence', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  // hasActivePush is false for a pending row (see logical-push.test.ts) → base cadence
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, drainVerification: undefined, push: stubPush({ active: new Set() }) })

  expect(await sched.pollDue(NOW)).toBe(1)
  expect(await sched.pollDue(at(61))).toBe(1)
  raw.close()
})

test('with push ineffective the pass writes no push row and makes no request', async () => {
  const { raw, db, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  raw.prepare(
    `INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json)
     VALUES ('r1', 's1', 'scheduled', 'terminal', ?, ?, ?, 'parsed', '{}', NULL, NULL, ?)`,
  ).run(NOW, NOW, NOW, JSON.stringify(CLAIM))
  const fetchFn = vi.fn(async () => new Response('', { status: 202 }))
  const push = createLogicalPush({
    db, store, config: loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://rsc.test', RSC_PUSH_IN: 'off' }),
    fetchFn: fetchFn as unknown as typeof fetch, lookupFn: async () => [{ address: '93.184.216.34' }],
  })
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, drainVerification: undefined, push })

  await sched.pollDue(NOW)
  expect(raw.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions_v2`).get()).toEqual({ n: 0 })
  expect(fetchFn).not.toHaveBeenCalled()
  raw.close()
})

test('start/stop/wake are present and stop halts the loop', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, now: () => NOW, drainVerification: undefined })
  expect(typeof sched.start).toBe('function')
  expect(typeof sched.stop).toBe('function')
  expect(typeof sched.wake).toBe('function')
  sched.stop() // idempotent before start
  raw.close()
})
