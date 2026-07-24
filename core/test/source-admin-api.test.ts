import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

// The ops bearer token. Distinctive on purpose: the redaction test asserts it
// never appears in any serialized body, which a value like "secret" could pass
// by accident.
const OPS_TOKEN = 'ops-token-DEADBEEF'
const PUSH_SECRET = 'push-secret-CAFEBABE'
const CALLBACK_TOKEN = 'callback-token-F00DF00D'
const FED_URL = 'https://203.0.113.50/f.xml'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus, null)
  const app = createApp({
    service,
    bus,
    token: OPS_TOKEN,
    auth: makeAuth(repo),
    users: repo,
    adminEmails: new Set(['boss@x.test']),
    sources: { service: createSourceService(repo, null), repo },
  })
  return { app, repo, service }
}

type Raw = InstanceType<typeof Database>

function insertSourceRow(repo: { raw: Raw }, opts: { canonicalUrl: string; attributionMode?: string; operation?: string; governance?: string }): string {
  const id = randomUUID()
  repo.raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, ?, ?, 'user_subscription', NULL, 0, ?)`,
  ).run(id, opts.canonicalUrl, opts.attributionMode ?? 'single_publisher', opts.operation ?? 'enabled', opts.governance ?? 'allowed', '2026-01-01T00:00:00.000Z')
  return id
}

const post = (headers: Record<string, string>, body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

const PUSH_ENDPOINT = 'https://hub.example/hub'
const PUSH_EXPIRES = '2027-01-01T00:00:00.000Z'

// A v2 push lease for a source (V4 Task 3): the admin projection reads it, and the
// standing redaction loop runs over it — callback_token and secret must reach no body.
function insertPushRowV2(repo: { raw: Raw }, sourceId: string, opts: { mode?: string; state?: string; endpoint?: string } = {}): void {
  repo.raw.prepare(
    `INSERT INTO push_subscriptions_v2 (id, source_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES (?, ?, ?, ?, 'https://topic.example/f.xml', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
  ).run(randomUUID(), sourceId, opts.mode ?? 'websub', opts.endpoint ?? PUSH_ENDPOINT, `${CALLBACK_TOKEN}-${opts.mode ?? 'websub'}`, PUSH_SECRET, opts.state ?? 'active', PUSH_EXPIRES)
}

// --- Step 2: the administrative authorization matrix ---

test('every admin source route answers [401,403,403,200,401,401] for [none,anon,registered,admin,valid token,invalid token]', async () => {
  const { app, repo } = await makeApp()
  const sourceId = insertSourceRow(repo, { canonicalUrl: FED_URL })

  // The two bearer-token columns are 401, NOT 403: a token-only request has no
  // better-auth session, so sessionAuth answers before requireAdmin is reached.
  // The ops token grants no administrative read at all (design §11).
  const actors: Array<[string, Record<string, string>]> = [
    ['unauthenticated', {}],
    ['anonymous', { cookie: await anonSession(app) }],
    ['registered', { cookie: await registeredSession(app, 'peon@x.test', repo) }],
    ['admin', { cookie: await registeredSession(app, 'boss@x.test', repo) }],
    ['validToken', { authorization: `Bearer ${OPS_TOKEN}` }],
    ['invalidToken', { authorization: 'Bearer nope' }],
  ]

  const routes: Record<string, (headers: Record<string, string>, actor: string) => Response | Promise<Response>> = {
    list: (headers) => app.request('/admin/sources', { headers }),
    detail: (headers) => app.request(`/admin/sources/${sourceId}`, { headers }),
    subscriptions: (headers) => app.request(`/admin/sources/${sourceId}/subscriptions`, { headers }),
    audit: (headers) => app.request(`/admin/sources/${sourceId}/audit`, { headers }),
    mutate: (headers, actor) => app.request(`/admin/sources/${sourceId}/pause`, post(headers, { commandId: `mutate-${actor}` })),
  }

  const expected = [401, 403, 403, 200, 401, 401]
  for (const [name, run] of Object.entries(routes)) {
    const statuses: number[] = []
    for (const [actor, headers] of actors) statuses.push((await run(headers, actor)).status)
    expect([name, statuses]).toEqual([name, expected])
  }
  repo.close()
})

