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

const CONFIG = { pollSeconds: 60, ingestCycleMinutes: 1, ingestConcurrency: 8, ingestMaxPerHost: 8 }

// --- store: listDueSources / countSchedulableSources (spec 2026-07-28) -------
// Staleness-ordered, LIMIT-bounded due-query + a cheap catalog-size count — the
// two primitives the self-pacing scheduler (below) composes into a batch size.
// Tested directly against the store here, independent of the scheduler.

test('countSchedulableSources matches listSchedulableSources().length', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 'a')
  await seedSubscribed(raw, repo, 'b')
  seedSource(raw, 'lonely') // no subscriber, no federation — not schedulable
  expect(store.countSchedulableSources()).toBe(2)
  expect(store.listSchedulableSources().length).toBe(2)
  raw.close()
})

// --- instance members are schedulable (2026-08-17) ---------------------------
// Origin verification mints a single_publisher source for an author's own feed
// and fetches it ONCE. That delivery then outranks the aggregate one and
// becomes what readers see — so a copy nobody ever refreshes was the copy on
// display, and no later edit or removal at the origin could reach us. A member
// of an instance we federate with is therefore schedulable in its own right.
// Approved-only, deliberately: the instance itself is schedulable while its
// federation is still pending, but its members are a far wider blast radius.

// `overridden` is written explicitly in both seeds: the column DEFAULTs to 1
// (sqlite.ts), but a federation source is created with 1 and a
// verification-minted member with 0, and 0-vs-1 decides whether the ordinary
// governance cascade reaches the row. Relying on the default would seed
// admin-overridden members and quietly test the wrong thing.
function seedInstance(raw: Raw, id: string, host: string, opts: { status?: string; governance?: string; operation?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, overridden, created_at)
     VALUES (?, ?, 'aggregate', ?, ?, 'admin_federation', NULL, 0, 1, ?)`,
  ).run(id, `https://${host}/users/rss.xml`, opts.operation ?? 'enabled', opts.governance ?? 'allowed', NOW)
  raw.prepare(`INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`)
    .run(id, opts.status ?? 'approved', NOW, NOW)
}

