import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import type { SourceService } from '../src/domain/source-service.ts'
import { fingerprintRequest } from '../src/domain/source-repository.ts'
import { normalizeSourceUrl } from '../src/domain/source-url.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'

// The ops bearer token, distinctive on purpose: the redaction assertion below
// (the same standing check source-admin-api.test.ts runs over the admin
// bodies, extended to the ops route's own success/error/audit bodies) would
// pass by accident on a value like "secret".
const OPS_TOKEN = 'ops-token-DEADBEEF'
const FED_URL = 'https://203.0.113.50/f.xml'
const OPS_PATH = '/ops/sources/federation'
// The V4 §6 actor id: 'ops:' + the first 16 hex of SHA-256(RSC_TOKEN) — a
// stable NON-SECRET fingerprint. Derived here independently of the route.
const OPS_ACTOR_ID = `ops:${createHash('sha256').update(OPS_TOKEN).digest('hex').slice(0, 16)}`

const post = (headers: Record<string, string>, body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const bearer = { authorization: `Bearer ${OPS_TOKEN}` }
const fedBody = (over: Record<string, unknown> = {}) => ({ url: FED_URL, attributionMode: 'aggregate', category: 'operator_policy', note: 'configured peer', commandId: 'ops-1', ...over })

// Records every SourceService member the API layer reaches for, so "it invokes
// establishFederation only — no second code path" (spec §6) is asserted rather
// than assumed.
function recordingService(inner: SourceService): { service: SourceService; touched: string[] } {
  const touched: string[] = []
  const service = new Proxy(inner, {
    get(target, key, receiver) {
      if (typeof key === 'string') touched.push(key)
      return Reflect.get(target, key, receiver)
    },
  })
  return { service, touched }
}

async function makeApp(opts: { v2?: boolean } = {}) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus, null)
  const rec = recordingService(createSourceService(repo, null))
  const app = createApp({
    service,
    bus,
    token: OPS_TOKEN,
    auth: makeAuth(repo),
    users: repo,
    adminEmails: new Set(['boss@x.test']),
    ...(opts.v2 === false ? {} : { sources: { service: rec.service, repo } }),
  })
  return { app, repo, touched: rec.touched }
}

// --- Step 1: the route contract ------------------------------------------

test('the ops route exists only under v2 — with the flag off it is a plain 404', async () => {
  const { app, repo } = await makeApp({ v2: false })
  const res = await app.request(OPS_PATH, post(bearer, fedBody()))
  expect(res.status).toBe(404)
  repo.close()
})

test('a valid bearer establishes federation as actor kind operator_token under ledger scope ops', async () => {
  const { app, repo, touched } = await makeApp()

  const res = await app.request(OPS_PATH, post(bearer, fedBody()))
  expect(res.status).toBe(201)
  const json = await res.json()
  expect(json.source.canonicalUrl).toBe(FED_URL)
  expect(json.source.provenance).toBe('admin_federation')
  expect(json.source.attributionMode).toBe('aggregate')
  expect(json.federation).toMatchObject({ sourceId: json.source.id, status: 'approved', provenanceNote: 'configured peer' })

  // The SAME domain transition the admin route drives — and only that one.
  expect([...new Set(touched)]).toEqual(['establishFederation'])

  // Audit: actor kind operator_token, actor id the token fingerprint.
  const audit = repo.raw.prepare(`SELECT * FROM source_audit_v2 WHERE source_id = ?`).all(json.source.id) as Array<{ actor_kind: string; actor_id: string; action: string; category: string }>
  expect(audit).toHaveLength(1)
  expect(audit[0]).toMatchObject({ actor_kind: 'operator_token', actor_id: OPS_ACTOR_ID, action: 'establish_federation', category: 'operator_policy' })

  // Ledger: scope 'ops', the V1-pinned fingerprint over the NORMALIZED url.
  const ledger = repo.raw.prepare(`SELECT * FROM command_ledger_v2`).all() as Array<{ actor_scope: string; actor_id: string; command_id: string; request_fingerprint: string }>
  expect(ledger).toHaveLength(1)
  expect(ledger[0]).toMatchObject({ actor_scope: 'ops', actor_id: OPS_ACTOR_ID, command_id: 'ops-1' })
  expect(ledger[0].request_fingerprint).toBe(fingerprintRequest(['federation', normalizeSourceUrl(FED_URL), 'aggregate']))
  repo.close()
})

