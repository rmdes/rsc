import { test, expect, vi } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import {
  createLogicalRuntime, compose, activateLogicalV2, markReconciliationRequiredIfActive,
} from '../src/logical/runtime.ts'
import type { LogicalRuntime } from '../src/logical/runtime.ts'
import type { AcquisitionEngine } from '../src/logical/acquisition.ts'
import { loadConfig } from '../src/config.ts'

// createLogicalRuntime takes the WHOLE Config (V4 Task 3): it builds the v2 push
// lifecycle, which reads RSC_PUSH_IN + RSC_PUBLIC_URL. No public URL here, so
// pushInEffective is false and the lifecycle is inert in these suites.
const TEST_CONFIG = loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_POLL_SECONDS: '9999' })


const NOW = '2026-07-24T00:00:00.000Z'

// Fresh DB with a stub acquisition engine (no network, nothing schedulable).
async function setup() {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const acquisition: AcquisitionEngine = {
    acquireSource: async () => ({ kind: 'unavailable', reason: 'unscheduled' }),
    inFlight: () => false,
  }
  return { repo, db, store, acquisition }
}

const activation = (store: ReturnType<typeof createLogicalStore>) => store.snapshot((tx) => tx.getActivation())
const meta = (store: ReturnType<typeof createLogicalStore>) => store.snapshot((tx) => tx.getJournalMetadata())
const resetRows = (repo: { raw: import('better-sqlite3').Database }) =>
  repo.raw.prepare(`SELECT sequence FROM logical_journal_v2 WHERE kind = 'reset' ORDER BY sequence`).all() as { sequence: number }[]

function mkRuntime(deps: Awaited<ReturnType<typeof setup>>, order?: string[]): LogicalRuntime {
  return createLogicalRuntime({
    db: deps.db, store: deps.store, acquisition: deps.acquisition,
    config: TEST_CONFIG, now: () => NOW,
    ...(order ? { trace: (p: string) => order.push(p) } : {}),
  })
}

// ---- fail-closed + v1/v2 worker isolation (spec §5.6/§7.4, Appendix D) -------

test('compose fails closed when configured v2 has no runtime', () => {
  expect(() => compose({ sourceModelV2: true, runtime: null })).toThrow('logical-v2 runtime unavailable')
})

test('disabled installs legacy poll + inbound push; enabled installs neither', () => {
  expect(compose({ sourceModelV2: false, runtime: null })).toEqual({ legacyPoll: true, legacyPushIn: true })
  expect(compose({ sourceModelV2: true, runtime: {} as LogicalRuntime })).toEqual({ legacyPoll: false, legacyPushIn: false })
})

// ---- construction order (Appendix D) ----------------------------------------

test('workers are constructed and ready before the ONE pre-listen activation, then listen', async () => {
  const deps = await setup()
  const order: string[] = []
  const runtime = mkRuntime(deps, order)
  await runtime.ready
  // The server accepts traffic (listen) only after activation completes.
  order.push('listen')
  expect(order).toEqual(['journal', 'projector', 'scheduler', 'reconcile', 'orphan', 'activate', 'listen'])
  await runtime.stop()
})

// ---- activation transaction (spec §7.1) -------------------------------------

test('first activation creates generation 1 + one reset and transitions to active', async () => {
  const deps = await setup()
  expect(activation(deps.store).state).toBe('never_activated')
  const runtime = mkRuntime(deps)
  await runtime.ready
  expect(activation(deps.store)).toMatchObject({ state: 'active', lastActivatedAt: NOW })
  expect(meta(deps.store).resetGeneration).toBe(1)
  expect(resetRows(deps.repo).length).toBe(1) // the activation reset
  await runtime.stop()
})