// Column-for-column what verification.ts's findOrCreateOriginSource writes:
// single_publisher, origin_verification, overridden 0, and — the point — no
// subscription and no federation row of its own.
function seedMember(raw: Raw, id: string, url: string, opts: { governance?: string; operation?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, overridden, created_at)
     VALUES (?, ?, 'single_publisher', ?, ?, 'origin_verification', NULL, 0, 0, ?)`,
  ).run(id, url, opts.operation ?? 'enabled', opts.governance ?? 'allowed', NOW)
}

test('an origin_verification member of an approved instance is schedulable', async () => {
  const { raw, store } = await fresh()
  seedInstance(raw, 'inst', 'peer.test')
  seedMember(raw, 'member', 'https://peer.test/users/claude/feed.xml')
  expect(store.listSchedulableSources()).toEqual(['inst', 'member'])
  expect(store.countSchedulableSources()).toBe(2)
  expect(store.listDueSources({ now: NOW, pollSeconds: 60, pushPollFactor: 10, limit: 10 }).map((d) => d.id))
    .toEqual(['inst', 'member'])
  raw.close()
})

test('an origin_verification source under no approved instance stays unschedulable', async () => {
  const { raw, store } = await fresh()
  seedInstance(raw, 'inst', 'peer.test')
  // Verified through an aggregator we merely subscribe to — a different host,
  // so no approved instance governs it. We do not poll the whole web.
  seedMember(raw, 'stranger', 'https://elsewhere.test/authors/bob.xml')
  expect(store.listSchedulableSources()).toEqual(['inst'])
  raw.close()
})

test('members of a pending-federation instance are not schedulable', async () => {
  const { raw, store } = await fresh()
  seedInstance(raw, 'inst', 'peer.test', { status: 'pending' })
  seedMember(raw, 'member', 'https://peer.test/users/claude/feed.xml')
  expect(store.listSchedulableSources()).toEqual(['inst']) // the instance itself still is
  raw.close()
})

test('a blocked member is not schedulable even under an approved instance', async () => {
  const { raw, store } = await fresh()
  seedInstance(raw, 'inst', 'peer.test')
  seedMember(raw, 'member', 'https://peer.test/users/claude/feed.xml', { governance: 'blocked' })
  expect(store.listSchedulableSources()).toEqual(['inst'])
  raw.close()
})

test('a member is not schedulable once its instance is blocked', async () => {
  const { raw, store } = await fresh()
  seedInstance(raw, 'inst', 'peer.test', { governance: 'blocked' })
  seedMember(raw, 'member', 'https://peer.test/users/claude/feed.xml')
  expect(store.listSchedulableSources()).toEqual([])
  raw.close()
})

// Pausing an instance must stop traffic to the whole instance, members
// included. An instance is one feed; its members are as many as it has
// authors, so members that kept polling through a pause would hit the peer
// harder than never pausing at all.
test('pausing an instance also stops polling its members', async () => {
  const { raw, store } = await fresh()
  seedInstance(raw, 'inst', 'peer.test', { operation: 'paused' })
  seedMember(raw, 'member', 'https://peer.test/users/claude/feed.xml')
  expect(store.listSchedulableSources()).toEqual([])
  raw.close()
})

test('scheme is part of the instance identity — http members do not ride an https federation', async () => {
  const { raw, store } = await fresh()
  seedInstance(raw, 'inst', 'peer.test')
  seedMember(raw, 'member', 'http://peer.test/users/claude/feed.xml')
  expect(store.listSchedulableSources()).toEqual(['inst'])
  raw.close()
})

test('listDueSources: never-polled sources are due, ordered by id when equally stale', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 'c')
  await seedSubscribed(raw, repo, 'a')
  await seedSubscribed(raw, repo, 'b')
  const due = store.listDueSources({ now: NOW, pollSeconds: 60, pushPollFactor: 10, limit: 10 })
  expect(due.map((d) => d.id)).toEqual(['a', 'b', 'c'])
  expect(due[0]).toEqual({ id: 'a', canonicalUrl: 'https://feed.test/a' })
  raw.close()
})

test('listDueSources: a source polled within pollSeconds is excluded', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  raw.prepare(`INSERT INTO source_health_v2 (source_id, last_poll_at, last_success_at, last_failure_at, consecutive_failures) VALUES ('s1', ?, ?, NULL, 0)`).run(NOW, NOW)
  expect(store.listDueSources({ now: at(30), pollSeconds: 60, pushPollFactor: 10, limit: 10 })).toEqual([])
  expect(store.listDueSources({ now: at(61), pollSeconds: 60, pushPollFactor: 10, limit: 10 }).map((d) => d.id)).toEqual(['s1'])
  raw.close()
})

test('listDueSources: an active push lease widens the interval to pollSeconds × pushPollFactor', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  raw.prepare(`INSERT INTO source_health_v2 (source_id, last_poll_at, last_success_at, last_failure_at, consecutive_failures) VALUES ('s1', ?, ?, NULL, 0)`).run(NOW, NOW)
  raw.prepare(
    `INSERT INTO push_subscriptions_v2 (id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES ('lease-1', 's1', 'websub', 'https://hub.test/hub', 'https://feed.test/s1', 'tok-1', NULL, 'active', ?, ?)`,
  ).run(at(100000), NOW)
  // 61s elapsed: past the base interval, still inside the 10x push interval
  expect(store.listDueSources({ now: at(61), pollSeconds: 60, pushPollFactor: 10, limit: 10 })).toEqual([])
  // 601s elapsed: past 10 × 60s
  expect(store.listDueSources({ now: at(601), pollSeconds: 60, pushPollFactor: 10, limit: 10 }).map((d) => d.id)).toEqual(['s1'])
  raw.close()
})

test('listDueSources: LIMIT bounds the result to the most-overdue N', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 'a')
  await seedSubscribed(raw, repo, 'b')
  await seedSubscribed(raw, repo, 'c')
  expect(store.listDueSources({ now: NOW, pollSeconds: 60, pushPollFactor: 10, limit: 2 }).map((d) => d.id)).toEqual(['a', 'b'])
  raw.close()
})

test('one pass polls every schedulable source once — staleness order ties on id when all are equally never-polled', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 'c')
  await seedSubscribed(raw, repo, 'a')
  await seedSubscribed(raw, repo, 'b')
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })

  const polled = await sched.pollDue(NOW)
  expect(polled).toBe(3)
  expect(order).toEqual(['a', 'b', 'c']) // stable id order, each exactly once
  raw.close()
})

test('skip-if-recent: a source polled within RSC_POLL_SECONDS is skipped next pass', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })

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
  const sched = createScheduler({ store, acquisition: stubEngine({ order, inFlight: new Set(['s1']) }), config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })

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
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })

  expect(await sched.pollDue(NOW)).toBe(1)
  expect(order).toEqual(['ok'])
  raw.close()
})

test('a source with no active subscription and no federation is not scheduled', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 'lonely') // exists, enabled+allowed, but no subscriber
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })

  expect(await sched.pollDue(NOW)).toBe(0)
  expect(order).toEqual([])
  raw.close()
})

// The poll times below step over the failure backoff deliberately: after 1
// failure the retry interval is 2x60s and after 2 it is 4x60s, so polling at 61s
// (as this test did before backoff existed) would now be a no-op and the counter
// would never reach 2. The subject here is the COUNTER, not the schedule.
test('consecutive failures count up on operational failure and reset on success', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  let outcome: AdminFetchProjection['outcome'] = 'operational_failure'
  const sched = createScheduler({ store, acquisition: stubEngine({ outcomeFor: () => outcome }), config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })

  await sched.pollDue(NOW)
  await sched.pollDue(at(121)) // past 2x60s
  let h = raw.prepare(`SELECT consecutive_failures, last_failure_at, last_success_at FROM source_health_v2 WHERE source_id = 's1'`).get() as { consecutive_failures: number; last_failure_at: string | null; last_success_at: string | null }
  expect(h.consecutive_failures).toBe(2)
  expect(h.last_failure_at).toBe(at(121))
  expect(h.last_success_at).toBeNull()

  outcome = 'parsed'
  await sched.pollDue(at(362))
  h = raw.prepare(`SELECT consecutive_failures, last_success_at FROM source_health_v2 WHERE source_id = 's1'`).get() as { consecutive_failures: number; last_failure_at: string | null; last_success_at: string | null }
  expect(h.consecutive_failures).toBe(0) // reset by success
  expect(h.last_success_at).toBe(at(362))
  raw.close()
})

test('a later pass may start a new run after the earlier run is no longer in flight', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })

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
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, now: () => NOW, drainVerification: async () => { drains++ }, push: undefined, breather: undefined })
  sched.start()
  await turn()
  expect(drains).toBe(1)
  sched.stop()
  raw.close()
})

test('the tick drains verification even when the poll pass polls nothing', async () => {
  const { raw, store } = await fresh() // no schedulable source at all
  let drains = 0
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, now: () => NOW, drainVerification: async () => { drains++ }, push: undefined, breather: undefined })
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
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, now: () => NOW, drainVerification: async () => { drains++ }, push: undefined, breather: undefined })
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
    drainVerification: async () => { throw new Error('verification exploded') }, push: undefined, breather: undefined,
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
// the retired v1 poll-cycle tail, rebuilt over sources.

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
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, drainVerification: undefined, push, breather: undefined })

  expect(await sched.pollDue(NOW)).toBe(1)
  expect(push.registered).toEqual([{ sourceId: 's1', claim: CLAIM }])
  expect(push.passes).toEqual(['renew', 'purge']) // exactly once per pass, in order
  raw.close()
})

test('a failed poll registers nothing, and the sweep still ends the pass', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const push = stubPush({ claim: CLAIM })
  const sched = createScheduler({ store, acquisition: stubEngine({ outcomeFor: () => 'operational_failure' }), config: CONFIG, drainVerification: undefined, push, breather: undefined })

  await sched.pollDue(NOW)
  expect(push.registered).toEqual([])
  expect(push.passes).toEqual(['renew', 'purge'])
  raw.close()
})

test('an active push lease reduces the cadence to 10 × the base interval — durable, no tick state', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  raw.prepare(
    `INSERT INTO push_subscriptions_v2 (id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES ('lease-1', 's1', 'websub', 'https://hub.test/hub', 'https://feed.test/s1', 'tok-1', NULL, 'active', ?, ?)`,
  ).run(at(100000), NOW) // expires far beyond every timestamp this test checks
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })

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
  raw.prepare(
    `INSERT INTO push_subscriptions_v2 (id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES ('lease-1', 's1', 'websub', 'https://hub.test/hub', 'https://feed.test/s1', 'tok-1', NULL, 'pending', ?, ?)`,
  ).run(at(100000), NOW)
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })

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
    acquisition: stubEngine(),
    fetchFn: fetchFn as unknown as typeof fetch, lookupFn: async () => [{ address: '93.184.216.34' }],
  })
  const sched = createScheduler({ store, acquisition: stubEngine(), config: CONFIG, drainVerification: undefined, push, breather: undefined })

  await sched.pollDue(NOW)
  expect(raw.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions_v2`).get()).toEqual({ n: 0 })
  expect(fetchFn).not.toHaveBeenCalled()
  raw.close()
})

