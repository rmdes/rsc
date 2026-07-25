import { test, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createScheduler } from '../src/logical/scheduler.ts'
import { createApp } from '../src/api/app.ts'
import { encodeCursor } from '../src/domain/cursor.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'
import type { AcquisitionEngine } from '../src/logical/acquisition.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

type Raw = InstanceType<typeof Database>
const OPS_TOKEN = 'ops-token-DEADBEEF'
const NOW = '2026-07-23T00:00:00.000Z'

function ok(body: string): Response { return new Response(body, { status: 200 }) }
function notModified(): Response { return new Response(null, { status: 304 }) }
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`
const item = (guid: string): string => `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>d</description></item>`

function seedSource(raw: Raw, id: string, url: string, opts: { operation?: string; governance?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', ?, ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, opts.operation ?? 'enabled', opts.governance ?? 'allowed', NOW)
}

async function makeApp(fetchMap: Record<string, () => Response | Promise<Response>> = {}, refreshWaitMs = 80) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus, null)
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const h = fetchMap[url]
    if (!h) throw new Error(`no route: ${url}`)
    return await h()
  }) as unknown as typeof fetch
  const acquisition = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  const app = createApp({
    service, bus, token: OPS_TOKEN, auth: makeAuth(repo), users: repo,
    adminEmails: new Set(['boss@x.test']),
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition, refreshWaitMs, now: () => NOW },
  })
  return { app, repo, store, acquisition }
}

const post = (headers: Record<string, string>, body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const refresh = (headers: Record<string, string>, sourceId: string, commandId: string) =>
  ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ commandId }) })

// --- refresh: disposition, 200/202, neutral 404, 409 conflict ---

test('a fresh refresh creates a run; a job-bearing run answers 202, a zero-job run 200', async () => {
  const { app, repo } = await makeApp({ 'https://feed.test/a': () => ok(RSS(item('g1'))), 'https://feed.test/empty': () => ok(RSS('')) })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(repo.raw, 's1', 'https://feed.test/a')
  seedSource(repo.raw, 's2', 'https://feed.test/empty')

  const created = await app.request('/admin/sources/s1/refresh', refresh({ cookie }, 's1', 'c1'))
  expect(created.status).toBe(202) // one observation ⇒ a pending job ⇒ not terminal
  const body = await created.json()
  expect(body).toMatchObject({ model: 'logical-v2', disposition: 'created', status: 'processing', sourceId: 's1' })
  expect(body.statusLocation).toBe(`/admin/acquisition-runs/${body.runId}`)
  expect(body.acquisition.observed).toBe(1)
  expect(body.reconciliation.pending).toBe(1)

  const zero = await app.request('/admin/sources/s2/refresh', refresh({ cookie }, 's2', 'z1'))
  expect(zero.status).toBe(200) // zero jobs ⇒ immediately terminal
  expect(await zero.json()).toMatchObject({ model: 'logical-v2', disposition: 'created', status: 'terminal', sourceId: 's2' })
  repo.close()
})

test('replaying a matching command returns the same run with disposition replayed', async () => {
  const { app, repo } = await makeApp({ 'https://feed.test/a': () => ok(RSS(item('g1'))) })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(repo.raw, 's1', 'https://feed.test/a')

  const first = await (await app.request('/admin/sources/s1/refresh', refresh({ cookie }, 's1', 'c1'))).json()
  const replay = await app.request('/admin/sources/s1/refresh', refresh({ cookie }, 's1', 'c1'))
  const replayBody = await replay.json()
  expect(replayBody.disposition).toBe('replayed')
  expect(replayBody.runId).toBe(first.runId)
  expect(replayBody.model).toBe('logical-v2')
  // exactly one run row exists — the replay fetched nothing
  expect((repo.raw.prepare(`SELECT COUNT(*) AS n FROM acquisition_runs_v2`).get() as { n: number }).n).toBe(1)
  repo.close()
})

test('a command against a paused/blocked/unknown source is ledgered and returns the neutral 404, even on replay after the state changes', async () => {
  const { app, repo } = await makeApp({ 'https://feed.test/p': () => ok(RSS(item('g1'))) })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(repo.raw, 'paused', 'https://feed.test/p', { operation: 'paused' })

  const refused = await app.request('/admin/sources/paused/refresh', refresh({ cookie }, 'paused', 'p1'))
  expect(refused.status).toBe(404)
  expect(await refused.json()).toEqual({ model: 'logical-v2', error: 'source unavailable' })

  // unpause; the replay STILL returns the ledgered refusal (spec §6.2)
  repo.raw.prepare(`UPDATE remote_sources_v2 SET operation = 'enabled' WHERE id = 'paused'`).run()
  const replay = await app.request('/admin/sources/paused/refresh', refresh({ cookie }, 'paused', 'p1'))
  expect(replay.status).toBe(404)
  expect(await replay.json()).toEqual({ model: 'logical-v2', error: 'source unavailable' })

  const unknown = await app.request('/admin/sources/nope/refresh', refresh({ cookie }, 'nope', 'u1'))
  expect(unknown.status).toBe(404)
  expect(await unknown.json()).toEqual({ model: 'logical-v2', error: 'source unavailable' })
  repo.close()
})

test('a reused command id with a mismatched fingerprint (different source) is a 409 idempotency conflict', async () => {
  const { app, repo } = await makeApp({ 'https://feed.test/a': () => ok(RSS(item('g1'))), 'https://feed.test/b': () => ok(RSS(item('g2'))) })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(repo.raw, 's1', 'https://feed.test/a')
  seedSource(repo.raw, 's2', 'https://feed.test/b')

  const first = await app.request('/admin/sources/s1/refresh', refresh({ cookie }, 's1', 'c1'))
  expect(first.status).toBe(202)
  // same commandId c1, different source ⇒ fingerprint [command, sourceId, actor] mismatch
  const conflict = await app.request('/admin/sources/s2/refresh', refresh({ cookie }, 's2', 'c1'))
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({ model: 'logical-v2', error: 'idempotency conflict' })
  // no run for s2 was started
  expect((repo.raw.prepare(`SELECT COUNT(*) AS n FROM acquisition_runs_v2 WHERE source_id = 's2'`).get() as { n: number }).n).toBe(0)
  repo.close()
})

test('a command arriving while a run is in flight joins it (no second fetch) and answers disposition joined', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const { app, repo, acquisition } = await makeApp({ 'https://feed.test/a': async () => { await gate; return ok(RSS(item('g1'))) } }, 40)
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(repo.raw, 's1', 'https://feed.test/a')

  // Start a scheduled acquisition that hangs in fetch, holding the source in flight.
  const bg = acquisition.acquireSource('s1', { kind: 'scheduled' })
  for (let i = 0; i < 100 && !acquisition.inFlight('s1'); i++) await new Promise((r) => setTimeout(r, 5))
  expect(acquisition.inFlight('s1')).toBe(true)

  const joined = await app.request('/admin/sources/s1/refresh', refresh({ cookie }, 's1', 'j1'))
  expect(joined.status).toBe(202) // the active run is still processing
  expect((await joined.json()).disposition).toBe('joined')
  // exactly one run exists — the command joined rather than starting a second fetch
  expect((repo.raw.prepare(`SELECT COUNT(*) AS n FROM acquisition_runs_v2`).get() as { n: number }).n).toBe(1)

  release()
  await bg
  repo.close()
})

test('a manual refresh records durable health so the scheduler skips the source on its next tick', async () => {
  const { app, repo, store } = await makeApp({ 'https://feed.test/a': () => ok(RSS(item('g1'))) })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(repo.raw, 's1', 'https://feed.test/a')
  const owner = await repo.createLocalUser({ handle: 'owner-s1', displayName: 's1' })
  repo.raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`)
    .run('sub-s1', owner.id, 's1', NOW)

  expect(store.getHealth('s1')).toBeUndefined()

  const created = await (await app.request('/admin/sources/s1/refresh', refresh({ cookie }, 's1', 'c1'))).json()
  expect(created.disposition).toBe('created')
  // the manual poll updates the SAME durable health the scheduler reads (spec §1.3)
  expect(store.getHealth('s1')?.lastPollAt).toBe(NOW)

  // a scheduler tick immediately after must SKIP this source (skip-if-recent now
  // counts the manual poll) — a throwing stub proves it: if health wasn't recorded,
  // pollDue would call acquireSource and this test would fail with the thrown error.
  const throwingEngine: AcquisitionEngine = {
    acquireSource: async () => { throw new Error('scheduler should have skipped s1 — manual refresh health was not recorded') },
    inFlight: () => false,
  }
  const sched = createScheduler({ store, acquisition: throwingEngine, config: { pollSeconds: 60 }, drainVerification: undefined, push: undefined, breather: undefined })
  expect(await sched.pollDue(NOW)).toBe(0)
  repo.close()
})