// The runtime-wiring canary for V4's cutover (Task 8): the conversion rides the
// SAME pre-listen `ready` barrier as activation — drop the manifest/cutover
// argument at this call site and the marker below stays null. The cutover's own
// decision table, tripwires and fault injection live in migration-cutover.test.ts.
test('the ready barrier runs the cutover: a legacy source converts and the marker is sealed', async () => {
  const deps = await setup()
  deps.repo.raw.prepare(
    `INSERT INTO users (id, kind, handle, display_name, feed_url, created_at, feed_type) VALUES ('u1','remote','alice','Alice','https://a.test/f.xml',?,'webfeed')`,
  ).run(NOW)

  const runtime = mkRuntime(deps); await runtime.ready; await runtime.stop()

  expect(deps.repo.raw.prepare(`SELECT id, provenance FROM remote_sources_v2`).get()).toEqual({ id: 'u1', provenance: 'migration' })
  expect(deps.repo.raw.prepare(`SELECT converted_at FROM logical_activation_v2 WHERE singleton = 1`).get()).toEqual({ converted_at: NOW })
  expect(activation(deps.store).state).toBe('active')
})

test('reactivation preserves the generation and appends exactly one reset', async () => {
  const deps = await setup()
  const rt1 = mkRuntime(deps); await rt1.ready; await rt1.stop()
  expect(meta(deps.store).resetGeneration).toBe(1)

  // A disabled process marked it (spec §7.1); re-enabling reactivates.
  expect(markReconciliationRequiredIfActive(deps.db)).toBe(true)
  expect(activation(deps.store).state).toBe('reconciliation_required')

  const rt2 = mkRuntime(deps); await rt2.ready; await rt2.stop()
  expect(activation(deps.store)).toMatchObject({ state: 'active', lastReconciledAt: NOW })
  expect(meta(deps.store).resetGeneration).toBe(1) // PRESERVED — no reconstruction
  expect(resetRows(deps.repo).length).toBe(2) // activation reset + reactivation barrier reset
})

test('a continuous-v2 restart seeing active preserves timestamps and appends no reset', async () => {
  const deps = await setup()
  const rt1 = mkRuntime(deps); await rt1.ready; await rt1.stop()
  const gen = meta(deps.store).resetGeneration
  const rows = deps.repo.raw.prepare(`SELECT COUNT(*) AS n FROM logical_journal_v2`).get() as { n: number }

  const rt2 = mkRuntime(deps); await rt2.ready; await rt2.stop()
  expect(activation(deps.store).state).toBe('active')
  expect(meta(deps.store).resetGeneration).toBe(gen)
  expect((deps.repo.raw.prepare(`SELECT COUNT(*) AS n FROM logical_journal_v2`).get() as { n: number }).n).toBe(rows.n)
})

test('the disabled marker is a no-op on a never-activated instance', async () => {
  const deps = await setup()
  expect(markReconciliationRequiredIfActive(deps.db)).toBe(false)
  expect(activation(deps.store).state).toBe('never_activated')
})

// ---- carry-fix: legacy local posts are materialized at activation ------------

test('a legacy local post read-synthesized before v2 gets its bridge row at activation, so its thread resolves', async () => {
  const deps = await setup()
  const repo = deps.repo
  // A pre-existing local post + a local reply to it, both created the v1 way
  // (raw inserts, NO logical bridge row) — the "unmaterialized legacy" state.
  repo.raw.prepare(`INSERT INTO users (id, kind, handle, display_name, created_at) VALUES ('u1','local','alice','Alice',?)`).run(NOW)
  repo.raw.prepare(`INSERT INTO posts (id, author_id, source, guid, content, url, published_at, created_at) VALUES ('p1','u1','local','g1','root','/post/p1',?,?)`).run(NOW, NOW)
  repo.raw.prepare(`INSERT INTO posts (id, author_id, source, guid, content, url, published_at, created_at, in_reply_to_post_id, thread_root_id) VALUES ('p2','u1','local','g2','a reply','/post/p2',?,?,'p1','p1')`).run(NOW, NOW)
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM logical_items_v2`).get()).toMatchObject({ n: 0 })

  const runtime = mkRuntime(deps); await runtime.ready; await runtime.stop()

  // Both posts now have a materialized bridge row (parent-before-child), so
  // projectThread no longer 404s on the legacy root.
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM logical_items_v2`).get()).toMatchObject({ n: 2 })
  const thread = deps.store.snapshot((tx) => tx.projectThread('p1', { localAccountId: null, activeSourceIds: [] }))
  expect(thread).toBeTruthy()
  expect(thread!.nodes.some((node) => node.kind === 'item' && node.item.id === 'p1')).toBe(true)
})