// --- the poll-tick breather (HTTP interleave during a burst) -----------------
// Every ~10th tick polls 100+ sources back-to-back; each source's synchronous
// parse+commit+drainSync slice starves the event loop, so SSR / and real clients
// time out for the whole burst. The breather awaits a macrotask yield BETWEEN
// per-source acquisitions (each its own transaction — never mid-transaction), so
// pending HTTP callbacks interleave. It is required-explicit (Breather | undefined,
// mirroring drainVerification): the tick passes a real one, a caller with nothing
// to interleave passes undefined and the pass stays byte-identical.

test('the tick-path breather is awaited between per-source acquisitions; the undefined path never yields', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 'a')
  await seedSubscribed(raw, repo, 'b')
  await seedSubscribed(raw, repo, 'c')
  let breaths = 0
  const breathe = async (): Promise<void> => { breaths++; await new Promise((r) => setImmediate(r)) }
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, drainVerification: undefined, push: undefined, breather: breathe })

  expect(await sched.pollDue(NOW)).toBe(3)
  expect(order).toEqual(['a', 'b', 'c']) // behaviour unchanged by the breather
  expect(breaths).toBeGreaterThanOrEqual(order.length - 1) // breathed between the acquisitions
  const withBreather = breaths

  // The undefined path (a pre-listen / test posture with nothing to interleave):
  // no breather is invoked, the counter never moves, and the pass is byte-identical.
  const b = await fresh()
  await seedSubscribed(b.raw, b.repo, 'x')
  const order2: string[] = []
  const sched2 = createScheduler({ store: b.store, acquisition: stubEngine({ order: order2 }), config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })
  expect(await sched2.pollDue(NOW)).toBe(1)
  expect(order2).toEqual(['x'])
  expect(breaths).toBe(withBreather) // undefined path called the breather zero times

  raw.close(); b.raw.close()
})