test('the commandId travels only in the JSON body; a missing/invalid body is a 400', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(repo.raw, 's1', 'https://feed.test/a')
  expect((await app.request('/admin/sources/s1/refresh', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })).status).toBe(400)
  expect((await app.request('/admin/sources/s1/refresh', { method: 'POST', headers: { cookie } })).status).toBe(400)
  repo.close()
})

// --- run / history / jobs reads + pagination ---

test('GET run status, source run history, and jobs project the pinned shapes with no push-capability field', async () => {
  const { app, repo } = await makeApp({ 'https://feed.test/a': () => ok(RSS(item('g1'))) })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(repo.raw, 's1', 'https://feed.test/a')
  const created = await (await app.request('/admin/sources/s1/refresh', refresh({ cookie }, 's1', 'c1'))).json()

  const run = await app.request(`/admin/acquisition-runs/${created.runId}`, { headers: { cookie } })
  expect(run.status).toBe(200)
  const runJson = await run.json()
  expect(runJson).toMatchObject({ model: 'logical-v2', runId: created.runId, sourceId: 's1', reason: 'administrator_refresh' })
  expect(Object.keys(runJson.acquisition).sort()).toEqual(['bodyLimitExceeded', 'candidates', 'itemsTruncated', 'notModified', 'observed', 'omitted', 'seen', 'skipped', 'unchanged'])
  expect(Object.keys(runJson.reconciliation).sort()).toEqual(['conflicted', 'failed', 'failedByCategory', 'pending', 'processing', 'reconciled', 'retrying'])
  expect(Object.keys(runJson.versions).sort()).toEqual(['boundsProfileVersion', 'fingerprintVersion', 'identifierNormalizationVersion', 'parserAdapter', 'parserVersion'])
  expect(JSON.stringify(runJson)).not.toMatch(/push[_C]apability|push_capability/i)

  expect((await app.request(`/admin/acquisition-runs/${randomUUID()}`, { headers: { cookie } })).status).toBe(404)

  const runs = await (await app.request('/admin/sources/s1/runs', { headers: { cookie } })).json()
  expect(runs.model).toBe('logical-v2')
  expect(runs.items).toHaveLength(1)
  expect(runs.items[0].runId).toBe(created.runId)
  expect(runs.items[0].reason).toBeUndefined() // AdminRunProjection has no reason/versions

  const jobs = await (await app.request(`/admin/acquisition-runs/${created.runId}/jobs`, { headers: { cookie } })).json()
  expect(jobs.model).toBe('logical-v2')
  expect(jobs.items).toHaveLength(1)
  expect(jobs.items[0].status).toBe('pending')
  expect(Object.keys(jobs.items[0]).sort()).toEqual(['attempts', 'createdAt', 'diagnostic', 'failureCategory', 'jobId', 'nextAttemptAt', 'status'])
  repo.close()
})