// better-sqlite3 does not cache prepares, so the per-post `SELECT 1 FROM
// logical_items_v2 …` inside materializeLocalChain used to run on EVERY local
// post, on EVERY restart, inside the pre-listen IMMEDIATE write transaction —
// even the continuous-v2 steady state where nothing needs repairing.
// materializePreexistingLocalPosts now pre-filters with an anti-join, so a
// restart with N already-materialized local posts issues that ONE statement
// and calls materializeLocalChain (and its per-post check) zero times.
test('steady-state restart materializes local posts via ONE anti-join statement, not one per local post', async () => {
  const deps = await setup()
  const repo = deps.repo
  repo.raw.prepare(`INSERT INTO users (id, kind, handle, display_name, created_at) VALUES ('u1','local','alice','Alice',?)`).run(NOW)
  let parent: string | null = null
  for (let i = 0; i < 5; i++) {
    const id = `p${i}`
    repo.raw.prepare(
      `INSERT INTO posts (id, author_id, source, guid, content, url, published_at, created_at, in_reply_to_post_id, thread_root_id)
       VALUES (?, 'u1', 'local', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, `g${i}`, `post ${i}`, `/post/${id}`, NOW, NOW, parent, parent ? 'p0' : null)
    parent = id
  }
  activateLogicalV2(deps.db, NOW) // first activation: real work, materializes all 5
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM logical_items_v2`).get()).toMatchObject({ n: 5 })

  const spy = vi.spyOn(repo.raw, 'prepare')
  activateLogicalV2(deps.db, NOW) // continuous-v2 restart — the steady-state path
  const perPostChecks = spy.mock.calls.filter((c) => c[0] === `SELECT 1 FROM logical_items_v2 WHERE id = ?`)
  expect(perPostChecks).toHaveLength(0) // the anti-join already excluded every materialized post
  spy.mockRestore()

  // repair semantics unchanged: an unmaterialized straggler is still picked up
  repo.raw.prepare(`DELETE FROM logical_identity_keys_v2 WHERE logical_item_id = 'p4'`).run()
  repo.raw.prepare(`DELETE FROM logical_local_origins_v2 WHERE post_id = 'p4'`).run()
  repo.raw.prepare(`DELETE FROM logical_items_v2 WHERE id = 'p4'`).run()
  activateLogicalV2(deps.db, NOW)
  expect(repo.raw.prepare(`SELECT COUNT(*) AS n FROM logical_items_v2`).get()).toMatchObject({ n: 5 })
})

// ---- startup drain picks up work a crash may have left (spec §7.2) ----------

test('startup drains pending orphan work left by a crash', async () => {
  const deps = await setup()
  deps.repo.raw.prepare(
    `INSERT INTO orphan_work_v2 (id, alias_kind, alias_key, candidate_high_water, status, created_at) VALUES ('w1','permalink','k1',?,'pending',?)`,
  ).run(NOW, NOW)
  const runtime = mkRuntime(deps); await runtime.ready; await runtime.stop()
  // With no missing candidates the claimed work completes — proving the startup
  // worker pass ran (a crashed nonterminal run is never resumed; this is Task 6's
  // deferred crash recovery landing here).
  expect(deps.repo.raw.prepare(`SELECT status FROM orphan_work_v2 WHERE id = 'w1'`).get()).toMatchObject({ status: 'complete' })
})

// ---- outbound feed push + wake-up hints on v2 local mutations (spec §7.4) ----

test('a v2 local post still fires the outbound-push channel AND a journal wake-up hint', async () => {
  const deps = await setup()
  activateLogicalV2(deps.db, NOW)
  const bus = createEventBus()
  const service = createService(deps.repo, bus, null, deps.store)

  let outboundPush = false
  let hinted = -1
  bus.onNewPost(() => { outboundPush = true }) // the outbound local-feed push channel (retained under v2)
  bus.onSequenceHint((s) => { hinted = s })
  // server.ts wires this exact hook when v2 is on:
  bus.onNewPost(() => { bus.emitSequenceHint(deps.store.snapshot((tx) => tx.getJournalMetadata().highWaterSeq)) })

  await service.createLocalPostAs('alice', 'Alice', 'hello')
  expect(outboundPush).toBe(true)
  expect(hinted).toBeGreaterThan(0)
})