test('start/stop/wake are present and stop halts the loop', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  const order: string[] = []
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG, now: () => NOW, drainVerification: undefined, push: undefined, breather: undefined })
  expect(typeof sched.start).toBe('function')
  expect(typeof sched.stop).toBe('function')
  expect(typeof sched.wake).toBe('function')
  sched.stop() // idempotent before start
  raw.close()
})

// --- self-pacing batch size (spec 2026-07-28 §2) -----------------------------

test('self-pacing batch size: a full cycle is spread evenly across ticks regardless of catalog size', async () => {
  const { raw, store, repo } = await fresh()
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await seedSubscribed(raw, repo, id)
  const order: string[] = []
  // ticksPerCycle = ceil(6*60/60) = 6 → batchSize = ceil(6/6) = 1 per tick
  const CONFIG6 = { pollSeconds: 60, ingestCycleMinutes: 6, ingestConcurrency: 8, ingestMaxPerHost: 8 }
  const sched = createScheduler({ store, acquisition: stubEngine({ order }), config: CONFIG6, drainVerification: undefined, push: undefined, breather: undefined })

  for (let i = 0; i < 6; i++) {
    expect(await sched.pollDue(at(i * 60))).toBe(1)
  }
  expect(order).toEqual(['a', 'b', 'c', 'd', 'e', 'f']) // each polled exactly once, oldest-due first
  raw.close()
})

// --- per-host concurrency cap (spec 2026-07-28 §2) ---------------------------