test('source run history paginates through the shared opaque cursor', async () => {
  const { app, repo } = await makeApp({ 'https://feed.test/a': () => notModified() })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(repo.raw, 's1', 'https://feed.test/a')
  // three zero-job runs with distinct started_at so the (startedAt,runId) cursor is total
  for (const [i, cmd] of [['1', 'c1'], ['2', 'c2'], ['3', 'c3']] as const) {
    await app.request('/admin/sources/s1/refresh', refresh({ cookie }, 's1', cmd))
    repo.raw.prepare(`UPDATE acquisition_runs_v2 SET started_at = ? WHERE started_at = ?`).run(`2026-07-23T00:0${i}:00.000Z`, NOW)
  }
  const page1 = await (await app.request('/admin/sources/s1/runs?limit=2', { headers: { cookie } })).json()
  expect(page1.items).toHaveLength(2)
  expect(page1.nextCursor).toEqual(expect.any(String))
  const page2 = await (await app.request(`/admin/sources/s1/runs?limit=2&before=${encodeURIComponent(page1.nextCursor)}`, { headers: { cookie } })).json()
  expect(page2.items).toHaveLength(1)
  expect(page2.nextCursor).toBeNull()
  const ids = [...page1.items, ...page2.items].map((r: { runId: string }) => r.runId)
  expect(new Set(ids).size).toBe(3) // no overlap across pages
  repo.close()
})

