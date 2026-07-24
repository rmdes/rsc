import { test, expect, vi } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { createLogicalRuntime, createStreamSource, compose } from '../src/logical/runtime.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { fingerprintRequest } from '../src/domain/source-repository.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'
import type { LogicalRuntime } from '../src/logical/runtime.ts'
import type { AcquisitionEngine } from '../src/logical/acquisition.ts'
import type { ProjectionViewer, PublicPublisher, TimelineLens } from '../src/logical/types.ts'
import type { CommandEnvelope, AuditCategory, User } from '../src/domain/types.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'
import { loadConfig } from '../src/config.ts'

// createLogicalRuntime takes the WHOLE Config (V4 Task 3): it builds the v2 push
// lifecycle, which reads RSC_PUSH_IN + RSC_PUBLIC_URL. No public URL here, so
// pushInEffective is false and the lifecycle is inert in these suites.
const TEST_CONFIG = loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_POLL_SECONDS: '9999' })


// The WHOLE-VERTICAL integration proof for logical v3 — moderation, events, and
// verification (spec §10-§11). It exercises the three foundation-mandated
// scenarios end to end across the real modules (schema, acquisition,
// reconciliation, moderation, fan-out, verification, purge/tombstones,
// projection, journal, runtime) that the per-task suites test in isolation, plus
// the cross-model isolation matrix. Rev 2 (TP4): each scenario asserts the
// end-to-end WIRING once; exhaustive per-surface enumeration already lives in
// logical-moderation (hidden surfaces) and logical-purge (tombstones).
//
// One thing it deliberately proves that no per-task suite can: the RUNTIME wires
// the ASYNC drain, and wires it in the right PLACE. Tasks 4-5 built verification
// behind `drainReconciliationAsync` + `createVerificationRunner` and left the
// runtime on the SYNCHRONOUS drain, which can only `deferVerification` — so
// verification never ran in production. Task 10 wired the async drain onto
// startup, which then held `ready` (and every acquisition) on up to 10 s of fetch
// per batch key. Both are regressions, in opposite directions, and the
// runtime-drain-posture block below pins both ends: startup and the acquisition
// result path do NO network I/O, while the BACKGROUND drain
// (`runtime.drainVerification()`, called by the poll tick) still verifies. Every
// one of those tests drives `createLogicalRuntime`'s OWN drain — never a direct
// async-drain call — so a runtime regressed either way fails here.

type Raw = InstanceType<typeof Database>
type Db = ReturnType<typeof createDatabaseContext>
const NOW = '2026-07-24T00:00:00.000Z'
const LATER = '2026-07-24T00:00:01.000Z'
const ADMIN = 'admin-1'
const ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }
// Public IP literal: checkCallbackUrl short-circuits IP-literal hosts before any
// DNS, so the runtime's production-posture verification runner (default lookupFn)
// needs no DNS seam — only the global `fetch` it captures.
const ORIGIN = 'https://93.184.216.34/origin.xml'

const count = (raw: Raw, table: string, where = '', ...args: unknown[]): number =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args) as { n: number }).n

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  return { repo, raw, db, store: createLogicalStore(db) }
}
type Deps = Awaited<ReturnType<typeof fresh>>
type Store = Deps['store']

// --- command envelopes (the route's fingerprint discipline, per Appendix D) ---
const fp = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const env = (commandId: string, requestFingerprint: string): CommandEnvelope =>
  ({ actorScope: 'administrator', actorId: ADMIN, commandId, requestFingerprint })
const hide = (store: Store, id: string, commandId: string, category: AuditCategory = 'spam') =>
  store.hideItem({ command: env(commandId, fp(['hide', id, ADMIN, category])), logicalItemId: id, category, note: null, now: NOW })
const restore = (store: Store, id: string, commandId: string) =>
  store.restoreItem({ command: env(commandId, fp(['restore', id, ADMIN, 'false_positive'])), logicalItemId: id, category: 'false_positive', note: null, now: NOW })
const purge = (store: Store, sourceId: string, commandId: string, category: AuditCategory = 'abuse') =>
  store.purgeSource({ command: env(commandId, fp(['purge', sourceId, ADMIN, category])), sourceId, category, note: null, now: NOW })