test('an identical replay returns the stored result; a changed url or mode conflicts', async () => {
  const { app, repo } = await makeApp()

  const first = await app.request(OPS_PATH, post(bearer, fedBody()))
  expect(first.status).toBe(201)
  const json = await first.json()

  const replay = await app.request(OPS_PATH, post(bearer, fedBody()))
  expect(replay.status).toBe(201)
  expect(await replay.json()).toEqual(json)

  // Same command id, changed URL → idempotency conflict, nothing written.
  const changedUrl = await app.request(OPS_PATH, post(bearer, fedBody({ url: 'https://203.0.113.51/f.xml' })))
  expect(changedUrl.status).toBe(409)
  expect(await changedUrl.json()).toEqual({ error: 'idempotency conflict' })

  // Same command id, changed attribution mode → the same conflict (the mode is
  // part of the pinned fingerprint).
  const changedMode = await app.request(OPS_PATH, post(bearer, fedBody({ attributionMode: 'single_publisher' })))
  expect(changedMode.status).toBe(409)
  expect(await changedMode.json()).toEqual({ error: 'idempotency conflict' })

  // Exactly one source, one audit row, one ledger row survive the four calls.
  for (const table of ['remote_sources_v2', 'source_audit_v2', 'command_ledger_v2']) {
    const { n } = repo.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    expect([table, n]).toEqual([table, 1])
  }
  repo.close()
})

test('the ops route validates its body, takes commandId ONLY from the body, and composes jsonWrite', async () => {
  const { app, repo } = await makeApp()

  expect((await app.request(OPS_PATH, post(bearer, fedBody({ url: 'not a url' })))).status).toBe(400)
  expect((await app.request(OPS_PATH, post(bearer, fedBody({ attributionMode: 'bogus' })))).status).toBe(400)
  expect((await app.request(OPS_PATH, post(bearer, fedBody({ category: 'bogus' })))).status).toBe(400)
  expect((await app.request(OPS_PATH, { method: 'POST', headers: { 'content-type': 'application/json', ...bearer }, body: '{' })).status).toBe(400)

  // commandId travels in the JSON body ONLY — a header is never read.
  const { commandId, ...noCommandId } = fedBody()
  const viaHeader = await app.request(OPS_PATH, post({ ...bearer, 'x-rsc-command-id': commandId }, noCommandId))
  expect(viaHeader.status).toBe(400)
  expect(await viaHeader.json()).toEqual({ error: 'commandId invalid' })

  // jsonWrite (composed positionally by import, never redefined) answers 413
  // before the handler's own note-length guard could 400.
  const oversized = await app.request(OPS_PATH, post(bearer, fedBody({ note: 'x'.repeat(600 * 1024) })))
  expect(oversized.status).toBe(413)

  const { n } = repo.raw.prepare(`SELECT COUNT(*) AS n FROM remote_sources_v2`).get() as { n: number }
  expect(n).toBe(0)
  repo.close()
})

// --- Step 2: the authorization matrix (V1 review Finding 3) ---------------

test('the ops route is bearer-only: [none,invalid bearer,admin session,valid bearer] → [401,401,401,201]', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)

  const actors: Array<[string, Record<string, string>, number]> = [
    ['unauthenticated', {}, 401],
    ['invalidToken', { authorization: 'Bearer nope' }, 401],
    ['adminSession', { cookie }, 401], // bearer-only: a session carries no bearer header
    ['validToken', bearer, 201],
  ]
  for (const [name, headers, status] of actors) {
    const res = await app.request(OPS_PATH, post(headers, fedBody({ commandId: `auth-${name}` })))
    expect([name, res.status]).toEqual([name, status])
  }
  // Only the authorized call wrote.
  const { n } = repo.raw.prepare(`SELECT COUNT(*) AS n FROM source_audit_v2`).get() as { n: number }
  expect(n).toBe(1)
  repo.close()
})