async function seedSubscribedUrl(raw: Raw, repo: { createLocalUser: (u: { handle: string; displayName: string }) => Promise<{ id: string }> }, id: string, url: string): Promise<void> {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, NOW)
  const owner = await repo.createLocalUser({ handle: `owner-${id}`, displayName: id })
  raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`)
    .run(`sub-${id}`, owner.id, id, NOW)
}

test('RSC_INGEST_MAX_PER_HOST caps simultaneous fetches to the same remote host', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribedUrl(raw, repo, 's1', 'https://shared.test/a.xml')
  await seedSubscribedUrl(raw, repo, 's2', 'https://shared.test/b.xml')
  await seedSubscribedUrl(raw, repo, 's3', 'https://other.test/c.xml')

  let concurrentOnSharedHost = 0
  let maxConcurrentOnSharedHost = 0
  const engine: AcquisitionEngine = {
    async acquireSource(sourceId: string) {
      if (sourceId === 's1' || sourceId === 's2') {
        concurrentOnSharedHost++
        maxConcurrentOnSharedHost = Math.max(maxConcurrentOnSharedHost, concurrentOnSharedHost)
        await new Promise((r) => setTimeout(r, 5))
        concurrentOnSharedHost--
      }
      return { runId: `run-${sourceId}`, sourceId, status: 'terminal', outcome: 'parsed' }
    },
    inFlight: () => false,
  }
  const CONFIG_HOST = { pollSeconds: 60, ingestCycleMinutes: 1, ingestConcurrency: 8, ingestMaxPerHost: 1 }
  const sched = createScheduler({ store, acquisition: engine, config: CONFIG_HOST, drainVerification: undefined, push: undefined, breather: undefined })

  expect(await sched.pollDue(NOW)).toBe(3)
  expect(maxConcurrentOnSharedHost).toBe(1) // never more than RSC_INGEST_MAX_PER_HOST on shared.test at once
  raw.close()
})

// --- a throwing acquisition must not orphan the lane (review finding 1) -----
// Without a catch around acquireSource/recordHealth/maybeRegister, a throw
// propagates out of lane() and rejects pollDue's Promise.all — but the OTHER
// lanes keep running (looping over the shared queue) after tick() has already
// caught the rejection and moved on. One bad source must not corrupt the pass.

test('an acquireSource throw does not orphan the lane — pollDue resolves and the other source is still processed', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  await seedSubscribed(raw, repo, 's2')
  const order: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const engine: AcquisitionEngine = {
    async acquireSource(sourceId: string) {
      order.push(sourceId)
      if (sourceId === 's1') throw new Error('boom')
      return { runId: `run-${sourceId}`, sourceId, status: 'terminal', outcome: 'parsed' }
    },
    inFlight: () => false,
  }
  // Single lane so s1 and s2 are necessarily processed by the same lane loop,
  // sequentially — the orphan bug shows up as s2 never being attempted.
  const CONFIG1 = { pollSeconds: 60, ingestCycleMinutes: 1, ingestConcurrency: 1, ingestMaxPerHost: 8 }
  const sched = createScheduler({ store, acquisition: engine, config: CONFIG1, drainVerification: undefined, push: undefined, breather: undefined })

  await expect(sched.pollDue(NOW)).resolves.toBe(1) // s1 threw (uncounted), s2 succeeded
  expect(order).toEqual(['s1', 's2']) // s2 still attempted despite s1's throw
  const h = raw.prepare(`SELECT last_success_at FROM source_health_v2 WHERE source_id = 's2'`).get() as { last_success_at: string } | undefined
  expect(h?.last_success_at).toBe(NOW)
  spy.mockRestore()
  raw.close()
})

// --- a throwing source must still get recordHealth (review finding 3) ------
// listDueSources orders NULLs/oldest last_poll_at first. Without recordHealth
// in the catch, a source whose acquireSource throws never advances its
// last_poll_at, so it stays maximally-overdue and — combined with the
// per-tick LIMIT this task introduced — permanently occupies one of a small
// number of batch slots, starving every other source forever.

test('a throwing source still gets recordHealth — its staleness advances instead of staying permanently head-of-line', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 'a-throws')
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const order: string[] = []
  const engine: AcquisitionEngine = {
    async acquireSource(sourceId: string) {
      order.push(sourceId)
      if (sourceId === 'a-throws') throw new Error('boom')
      return { runId: `run-${sourceId}`, sourceId, status: 'terminal', outcome: 'parsed' }
    },
    inFlight: () => false,
  }
  const sched1 = createScheduler({ store, acquisition: engine, config: CONFIG, drainVerification: undefined, push: undefined, breather: undefined })
  await sched1.pollDue(NOW)

  // The core assertion: without recordHealth in the catch, this stays null
  // forever and 'a-throws' would keep re-winning every future staleness
  // ordering ahead of sources that have never been polled at all.
  expect(store.getHealth('a-throws')?.lastPollAt).toBe(NOW)

  // Seed a source that's genuinely never been polled, then advance past the
  // base interval so 'a-throws' becomes due again too. With a per-tick LIMIT
  // of 1, listDueSources' NULL-first ordering must pick the never-polled
  // source, not re-pick 'a-throws' first ('a-throws' sorts before 'z-never'
  // alphabetically, so a stale/never-advanced tie would wrongly favor it) —
  // proving the throw didn't leave it permanently head-of-line.
  await seedSubscribed(raw, repo, 'z-never')
  const CONFIG2 = { pollSeconds: 60, ingestCycleMinutes: 2, ingestConcurrency: 8, ingestMaxPerHost: 8 }
  const sched2 = createScheduler({ store, acquisition: engine, config: CONFIG2, drainVerification: undefined, push: undefined, breather: undefined })
  order.length = 0
  await sched2.pollDue(at(61))
  expect(order).toEqual(['z-never'])

  spy.mockRestore()
  raw.close()
})

// --- failure backoff (2026-08-18) --------------------------------------------
// consecutive_failures was written by recordHealth and read by NOTHING, so a
// permanently broken feed was retried at full cadence forever: 5670 consecutive
// failures measured on one real subscription on rsc.rmdes.be. Deleting such a
// source is wrong when somebody subscribes to it -- a broken feed may come back
// -- so the poll interval widens instead, doubling per failure to a cap.

function seedHealthFor(raw: Raw, id: string, opts: { lastPollAt: string; failures: number }): void {
  raw.prepare(
    `INSERT INTO source_health_v2 (source_id, last_poll_at, last_success_at, last_failure_at, consecutive_failures) VALUES (?, ?, NULL, ?, ?)`,
  ).run(id, opts.lastPollAt, opts.lastPollAt, opts.failures)
}
const due = (store: ReturnType<typeof createLogicalStore>, at: string) =>
  store.listDueSources({ now: at, pollSeconds: 60, pushPollFactor: 10, limit: 10 }).map((d) => d.id)

test('backoff: a healthy source keeps the plain interval', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  seedHealthFor(raw, 's1', { lastPollAt: NOW, failures: 0 })
  expect(due(store, at(59))).toEqual([])
  expect(due(store, at(61))).toEqual(['s1'])
  raw.close()
})

test('backoff: the interval doubles per consecutive failure', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  seedHealthFor(raw, 's1', { lastPollAt: NOW, failures: 3 }) // 2^3 = 8x -> 480s
  expect(due(store, at(300))).toEqual([])
  expect(due(store, at(481))).toEqual(['s1'])
  raw.close()
})

test('backoff: the interval is capped, so a recovered feed is retried within hours', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  seedHealthFor(raw, 's1', { lastPollAt: NOW, failures: 5670 }) // the real number, capped at 256x
  expect(due(store, at(60 * 256 - 10))).toEqual([])
  expect(due(store, at(60 * 256 + 10))).toEqual(['s1'])
  raw.close()
})

test('backoff: a success resets it — recordHealth zeroes the counter', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  seedHealthFor(raw, 's1', { lastPollAt: NOW, failures: 9 })
  expect(due(store, at(61))).toEqual([]) // still backed off
  store.recordHealth({ sourceId: 's1', outcome: 'parsed', now: at(61) })
  expect(due(store, at(122))).toEqual(['s1']) // plain interval again
  raw.close()
})

test('backoff multiplies the push-lease interval rather than replacing it', async () => {
  const { raw, store, repo } = await fresh()
  await seedSubscribed(raw, repo, 's1')
  seedHealthFor(raw, 's1', { lastPollAt: NOW, failures: 2 }) // 4x, on top of the 10x lease
  raw.prepare(
    `INSERT INTO push_subscriptions_v2 (id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES ('lease-1', 's1', 'websub', 'https://hub.test/hub', 'https://feed.test/s1', 'tok', NULL, 'active', ?, ?)`,
  ).run(at(100000), NOW)
  expect(due(store, at(60 * 10 * 4 - 10))).toEqual([])
  expect(due(store, at(60 * 10 * 4 + 10))).toEqual(['s1'])
  raw.close()
})