// --- seeds -------------------------------------------------------------------
function seedSource(raw: Raw, id: string, url: string, opts: { mode?: string; governance?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, 'enabled', ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, opts.mode ?? 'single_publisher', opts.governance ?? 'allowed', NOW)
}
const seedFederation = (raw: Raw, sourceId: string): void => {
  raw.prepare(`INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'approved', NULL, ?, ?)`).run(sourceId, NOW, NOW)
}
const seedSubscription = (raw: Raw, owner: string, sourceId: string): void => {
  raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`).run(randomUUID(), owner, sourceId, NOW)
}
const setParent = (raw: Raw, child: string, parent: string): void => {
  raw.prepare(`UPDATE logical_items_v2 SET parent_state = 'resolved', parent_logical_item_id = ? WHERE id = ?`).run(parent, child)
}

// --- wire bodies -------------------------------------------------------------
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const ok = (body: string): Response => new Response(body, { status: 200 })
const redirectTo = (to: string): Response => new Response(null, { status: 308, headers: { location: to } })
const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>Peer</title>${items}</channel></rss>`
const linkItem = (guid: string, link: string, body = 'd'): string =>
  `<item><guid isPermaLink="false">${guid}</guid><link>${link}</link><title>t</title><description>${body}</description></item>`
// An aggregate item carrying the per-item origin feed URL (RSS <source url>).
const sourcedItem = (guid: string, sourceUrl: string, body = 'd'): string =>
  `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>${body}</description><source url="${sourceUrl}">Origin Feed</source></item>`

function fakeFetch(map: Record<string, () => Response>): { fn: typeof fetch; callsFor: (u: string) => number } {
  const byUrl: Record<string, number> = {}
  const fn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    byUrl[url] = (byUrl[url] ?? 0) + 1
    const h = map[url]
    if (!h) throw new Error(`no route: ${url}`)
    return h()
  }) as unknown as typeof fetch
  return { fn, callsFor: (u) => byUrl[u] ?? 0 }
}