test('no admin body — success or error — carries a secret, callback token, auth header or the ops token', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const owner = await repo.createLocalUser({ handle: 'sub-owner', displayName: 'Sub Owner' })
  repo.raw.prepare(
    `INSERT INTO push_subscriptions (id, user_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES (?, ?, 'websub', 'https://hub.example/', 'https://topic.example/f.xml', ?, ?, 'active', ?, ?)`,
  ).run(randomUUID(), owner.id, CALLBACK_TOKEN, PUSH_SECRET, '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

  const created = await app.request('/admin/sources', post({ cookie }, { url: FED_URL, attributionMode: 'single_publisher', category: 'operator_policy', note: 'partner', commandId: 'red-1' }))
  const sourceId = (await created.clone().json()).source.id
  repo.raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`)
    .run(randomUUID(), owner.id, sourceId, '2026-01-01T00:00:00.000Z')
  // …and the v2 lease the admin projection now joins: its token and secret must
  // survive nowhere in a list, detail, error or audit body either (spec §1.5).
  insertPushRowV2(repo, sourceId)
  insertPushRowV2(repo, sourceId, { mode: 'rsscloud', state: 'pending', endpoint: 'http://cloud.example:5337/p' })

  const textOf = async (res: Response | Promise<Response>) => (await res).text()
  const bodies = await Promise.all([
    created.text(),
    textOf(app.request('/admin/sources', { headers: { cookie } })),
    textOf(app.request(`/admin/sources/${sourceId}`, { headers: { cookie } })),
    textOf(app.request(`/admin/sources/${sourceId}/subscriptions`, { headers: { cookie } })),
    textOf(app.request(`/admin/sources/${sourceId}/audit`, { headers: { cookie } })),
    textOf(app.request(`/admin/sources/${sourceId}/pause`, post({ cookie }, { commandId: 'red-2' }))),
    textOf(app.request(`/admin/sources/${sourceId}/pause`, post({ cookie }, { commandId: 'red-3' }))), // invalid transition error body
    textOf(app.request(`/admin/sources/${randomUUID()}`, { headers: { cookie } })),
    textOf(app.request('/admin/sources', { headers: { authorization: `Bearer ${OPS_TOKEN}` } })),
  ])
  for (const body of bodies) {
    for (const secret of [PUSH_SECRET, CALLBACK_TOKEN, `Bearer ${OPS_TOKEN}`, OPS_TOKEN]) expect(body).not.toContain(secret)
  }
  repo.close()
})

// --- Step 5: the administrative endpoints themselves ---

async function adminApp() {
  const made = await makeApp()
  const cookie = await registeredSession(made.app, 'boss@x.test', made.repo)
  return { ...made, cookie }
}

test('POST /admin/sources establishes federation, replays, and distinguishes reuse from convergence', async () => {
  const { app, repo, cookie } = await adminApp()
  const body = { url: FED_URL, attributionMode: 'single_publisher', category: 'operator_policy', note: 'partner', commandId: 'fed-1' }

  const created = await app.request('/admin/sources', post({ cookie }, body))
  expect(created.status).toBe(201)
  const json = await created.json()
  expect(json.source.canonicalUrl).toBe(FED_URL)
  expect(json.source.provenance).toBe('admin_federation')
  expect(json.federation).toMatchObject({ sourceId: json.source.id, status: 'approved', provenanceNote: 'partner' })

  // Ledger: an administrator federation ledgers under scope 'administrator'
  // (V4 §6) — the ops route ledgers the same command under 'ops' instead
  // (source-ops-api.test.ts). Pins source-service.ts:206's actorScope mapping
  // on the real HTTP path, not a hand-built envelope.
  const ledgerRow = repo.raw.prepare(`SELECT actor_scope FROM command_ledger_v2 WHERE command_id = ?`).get('fed-1') as { actor_scope: string } | undefined
  expect(ledgerRow?.actor_scope).toBe('administrator')

  const replay = await app.request('/admin/sources', post({ cookie }, body))
  expect(replay.status).toBe(201)
  expect(await replay.json()).toEqual(json)

  // Same command id, changed URL → idempotency conflict, nothing written.
  const reuse = await app.request('/admin/sources', post({ cookie }, { ...body, url: 'https://203.0.113.51/f.xml' }))
  expect(reuse.status).toBe(409)
  expect(await reuse.json()).toEqual({ error: 'idempotency conflict' })

  // A different command id against the same URL converges on the one relationship.
  const again = await app.request('/admin/sources', post({ cookie }, { ...body, commandId: 'fed-2' }))
  expect(again.status).toBe(409)
  expect(await again.json()).toEqual({ error: 'federation already exists' })

  // A blocked source reveals nothing beyond the neutral refusal.
  const blockedId = insertSourceRow(repo, { canonicalUrl: 'https://203.0.113.52/f.xml', governance: 'blocked' })
  const blocked = await app.request('/admin/sources', post({ cookie }, { ...body, url: 'https://203.0.113.52/f.xml', commandId: 'fed-3' }))
  expect(blocked.status).toBe(409)
  expect(JSON.stringify(await blocked.json())).not.toContain(blockedId)

  expect((await app.request('/admin/sources', post({ cookie }, { ...body, url: 'not a url', commandId: 'fed-4' }))).status).toBe(400)
  expect((await app.request('/admin/sources', post({ cookie }, { ...body, attributionMode: 'bogus', commandId: 'fed-5' }))).status).toBe(400)
  expect((await app.request('/admin/sources', post({ cookie }, { url: FED_URL, attributionMode: 'aggregate', commandId: 'fed-6' }))).status).toBe(400) // category required
  repo.close()
})

test('the admin reads paginate and project summary/detail/subresources', async () => {
  const { app, repo, cookie } = await adminApp()
  const first = insertSourceRow(repo, { canonicalUrl: 'https://203.0.113.60/f.xml' })
  const second = insertSourceRow(repo, { canonicalUrl: 'https://203.0.113.61/f.xml' })
  const owner = await repo.createLocalUser({ handle: 'reader', displayName: 'Reader' })
  repo.raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`)
    .run(randomUUID(), owner.id, first, '2026-01-02T00:00:00.000Z')

  const page1 = await (await app.request('/admin/sources?limit=1', { headers: { cookie } })).json()
  expect(page1.items).toHaveLength(1)
  expect(page1.nextCursor).toEqual(expect.any(String))
  const page2 = await (await app.request(`/admin/sources?limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`, { headers: { cookie } })).json()
  expect(page2.items).toHaveLength(1)
  expect(page2.items[0].source.id).not.toBe(page1.items[0].source.id)
  expect([page1.items[0].source.id, page2.items[0].source.id].sort()).toEqual([first, second].sort())
  // 'push' / 'pushExpiresAt' joined the DTOs in V4 Task 1 (all-null until a lease exists).
  expect(Object.keys(page1.items[0]).sort()).toEqual(['federationStatus', 'push', 'source', 'subscriptionCounts'])

  const detail = await app.request(`/admin/sources/${first}`, { headers: { cookie } })
  expect(detail.status).toBe(200)
  const detailJson = await detail.json()
  expect(Object.keys(detailJson).sort()).toEqual(['federationStatus', 'latestAudit', 'push', 'pushExpiresAt', 'source', 'subscriptionCounts'])
  expect(detailJson.subscriptionCounts).toEqual({ active: 1, pending: 0, pendingReview: 0 })
  expect((await app.request(`/admin/sources/${randomUUID()}`, { headers: { cookie } })).status).toBe(404)

  const subs = await (await app.request(`/admin/sources/${first}/subscriptions`, { headers: { cookie } })).json()
  expect(subs.items).toHaveLength(1)
  expect(subs.items[0].ownerId).toBe(owner.id)
  const audit = await (await app.request(`/admin/sources/${first}/audit`, { headers: { cookie } })).json()
  expect(audit).toEqual({ items: [], nextCursor: null })

  expect((await app.request('/admin/sources?cursor=@@bogus@@', { headers: { cookie } })).status).toBe(400)
  repo.close()
})