// The shared invalid-cursor test table (VP7): every entry 400s with the neutral body.
const INVALID_CURSORS = ['', '@@bogus@@', 'not-base64!!', encodeCursor(1, ['only-one']), Buffer.from(JSON.stringify([2, 'a', 'b'])).toString('base64url')]

test('every invalid pagination cursor returns 400 {model,error:invalid cursor} on both paged routes', async () => {
  const { app, repo } = await makeApp({ 'https://feed.test/a': () => notModified() })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(repo.raw, 's1', 'https://feed.test/a')
  const created = await (await app.request('/admin/sources/s1/refresh', refresh({ cookie }, 's1', 'c1'))).json()
  for (const bad of INVALID_CURSORS) {
    const q = `before=${encodeURIComponent(bad)}`
    const runs = await app.request(`/admin/sources/s1/runs?${q}`, { headers: { cookie } })
    expect([bad, runs.status]).toEqual([bad, 400])
    expect(await runs.json()).toEqual({ model: 'logical-v2', error: 'invalid cursor' })
    const jobs = await app.request(`/admin/acquisition-runs/${created.runId}/jobs?${q}`, { headers: { cookie } })
    expect([bad, jobs.status]).toEqual([bad, 400])
    expect(await jobs.json()).toEqual({ model: 'logical-v2', error: 'invalid cursor' })
  }
  repo.close()
})

// --- authorization matrix + secret redaction ---

test('every logical admin route answers [401,403,403,200,401,401] for [none,anon,registered,admin,valid token,invalid token]', async () => {
  const { app, repo } = await makeApp({ 'https://feed.test/a': () => notModified() })
  const adminCookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(repo.raw, 's1', 'https://feed.test/a')
  const created = await (await app.request('/admin/sources/s1/refresh', refresh({ cookie: adminCookie }, 's1', 'seed'))).json()

  const actors: Array<[string, Record<string, string>]> = [
    ['none', {}],
    ['anon', { cookie: await anonSession(app) }],
    ['registered', { cookie: await registeredSession(app, 'peon@x.test', repo) }],
    ['admin', { cookie: adminCookie }],
    ['validToken', { authorization: `Bearer ${OPS_TOKEN}` }],
    ['invalidToken', { authorization: 'Bearer nope' }],
  ]
  const routes: Record<string, (h: Record<string, string>, actor: string) => Response | Promise<Response>> = {
    refresh: (h, actor) => app.request('/admin/sources/s1/refresh', refresh(h, 's1', `m-${actor}`)),
    run: (h) => app.request(`/admin/acquisition-runs/${created.runId}`, { headers: h }),
    runs: (h) => app.request('/admin/sources/s1/runs', { headers: h }),
    jobs: (h) => app.request(`/admin/acquisition-runs/${created.runId}/jobs`, { headers: h }),
  }
  const expected = [401, 403, 403, 200, 401, 401]
  for (const [name, run] of Object.entries(routes)) {
    const statuses: number[] = []
    for (const [actor, h] of actors) statuses.push((await run(h, actor)).status)
    // refresh's admin cell is 200 or 202 (both "authorized"); normalize 202→200 for the matrix
    expect([name, statuses.map((s) => (s === 202 ? 200 : s))]).toEqual([name, expected])
  }
  repo.close()
})

test('no logical admin body carries the ops token', async () => {
  const { app, repo } = await makeApp({ 'https://feed.test/a': () => ok(RSS(item('g1'))) })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(repo.raw, 's1', 'https://feed.test/a')
  const created = await (await app.request('/admin/sources/s1/refresh', refresh({ cookie }, 's1', 'c1'))).json()
  const bodies = await Promise.all([
    (await app.request(`/admin/acquisition-runs/${created.runId}`, { headers: { cookie } })).text(),
    (await app.request('/admin/sources/s1/runs', { headers: { cookie } })).text(),
    (await app.request(`/admin/acquisition-runs/${created.runId}/jobs`, { headers: { cookie } })).text(),
  ])
  for (const body of bodies) for (const secret of [OPS_TOKEN, `Bearer ${OPS_TOKEN}`]) expect(body).not.toContain(secret)
  repo.close()
})