async function acquire(db: Db, sourceId: string, url: string, body: string): Promise<void> {
  const eng = createAcquisition({ db, fetchFn: fakeFetch({ [url]: () => ok(body) }).fn, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource(sourceId, { kind: 'scheduled' }, undefined)
}
const drain = (store: Store): number => drainReconciliation({ store, now: () => NOW })

// Every scenario drives acquisition itself and asks the runtime only for
// activation + its drain, so the engine is always the inert stub.
const stubEngine: AcquisitionEngine = { acquireSource: async () => ({ kind: 'unavailable', reason: 'unscheduled' }), inFlight: () => false }
const mkRuntime = (deps: Deps, opts: { now?: () => string; notify?: (sequence: number) => void; acquisition?: AcquisitionEngine } = {}): LogicalRuntime =>
  createLogicalRuntime({
    db: deps.db, store: deps.store, acquisition: opts.acquisition ?? stubEngine,
    config: TEST_CONFIG, now: opts.now ?? (() => NOW), notify: opts.notify,
  })

// A real-clock stand-in: every call advances one ms, exactly as production's
// `new Date()` does. It matters wherever a verification job is in play — the sync
// drain defers such a job to now+1 ms, so only a clock that MOVES lets the
// background drain claim it (a frozen clock is the one thing production never has).
const ticking = (from: string) => {
  let t = Date.parse(from)
  return (): string => new Date(t++).toISOString()
}

// --- read helpers ------------------------------------------------------------
const itemByLink = (raw: Raw, link: string): string =>
  (raw.prepare(`SELECT logical_item_id AS id FROM logical_identity_keys_v2 WHERE kind = 'permalink' AND key = ?`).get(link) as { id: string }).id
const remoteIdForSource = (raw: Raw, sourceId: string): string =>
  (raw.prepare(`SELECT ik.logical_item_id AS id FROM logical_identity_keys_v2 ik JOIN deliveries_v2 d ON d.id = ik.key WHERE ik.kind = 'delivery' AND d.source_id = ?`).get(sourceId) as { id: string }).id
const publisherFor = (raw: Raw, url: string): PublicPublisher => {
  const p = raw.prepare(`SELECT id, canonical_feed_url FROM remote_publishers_v2 WHERE canonical_feed_url = ?`).get(url) as { id: string; canonical_feed_url: string }
  return { id: p.id, displayName: 'Peer', canonicalFeedUrl: p.canonical_feed_url, identityLevel: 'feed_anchored' }
}
const lensIds = (store: Store, lens: TimelineLens, viewer: ProjectionViewer = ANON): string[] =>
  store.snapshot((tx) => tx.projectTimeline({ lens, before: null, limit: 50, viewer })).timeline.map((d) => d.id)
// Every stream frame the durable journal replays for `id`, projected under CURRENT policy.
const replayKinds = (db: Db, store: Store, id: string): string[] => {
  const meta = store.snapshot((tx) => tx.getJournalMetadata())
  const batch = createStreamSource(db).batch({ afterSequence: 0, generation: meta.resetGeneration, viewer: ANON, limit: 200 })
  return batch.frames
    .filter((f) => f.control === 'event' && 'logicalItemId' in f.event && f.event.logicalItemId === id)
    .map((f) => (f as { event: { kind: string } }).event.kind)
}

// A full app over the same store — the feed/route surfaces the mandatory
// scenarios name (comments.xml) and the isolation matrix's V3 routes.
function makeApp(deps: Deps, opts: { logical?: boolean } = {}) {
  const on = opts.logical !== false
  return createApp({
    service: createService(deps.repo, createEventBus(), null, on ? deps.store : undefined),
    bus: createEventBus(), token: 'ops-token', auth: makeAuth(deps.repo), users: deps.repo,
    adminEmails: new Set(['boss@x.test']),
    ...(on
      ? {
          sources: { service: createSourceService(deps.repo, null), repo: deps.repo },
          logical: { store: deps.store, acquisition: stubEngine, now: () => NOW },
        }
      : {}),
  })
}

// =============================================================================
// SCENARIO 1 (spec §10) — moderation: hide removes an item from every surface,
// survives every subsequent event, and restore reselects it.
// =============================================================================

test('moderation: an item hidden from an approved aggregate peer leaves every surface, stays hidden through poll/edit/restart/replay, and restore reselects it', async () => {
  const deps = await fresh()
  const { raw, db, store } = deps
  const FEED = 'https://peer.test/f'
  const PARENT = 'https://peer.test/parent'
  const CHILD = 'https://peer.test/child'

  // An APPROVED AGGREGATE PEER: federated, subscribed, allowed.
  seedSource(raw, 's_peer', FEED, { mode: 'aggregate' })
  seedFederation(raw, 's_peer')
  const u1 = await deps.repo.createLocalUser({ handle: 'alice', displayName: 'Alice' }) as User
  seedSubscription(raw, u1.id, 's_peer')
  await acquire(db, 's_peer', FEED, RSS(linkItem('g-parent', PARENT) + linkItem('g-child', CHILD)))
  drain(store)
  const parent = itemByLink(raw, PARENT)
  const child = itemByLink(raw, CHILD)
  setParent(raw, child, parent) // a visible descendant of the item about to be hidden

  const account = { id: u1.id, handle: 'alice', displayName: 'Alice' }
  const viewer: ProjectionViewer = { localAccountId: u1.id, activeSourceIds: [] }
  const pub = publisherFor(raw, FEED)
  const surfaces = () => ({
    public: lensIds(store, { kind: 'public' }).includes(parent),
    personal: lensIds(store, { kind: 'personal', account }, viewer).includes(parent),
    federated: lensIds(store, { kind: 'federated' }).includes(parent),
    profile: lensIds(store, { kind: 'publisher', publisher: pub }).includes(parent),
    item: store.snapshot((tx) => tx.projectItem(parent, ANON)) !== undefined,
    history: store.snapshot((tx) => tx.projectHistory(parent, ANON)) !== undefined,
  })
  const app = makeApp(deps)
  const feedStatus = async (): Promise<number> => (await app.request(`/post/${parent}/comments.xml`)).status

  // baseline: present on every river, the publisher profile, the single-item and
  // history reads, and the item's own feed.
  expect(surfaces()).toEqual({ public: true, personal: true, federated: true, profile: true, item: true, history: true })
  expect(await feedStatus()).toBe(200)
  expect(replayKinds(db, store, parent)).toContain('upsert')

  // --- hide -----------------------------------------------------------------
  expect(hide(store, parent, 'c1')).toMatchObject({ kind: 'applied', hiddenAt: NOW })

  expect(surfaces()).toEqual({ public: false, personal: false, federated: false, profile: false, item: false, history: false })
  expect(await feedStatus()).toBe(404)
  // live/replay state: every historical upsert re-projects to an effective remove.
  expect(replayKinds(db, store, parent).every((k) => k === 'remove')).toBe(true)
  // the thread from the still-visible child keeps the NEUTRAL placeholder — no new kind.
  const thread = store.snapshot((tx) => tx.projectThread(child, ANON))!
  expect(thread.nodes.find((n) => n.kind === 'placeholder' && n.logicalItemId === parent))
    .toMatchObject({ kind: 'placeholder', placeholderKind: 'unavailable' })

  // --- it STAYS hidden through every subsequent event ------------------------
  // poll: the same wire delivered again
  await acquire(db, 's_peer', FEED, RSS(linkItem('g-parent', PARENT) + linkItem('g-child', CHILD)))
  drain(store)
  expect(surfaces().item).toBe(false)
  // edit: a new version of the same delivery with changed material
  await acquire(db, 's_peer', FEED, RSS(linkItem('g-parent', PARENT, 'edited body')))
  drain(store)
  expect(surfaces().item).toBe(false)
  // restart: a fresh runtime over the same database (continuous-v2 restart)
  const rt = mkRuntime(deps); await rt.ready; await rt.stop()
  expect(store.snapshot((tx) => tx.getActivation()).state).toBe('active')
  expect(surfaces()).toEqual({ public: false, personal: false, federated: false, profile: false, item: false, history: false })
  // replay after the restart: still nothing but removes
  expect(replayKinds(db, store, parent).every((k) => k === 'remove')).toBe(true)

  // --- restore → eligible reselection ---------------------------------------
  expect(restore(store, parent, 'c2')).toEqual({ kind: 'applied', logicalItemId: parent, hiddenAt: null })
  expect(surfaces()).toEqual({ public: true, personal: true, federated: true, profile: true, item: true, history: true })
  expect(raw.prepare(`SELECT selected_delivery_id AS d FROM logical_items_v2 WHERE id = ?`).get(parent)).not.toEqual({ d: null })
  expect(await feedStatus()).toBe(200)
  deps.repo.close()
})

// =============================================================================
// RUNTIME DRAIN POSTURE (pre-V4 fix I1) + the runtime-wiring canary.
//
// The binding contract: pre-listen startup and the acquisition result path do NO
// network I/O. Verification's bounded fetch (up to 10 s per batch key, 25 batch
// keys per source) rides the scheduler's BACKGROUND cadence instead —
// `runtime.drainVerification()`, which the poll `tick()` itself calls — so it can
// neither delay `listen` (server.ts awaits `runtime.ready` BEFORE listening) nor
// stall `POST /admin/sources/:id/refresh`.
// =============================================================================

const AGG = 'https://agg.test/f'
// The origin feed contains the same guid → containment holds.
const originFeed = () => fakeFetch({ [ORIGIN]: () => ok(RSS(`<item><guid isPermaLink="false">g1</guid><title>t</title><description>d</description></item>`)) })

// One aggregate claim naming an origin feed URL → one pending verification check
// plus its batch job, which the SYNC drain can only defer. Returns the item id.
async function seedPendingVerification(deps: Deps): Promise<string> {
  seedSource(deps.raw, 's_agg', AGG, { mode: 'aggregate' })
  await acquire(deps.db, 's_agg', AGG, RSS(sourcedItem('g1', ORIGIN)))
  drain(deps.store)
  expect(count(deps.raw, 'verification_checks_v2', "WHERE state = 'pending'")).toBe(1)
  return remoteIdForSource(deps.raw, 's_agg')
}
const checkState = (raw: Raw, item: string): string =>
  (raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = ?`).get(item) as { state: string }).state

test('startup: `ready` completes with NO network I/O, leaving verification to the background cadence', async () => {
  const deps = await fresh()
  const item = await seedPendingVerification(deps)
  // Only the global fetch is stubbed: the runtime builds its own verification
  // runner in production posture (default fetch, no injected DNS lookup).
  const origin = originFeed()
  vi.stubGlobal('fetch', origin.fn)
  try {
    const rt = mkRuntime(deps, { now: ticking(LATER) }) // LATER: past the sync drain's deferral bump
    // Stop the background loop FIRST, so nothing but startup itself can be what
    // this measures. `ready` awaits no I/O, so it has already run to completion.
    await rt.stop()
    await rt.ready
    expect(origin.callsFor(ORIGIN)).toBe(0) // not one byte of network on the startup path
  } finally {
    vi.unstubAllGlobals()
  }
  expect(checkState(deps.raw, item)).toBe('pending')
  expect(deps.store.snapshot((tx) => tx.getActivation()).state).toBe('active') // …and activation still happened
  deps.repo.close()
})

test('acquireSource: a committed acquisition drains synchronously — no verification fetch on the request path', async () => {
  const deps = await fresh()
  // An engine reporting a committed run, so the runtime's wrapper drains after it.
  const engine: AcquisitionEngine = {
    acquireSource: async () => ({ runId: 'r1', sourceId: 's_agg', status: 'terminal', outcome: 'parsed' }),
    inFlight: () => false,
  }
  // The runner captures the global `fetch` when the runtime is CONSTRUCTED, so the
  // stub goes in first; the runtime is then built over a database with no
  // verification work at all, so `ready` cannot be what fetches below.
  const origin = originFeed()
  vi.stubGlobal('fetch', origin.fn)
  let item: string
  try {
    const rt = mkRuntime(deps, { now: ticking(LATER), acquisition: engine })
    await rt.stop()
    await rt.ready
    // Only NOW does verification work exist — so a fetch after this point can only
    // come from the acquisition result path (poll loop / admin refresh await it).
    item = await seedPendingVerification(deps)
    const run = await rt.acquisition.acquireSource('s_agg', { kind: 'scheduled' }, undefined)
    expect(run).toMatchObject({ status: 'terminal' })
    expect(origin.callsFor(ORIGIN)).toBe(0)
  } finally {
    vi.unstubAllGlobals()
  }
  expect(checkState(deps.raw, item)).toBe('pending')
  deps.repo.close()
})

test('the BACKGROUND drain resolves a pending verification and publishes the wake-up hint', async () => {
  const deps = await fresh()
  const item = await seedPendingVerification(deps)
  const origin = originFeed()
  vi.stubGlobal('fetch', origin.fn)
  const hints: number[] = []
  try {
    const rt = mkRuntime(deps, { now: ticking(LATER), notify: (sequence) => hints.push(sequence) })
    await rt.stop()
    await rt.ready
    hints.length = 0 // startup's own hint is not the subject
    await rt.drainVerification() // exactly what the poll tick calls
  } finally {
    vi.unstubAllGlobals()
  }
  expect(origin.callsFor(ORIGIN)).toBe(1)
  expect(checkState(deps.raw, item)).toBe('verified')
  // An open /stream must see verification-driven writes without waiting for an
  // unrelated hint: the background drain publishes the coalesced high-water hint.
  expect(hints.at(-1)).toBe(deps.store.snapshot((tx) => tx.getJournalMetadata().highWaterSeq))
  expect(hints.at(-1)).toBeGreaterThan(0)
  deps.repo.close()
})

// -----------------------------------------------------------------------------
// The RUNTIME-WIRING canary (Step 1's "origin-verify it hidden"). Verification is
// driven ONLY through createLogicalRuntime's own drain — never a direct
// drainReconciliationAsync call: the runtime builds the verification runner itself
// (production posture — default fetch/lookup), so the only seam this test touches
// is the global `fetch` the runner captures. Point `drainVerification` at the
// SYNCHRONOUS drain (which can only `deferVerification`) and the check stays
// `pending`, failing here. The startup assertion inside it is what stops the
// regression being "fixed" by awaiting verification at startup again — the very
// thing the two posture tests above forbid.
// -----------------------------------------------------------------------------

test('moderation: the RUNTIME drain runs origin verification, and a hidden item stays hidden through it', async () => {
  const deps = await fresh()
  const { raw, store } = deps
  const item = await seedPendingVerification(deps)
  expect(hide(store, item, 'c1')).toMatchObject({ kind: 'applied' })

  const origin = originFeed()
  vi.stubGlobal('fetch', origin.fn)
  try {
    const rt = mkRuntime(deps, { now: ticking(LATER) }) // LATER: past the sync drain's deferral bump
    await rt.stop()
    await rt.ready
    expect(origin.callsFor(ORIGIN)).toBe(0) // startup verified NOTHING…
    await rt.drainVerification()            // …the background cadence does
  } finally {
    vi.unstubAllGlobals()
  }

  // The runtime drained the verification job through the async path.
  expect(origin.callsFor(ORIGIN)).toBe(1)
  expect((raw.prepare(`SELECT state FROM verification_checks_v2 WHERE logical_item_id = ?`).get(item) as { state: string }).state).toBe('verified')
  expect((raw.prepare(`SELECT status FROM reconciliation_jobs_v2 WHERE kind = 'verification'`).get() as { status: string }).status).toBe('reconciled')
  expect(count(raw, 'publisher_claims_v2', "WHERE evidence_level = 'verified_origin'")).toBe(1)
  // …and the moderation decision outranks the new evidence: still hidden everywhere.
  expect(store.snapshot((tx) => tx.projectItem(item, ANON))).toBeUndefined()
  expect(lensIds(store, { kind: 'public' })).not.toContain(item)
  deps.repo.close()
})

// -----------------------------------------------------------------------------
// The shared-delivery variant (Step 1): a policy change on ONE of two sources.
// -----------------------------------------------------------------------------

test('moderation: quarantining one approved source leaves Federated while an allowed source keeps the item public, and hint convergence follows via fan-out', async () => {
  const deps = await fresh()
  const { raw, db, store } = deps
  const SHARED = 'https://shared.test/p'
  const admin = await deps.repo.createLocalUser({ handle: 'boss', displayName: 'Boss' })

  // ONE item delivered by an approved federated peer AND an ordinary allowed source.
  seedSource(raw, 's_fed', 'https://fed.test/f')
  seedFederation(raw, 's_fed')
  seedSource(raw, 's_open', 'https://open.test/f')
  await acquire(db, 's_fed', 'https://fed.test/f', RSS(linkItem('g-fed', SHARED)))
  await acquire(db, 's_open', 'https://open.test/f', RSS(linkItem('g-open', SHARED)))
  drain(store)
  const item = itemByLink(raw, SHARED)
  expect(count(raw, 'logical_items_v2', "WHERE origin = 'remote'")).toBe(1) // converged
  expect(lensIds(store, { kind: 'federated' })).toContain(item)
  expect(lensIds(store, { kind: 'public' })).toContain(item)

  // Quarantine the federated peer: generation advances and fan-out is enqueued in
  // the SAME transaction; item hints are still stale at this point.
  await deps.repo.transition({
    command: { actorScope: 'administrator', actorId: admin.id, commandId: 'q1', requestFingerprint: fingerprintRequest(['q', 's_fed']) },
    sourceId: 's_fed', action: 'quarantine', category: 'spam', note: null, actorKind: 'administrator', now: NOW,
  })
  expect(raw.prepare(`SELECT state FROM policy_fanout_v2 WHERE source_id = 's_fed'`).get()).toEqual({ state: 'pending' })

  drain(store) // the ONE drain processes fan-out

  // It LEFT Federated (no approved+allowed delivery) but stayed public via s_open…
  expect(lensIds(store, { kind: 'federated' })).not.toContain(item)
  expect(lensIds(store, { kind: 'public' })).toContain(item)
  // …reselecting onto the still-eligible delivery…
  const sel = raw.prepare(`SELECT selected_delivery_id AS d FROM logical_items_v2 WHERE id = ?`).get(item) as { d: string }
  expect((raw.prepare(`SELECT source_id FROM deliveries_v2 WHERE id = ?`).get(sel.d) as { source_id: string }).source_id).toBe('s_open')
  // …and the fan-out row reached its terminal state (hint convergence completed).
  expect(raw.prepare(`SELECT state FROM policy_fanout_v2 WHERE source_id = 's_fed'`).get()).toEqual({ state: 'done' })
  deps.repo.close()
})

// =============================================================================
// SCENARIO 2 (spec §10) — purge: terminal removal, survival of other evidence,
// structural tombstones, oracle-free resolution, and restart durability.
// =============================================================================

test('purge: a blocked source sharing items with another source and a local item — survivors survive, unsupported items delete, ancestors become structural tombstones across restart', async () => {
  const deps = await fresh()
  const { raw, db, store } = deps
  const BAD = 'https://bad.test/f'
  const OK = 'https://ok.test/f'
  const SHARED = 'https://shared.test/p'
  const ROOT = 'https://bad.test/root'
  const LONE = 'https://bad.test/lone'

  // A local post the blocked source also echoes (local origin must win + survive).
  const author = await deps.repo.createLocalUser({ handle: 'alice', displayName: 'Alice' }) as User
  const local = store.createLocalPost({ author, content: 'my local note', replyToId: null, now: NOW })
  const ECHO = 'https://blog.test/echo'
  raw.prepare(`INSERT OR IGNORE INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('permalink', ?, ?)`).run(ECHO, local.id)

  seedSource(raw, 's_bad', BAD)
  seedSource(raw, 's_ok', OK)
  raw.prepare(`INSERT INTO source_aliases_v2 (url, source_id, created_at) VALUES (?, 's_bad', ?)`).run('https://bad.test/alias', NOW)
  // s_bad delivers: the shared item, the future tombstone root, a lone item, and the local echo.
  await acquire(db, 's_bad', BAD, RSS(linkItem('b1', SHARED) + linkItem('b2', ROOT) + linkItem('b3', LONE) + linkItem('b4', ECHO)))
  // s_ok delivers: the same shared item, and a reply that will hang off ROOT.
  await acquire(db, 's_ok', OK, RSS(linkItem('o1', SHARED) + linkItem('o2', 'https://ok.test/reply')))
  drain(store)

  const shared = itemByLink(raw, SHARED)
  const root = itemByLink(raw, ROOT)
  const lone = itemByLink(raw, LONE)
  const reply = itemByLink(raw, 'https://ok.test/reply')
  setParent(raw, reply, root)
  expect(count(raw, 'logical_identity_keys_v2', "WHERE kind = 'delivery' AND logical_item_id = ?", shared)).toBe(2)
  expect(count(raw, 'logical_items_v2', 'WHERE id = ? AND origin = ?', local.id, 'local')).toBe(1) // echo never forked the local item

  raw.prepare(`UPDATE remote_sources_v2 SET governance = 'blocked' WHERE id = 's_bad'`).run()
  // Activate first, so the later restart is a continuous-v2 restart (which must
  // append NO further reset) rather than a first activation.
  const rt0 = mkRuntime(deps); await rt0.ready; await rt0.stop()
  const resetsBefore = count(raw, 'logical_journal_v2', "WHERE kind = 'reset'")

  const res = purge(store, 's_bad', 'p1')
  expect(res.kind).toBe('purged')
  const tombstoneId = (res as { tombstoneId: string }).tombstoneId

  // survivors: the local origin, and the shared item via s_ok's still-eligible delivery
  expect(store.snapshot((tx) => tx.projectItem(local.id, ANON))).toBeDefined()
  expect(store.snapshot((tx) => tx.projectItem(shared, ANON))).toBeDefined()
  const sel = raw.prepare(`SELECT selected_delivery_id AS d FROM logical_items_v2 WHERE id = ?`).get(shared) as { d: string }
  expect((raw.prepare(`SELECT source_id FROM deliveries_v2 WHERE id = ?`).get(sel.d) as { source_id: string }).source_id).toBe('s_ok')
  // unsupported: deleted outright
  expect(count(raw, 'logical_items_v2', 'WHERE id = ?', lone)).toBe(0)
  // ancestor of a visible descendant: structural tombstone, edge preserved
  const edges = () => raw.prepare(`SELECT structural_tombstone AS t, parent_logical_item_id AS p FROM logical_items_v2 WHERE id = ?`).get(root) as { t: number; p: string | null }
  const replyEdge = () => (raw.prepare(`SELECT parent_logical_item_id AS p FROM logical_items_v2 WHERE id = ?`).get(reply) as { p: string }).p
  expect(edges().t).toBe(1)
  expect(replyEdge()).toBe(root)
  expect(store.snapshot((tx) => tx.projectItem(root, ANON))).toBeUndefined()
  const thread = store.snapshot((tx) => tx.projectThread(reply, ANON))!
  expect(thread.nodes.find((n) => (n.kind === 'placeholder' ? n.logicalItemId : n.item.id) === root))
    .toMatchObject({ kind: 'placeholder', placeholderKind: 'unavailable' })
  // terminal audit facts + exactly one reset barrier
  const tomb = raw.prepare(`SELECT canonical_url, action, category, actor_id FROM blocked_source_tombstones_v2 WHERE id = ?`).get(tombstoneId)
  expect(tomb).toMatchObject({ canonical_url: BAD, action: 'purge', category: 'abuse', actor_id: ADMIN })
  expect(count(raw, 'tombstone_aliases_v2', 'WHERE tombstone_id = ?', tombstoneId)).toBe(1)
  expect(count(raw, 'logical_journal_v2', "WHERE kind = 'reset'")).toBe(resetsBefore + 1)

  // --- everything above survives a restart ---------------------------------
  const rt = mkRuntime(deps); await rt.ready; await rt.stop()
  expect(edges()).toEqual({ t: 1, p: null })         // exact thread edges preserved
  expect(replyEdge()).toBe(root)
  expect(store.snapshot((tx) => tx.projectItem(root, ANON))).toBeUndefined()
  expect(store.snapshot((tx) => tx.projectItem(shared, ANON))).toBeDefined()
  expect(count(raw, 'blocked_source_tombstones_v2', 'WHERE id = ?', tombstoneId)).toBe(1)
  expect(count(raw, 'tombstone_aliases_v2', 'WHERE tombstone_id = ?', tombstoneId)).toBe(1)
  expect(count(raw, 'logical_journal_v2', "WHERE kind = 'reset'")).toBe(resetsBefore + 1) // no second barrier
  deps.repo.close()
})

test('purge: the tombstone URL and its aliases block direct subscription AND every redirect hop', async () => {
  const deps = await fresh()
  const { raw, db, store } = deps
  const BAD = 'https://bad.test/f'
  const ALIAS = 'https://bad.test/alias'
  seedSource(raw, 's_bad', BAD)
  raw.prepare(`INSERT INTO source_aliases_v2 (url, source_id, created_at) VALUES (?, 's_bad', ?)`).run(ALIAS, NOW)
  raw.prepare(`UPDATE remote_sources_v2 SET governance = 'blocked' WHERE id = 's_bad'`).run()
  expect(purge(store, 's_bad', 'p1').kind).toBe('purged')

  // direct subscription: byte-identical to the ordinary unavailable result, for
  // the canonical URL and for every alias — the caller gets no oracle.
  const service = createSourceService(deps.repo, 'https://cast.example', publicLookup, store.isTombstoned)
  const owner = await deps.repo.createLocalUser({ handle: 'owner', displayName: 'Owner' }) as User
  expect(await service.subscribeByUrl(owner, BAD, 'sub-1')).toEqual({ kind: 'unavailable' })
  expect(await service.subscribeByUrl(owner, ALIAS, 'sub-2')).toEqual({ kind: 'unavailable' })
  expect(count(raw, 'remote_sources_v2')).toBe(0)

  // redirect hops: an acquisition landing on the canonical URL or on an alias is
  // rejected before the fetch.
  for (const [i, hop] of [BAD, ALIAS].entries()) {
    const src = `s_hop${i}`
    seedSource(raw, src, `https://hop${i}.test/f`)
    const net = fakeFetch({ [`https://hop${i}.test/f`]: () => redirectTo(hop) })
    const eng = createAcquisition({ db, fetchFn: net.fn, lookupFn: publicLookup, now: () => NOW })
    const run = await eng.acquireSource(src, { kind: 'scheduled' }, undefined) as { outcome: string }
    expect(net.callsFor(hop)).toBe(0) // never fetched
    expect(run.outcome).toBe('operational_failure')
  }
  expect(count(raw, 'deliveries_v2')).toBe(0)
  deps.repo.close()
})