// --- V4 Task 3: the administrative push surface (spec §1.5) ---

test('summary.push carries {mode,state,endpointFingerprint} and detail adds pushExpiresAt', async () => {
  const { app, repo, cookie } = await adminApp()
  const leased = insertSourceRow(repo, { canonicalUrl: 'https://203.0.113.40/f.xml' })
  const bare = insertSourceRow(repo, { canonicalUrl: 'https://203.0.113.41/f.xml' })
  insertPushRowV2(repo, leased)

  const fingerprint = createHash('sha256').update(PUSH_ENDPOINT).digest('hex').slice(0, 16)
  const list = await (await app.request('/admin/sources?limit=10', { headers: { cookie } })).json()
  const byId = Object.fromEntries(list.items.map((i: { source: { id: string }; push: unknown }) => [i.source.id, i.push]))
  expect(byId[leased]).toEqual({ mode: 'websub', state: 'active', endpointFingerprint: fingerprint })
  // a source with no lease keeps the all-null placeholder — the field is never absent
  expect(byId[bare]).toEqual({ mode: null, state: null, endpointFingerprint: null })

  const detail = await (await app.request(`/admin/sources/${leased}`, { headers: { cookie } })).json()
  expect(detail.push).toEqual({ mode: 'websub', state: 'active', endpointFingerprint: fingerprint })
  expect(detail.pushExpiresAt).toBe(PUSH_EXPIRES)
  const bareDetail = await (await app.request(`/admin/sources/${bare}`, { headers: { cookie } })).json()
  expect(bareDetail.push).toEqual({ mode: null, state: null, endpointFingerprint: null })
  expect(bareDetail.pushExpiresAt).toBeNull()
  repo.close()
})