test('the ops token reaches no /admin/* route — every one answers 401, never 403', async () => {
  const { app, repo } = await makeApp()
  const created = await app.request(OPS_PATH, post(bearer, fedBody()))
  expect(created.status).toBe(201)
  const sourceId = (await created.json()).source.id

  // No better-auth session → sessionAuth answers 401 (api/auth.ts:64-66) before
  // requireAdmin's 403 (:82) is ever reachable. The token grants no read,
  // moderation, purge, evidence or subscriber access under /admin/*.
  //
  // This probe does NOT cover the token's full reach: adminOrToken
  // (api/auth.ts:92, used at api/app.ts:179 and :498) also admits this same
  // bearer to POST /users and DELETE /users/:handle — routes that live under
  // /users, not /admin, and keep their own adminOrToken gate (api/app.ts:245-
  // 246). DELETE /users/:handle removes a remote feed. That reach is
  // pre-existing and deliberate (app.ts:244-246), not a regression — it is
  // simply outside what this test asserts.
  const admin: Array<[string, RequestInit | undefined]> = [
    ['/admin/sources', undefined],
    [`/admin/sources/${sourceId}`, undefined],
    [`/admin/sources/${sourceId}/subscriptions`, undefined],
    [`/admin/sources/${sourceId}/audit`, undefined],
    ['/admin/overview', undefined],
    ['/admin/users', undefined],
    ['/admin/settings', undefined],
    ['/admin/feeds', undefined],
    [`/admin/sources/${sourceId}/block`, post({}, { commandId: 'tok-1', category: 'abuse' })],
    [`/admin/sources/${sourceId}/pause`, post({}, { commandId: 'tok-2' })],
    ['/admin/sources', post({}, fedBody({ commandId: 'tok-3' }))],
    [`/admin/users/${randomUUID()}`, { method: 'DELETE' }],
  ]
  for (const [path, init] of admin) {
    const res = await app.request(path, { ...(init ?? {}), headers: { ...(init?.headers ?? {}), ...bearer } })
    expect([path, res.status]).toEqual([path, 401])
  }
  // Nothing the token attempted was written: the single audit row is its own
  // federation establishment.
  const { n } = repo.raw.prepare(`SELECT COUNT(*) AS n FROM source_audit_v2`).get() as { n: number }
  expect(n).toBe(1)
  repo.close()
})

test('no ops body — success, error or audit — carries the raw token; only the fingerprint travels', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const created = await app.request(OPS_PATH, post(bearer, fedBody()))
  const sourceId = (await created.clone().json()).source.id

  const textOf = async (res: Response | Promise<Response>) => (await res).text()
  const bodies = await Promise.all([
    created.text(),
    textOf(app.request(OPS_PATH, post(bearer, fedBody({ url: 'https://203.0.113.51/f.xml' })))), // conflict body
    textOf(app.request(OPS_PATH, post(bearer, fedBody({ commandId: 'ops-2' })))), // already-exists body
    textOf(app.request(OPS_PATH, post(bearer, fedBody({ url: 'not a url', commandId: 'ops-3' })))), // validation body
    textOf(app.request(OPS_PATH, post({ authorization: 'Bearer nope' }, fedBody({ commandId: 'ops-4' })))), // 401 body
    // the audit trail the establishment wrote, as an administrator reads it
    textOf(app.request(`/admin/sources/${sourceId}/audit`, { headers: { cookie } })),
    textOf(app.request(`/admin/sources/${sourceId}`, { headers: { cookie } })),
  ])
  for (const body of bodies) {
    for (const secret of [`Bearer ${OPS_TOKEN}`, OPS_TOKEN]) expect(body).not.toContain(secret)
  }
  // The audit body carries the non-secret fingerprint instead.
  expect(bodies[5]).toContain(OPS_ACTOR_ID)
  repo.close()
})