test('purge: the structural-tombstone assertions repeat through last-subscription cleanup', async () => {
  const deps = await fresh()
  const { raw, db, store } = deps
  const GONE = 'https://gone.test/f'
  const ROOT = 'https://gone.test/root'

  seedSource(raw, 's_gone', GONE)
  seedSource(raw, 's_keep', 'https://keep.test/f')
  const owner = await deps.repo.createLocalUser({ handle: 'owner', displayName: 'Owner' }) as User
  seedSubscription(raw, owner.id, 's_gone')
  await acquire(db, 's_gone', GONE, RSS(linkItem('g1', ROOT)))
  await acquire(db, 's_keep', 'https://keep.test/f', RSS(linkItem('k1', 'https://keep.test/reply')))
  drain(store)
  const root = itemByLink(raw, ROOT)
  const reply = itemByLink(raw, 'https://keep.test/reply')
  setParent(raw, reply, root)

  // Cleanup is NOT a moderation action: the last unsubscribe removes the source
  // and its evidence, but the descendant-referenced ancestor still tombstones.
  const service = createSourceService(deps.repo, 'https://cast.example', publicLookup, store.isTombstoned)
  expect(await service.unsubscribe(owner.id, 's_gone', 'unsub-1')).toEqual({ kind: 'removed', sourceRemoved: true })

  expect(count(raw, 'blocked_source_tombstones_v2')).toBe(0) // no moderation tombstone
  const rootRow = raw.prepare(`SELECT structural_tombstone AS t, selected_delivery_id AS d, timeline_sort_at AS s FROM logical_items_v2 WHERE id = ?`).get(root) as { t: number; d: string | null; s: string }
  expect(rootRow).toMatchObject({ t: 1, d: null })
  expect(rootRow.s).toBeTruthy() // the immutable sort key is retained
  expect((raw.prepare(`SELECT parent_logical_item_id AS p FROM logical_items_v2 WHERE id = ?`).get(reply) as { p: string }).p).toBe(root)
  expect(store.snapshot((tx) => tx.projectItem(root, ANON))).toBeUndefined()
  const thread = store.snapshot((tx) => tx.projectThread(reply, ANON))!
  expect(thread.nodes.find((n) => (n.kind === 'placeholder' ? n.logicalItemId : n.item.id) === root))
    .toMatchObject({ kind: 'placeholder', placeholderKind: 'unavailable' })
  deps.repo.close()
})