test('the endpoint fingerprint is a stable digest, never the endpoint itself', async () => {
  const { app, repo, cookie } = await adminApp()
  const id = insertSourceRow(repo, { canonicalUrl: 'https://203.0.113.42/f.xml' })
  insertPushRowV2(repo, id)

  const first = await (await app.request(`/admin/sources/${id}`, { headers: { cookie } })).text()
  const second = await (await app.request(`/admin/sources/${id}`, { headers: { cookie } })).text()
  expect(first).toBe(second)                       // stable across reads
  expect(first).not.toContain(PUSH_ENDPOINT)       // the endpoint itself never ships
  expect(first).not.toContain('hub.example')
  expect(JSON.parse(first).push.endpointFingerprint).toMatch(/^[0-9a-f]{16}$/)
  repo.close()
})

test('an active lease wins over a pending one in the single-lease projection', async () => {
  const { app, repo, cookie } = await adminApp()
  const id = insertSourceRow(repo, { canonicalUrl: 'https://203.0.113.43/f.xml' })
  insertPushRowV2(repo, id, { mode: 'rsscloud', state: 'pending', endpoint: 'http://cloud.example:5337/p' })
  insertPushRowV2(repo, id, { mode: 'websub', state: 'active' })

  const detail = await (await app.request(`/admin/sources/${id}`, { headers: { cookie } })).json()
  expect(detail.push).toMatchObject({ mode: 'websub', state: 'active' })
  repo.close()
})

test('POST /admin/sources/:id/:action drives the transition matrix and separates its two 409s', async () => {
  const { app, repo, cookie } = await adminApp()
  const id = insertSourceRow(repo, { canonicalUrl: 'https://203.0.113.70/f.xml' })
  const act = (action: string, body: Record<string, unknown>) => app.request(`/admin/sources/${id}/${action}`, post({ cookie }, body))

  const paused = await act('pause', { commandId: 'a-1' }) // pause/resume may carry a null category
  expect(paused.status).toBe(200)
  const pausedJson = await paused.json()
  expect(pausedJson.source.operation).toBe('paused')
  expect(pausedJson.audit).toMatchObject({ sourceId: id, action: 'pause', actorKind: 'administrator', category: null })

  // An illegal cell (already paused) is a DIFFERENT 409 from command reuse.
  const illegal = await act('pause', { commandId: 'a-2' })
  expect(illegal.status).toBe(409)
  expect(await illegal.json()).toEqual({ error: 'invalid transition' })

  const resumed = await act('resume', { commandId: 'a-3' })
  expect(resumed.status).toBe(200)
  const reuse = await act('pause', { commandId: 'a-3' }) // legal cell, reused command id
  expect(reuse.status).toBe(409)
  expect(await reuse.json()).toEqual({ error: 'idempotency conflict' })

  // Hyphenated segment → the set_attribution_mode domain action.
  expect((await act('attribution-mode', { commandId: 'a-4', category: 'operator_policy' })).status).toBe(400)
  const mode = await act('attribution-mode', { commandId: 'a-5', category: 'operator_policy', attributionMode: 'aggregate' })
  expect(mode.status).toBe(200)
  const modeJson = await mode.json()
  expect(modeJson.source.attributionMode).toBe('aggregate')
  expect(modeJson.audit.action).toBe('set_attribution_mode')

  // A category-requiring action without one is a validation error, not a conflict.
  expect((await act('quarantine', { commandId: 'a-6' })).status).toBe(400)
  expect((await act('quarantine', { commandId: 'a-7', category: 'bogus' })).status).toBe(400)
  expect((await act('quarantine', { commandId: 'a-8', category: 'spam', note: 'why' })).status).toBe(200)

  expect((await act('bogus', { commandId: 'a-9', category: 'spam' })).status).toBe(400)
  expect((await act('pause', { category: 'spam' })).status).toBe(400) // commandId required
  const unknown = await app.request(`/admin/sources/${randomUUID()}/pause`, post({ cookie }, { commandId: 'a-10' }))
  expect(unknown.status).toBe(404)
  repo.close()
})