// =============================================================================
// SCENARIO 3 (spec §11) — cross-model isolation.
// =============================================================================

const V3_ROUTES = [
  '/admin/items/li-1/hide',
  '/admin/items/li-1/restore',
  '/admin/sources/s1/purge',
  '/admin/tombstones/t1/unblock',
]
const postJson = (cookie: string, body: unknown) =>
  ({ method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })

test('isolation OFF: no V3 route exists, no fan-out or verification work is ever scheduled, and legacy moderation + legacy push are unchanged', async () => {
  const deps = await fresh()
  const { raw } = deps
  const app = makeApp(deps, { logical: false }) // exactly the flag-off composition
  // An ADMIN session, so a 404 can only mean the route is absent — the /admin/*
  // gate would answer 401 first if we asked anonymously.
  const cookie = await registeredSession(app, 'boss@x.test', deps.repo)

  // (1) not one V3 route is registered — a plain routing 404, never the V3 body.
  for (const path of V3_ROUTES) {
    const res = await app.request(path, postJson(cookie, { commandId: 'c1', category: 'spam' }))
    expect([path, res.status]).toEqual([path, 404])
    expect(await res.text()).not.toContain('logical-v2')
  }
  expect(await (await app.request('/capabilities')).json()).toEqual({ sourceModelV2: false })

  // (2) legacy moderation over the v1 service: a local post created and removed
  // the v1 way writes NOTHING into any v2 table (V2's off-flag regression fixture,
  // extended to the V3 families).
  const service = createService(deps.repo, createEventBus(), null) // no logical store — the OFF path
  const entry = await service.createLocalPostAs('bob', 'Bob', 'hello from v1')
  expect(await service.deletePost(entry.id)).toEqual({ ok: true })
  for (const t of ['logical_items_v2', 'logical_journal_v2', 'item_audit_v2', 'blocked_source_tombstones_v2', 'tombstone_aliases_v2']) {
    expect([t, count(raw, t)]).toEqual([t, 0])
  }
  // (3) no fan-out and no verification work is ever scheduled while off.
  expect(count(raw, 'policy_fanout_v2')).toBe(0)
  expect(count(raw, 'verification_checks_v2')).toBe(0)
  expect(count(raw, 'reconciliation_jobs_v2', "WHERE kind = 'verification'")).toBe(0)

  // (4) legacy push: both legacy workers still start, exactly as before V3.
  expect(compose({ sourceModelV2: false, runtime: null })).toEqual({ legacyPoll: true, legacyPushIn: true })
  deps.repo.close()
})

test('isolation ON: the capability payload is EXACTLY V2\'s enabled shape — V3 adds no field', async () => {
  const deps = await fresh()
  const app = makeApp(deps)
  // Exact equality, not a subset: V3 ships no capability field and leaves the
  // ordinary contract (model + the two frozen versions) untouched.
  expect(await (await app.request('/capabilities')).json())
    .toEqual({ sourceModelV2: true, model: 'logical-v2', journalCursorVersion: 1, streamProtocolVersion: 1 })
  // …and with the flag on, neither legacy worker is installed (unchanged by V3).
  expect(compose({ sourceModelV2: true, runtime: {} as LogicalRuntime })).toEqual({ legacyPoll: false, legacyPushIn: false })
  deps.repo.close()
})