test('replaying a SUCCESSFUL transition returns the stored result, never invalid transition', async () => {
  const { app, repo, cookie } = await adminApp()

  // Each action's own success makes the cell illegal a second time, so the
  // matrix pre-check would refuse the replay if it ran before the ledger —
  // spec §11: repeating an ID returns the original result, no second mutation.
  for (const [action, body] of [
    ['pause', {}],
    ['quarantine', { category: 'spam' }],
    ['block', { category: 'abuse' }],
  ] as const) {
    const id = insertSourceRow(repo, { canonicalUrl: `https://203.0.113.9${action.length}/${action}.xml` })
    const act = () => app.request(`/admin/sources/${id}/${action}`, post({ cookie }, { ...body, commandId: `replay-${action}` }))

    const first = await act()
    expect([action, first.status]).toEqual([action, 200])
    const firstJson = await first.json()

    const replay = await act()
    expect([action, replay.status]).toEqual([action, 200])
    expect(await replay.json()).toEqual(firstJson)

    const { n } = repo.raw.prepare(`SELECT count(*) AS n FROM source_audit_v2 WHERE source_id = ?`).get(id) as { n: number }
    expect([action, n]).toEqual([action, 1])
  }
  repo.close()
})

test('an admin mutation is reachable only under the /admin/* gate — the ops token cannot moderate', async () => {
  const { app, repo } = await makeApp()
  const id = insertSourceRow(repo, { canonicalUrl: 'https://203.0.113.80/f.xml' })
  const res = await app.request(`/admin/sources/${id}/block`, post({ authorization: `Bearer ${OPS_TOKEN}` }, { commandId: 'tok-1', category: 'abuse' }))
  expect(res.status).toBe(401)
  const rows = repo.raw.prepare(`SELECT COUNT(*) AS n FROM source_audit_v2`).get() as { n: number }
  expect(rows.n).toBe(0)
  repo.close()
})

test('ordinary callers never reach the admin surface even when the flag is on', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'ordinary@x.test', repo)
  const id = insertSourceRow(repo, { canonicalUrl: 'https://203.0.113.81/f.xml' })
  expect((await app.request(`/admin/sources/${id}`, { headers: { cookie } })).status).toBe(403)
  expect((await app.request(`/admin/sources/${id}/block`, post({ cookie }, { commandId: 'o-1', category: 'abuse' }))).status).toBe(403)
  repo.close()
})

// --- ?filter=governance: federation/review rows independent of pagination ----

test('?filter=governance returns federated and quarantined sources even when newer bulk rows bury them', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const created = await app.request('/admin/sources', post({ cookie }, { url: FED_URL, attributionMode: 'aggregate', category: 'operator_policy', commandId: 'gov-1' }))
  const fedId = (await created.json()).source.id
  const seed = repo.raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', ?, 'user_subscription', NULL, 0, ?)`,
  )
  for (let i = 0; i < 60; i++) seed.run(randomUUID(), `https://filler${i}.test/feed`, 'allowed', `2027-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`)
  const quarId = randomUUID()
  seed.run(quarId, 'https://quarantined.test/feed', 'quarantined', '2027-01-01T00:01:30.000Z')

  const page1 = (await (await app.request('/admin/sources', { headers: { cookie } })).json()) as { items: Array<{ source: { id: string } }> }
  expect(page1.items.some((s) => s.source.id === fedId)).toBe(false) // the burial precondition

  const gov = (await (
    await app.request('/admin/sources?filter=governance', { headers: { cookie } })
  ).json()) as { items: Array<{ source: { id: string; governance: string }; federationStatus: string }> }
  const ids = gov.items.map((s) => s.source.id)
  expect(ids).toContain(fedId)
  expect(ids).toContain(quarId)
  expect(gov.items.every((s) => s.federationStatus !== 'none' || s.source.governance === 'quarantined')).toBe(true)

  expect((await app.request('/admin/sources?filter=bogus', { headers: { cookie } })).status).toBe(400)
  repo.close()
})
