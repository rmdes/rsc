import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'

// The whole-vertical gate (Task 10). Every earlier task proved its own layer;
// this file walks BOTH feature states end to end through the HTTP surface only,
// so a regression that only shows up when the pieces are wired together fails
// here rather than in production.

// checkCallbackUrl runs real DNS for hostnames and the sandbox has no network,
// so every URL is a TEST-NET-3 literal (RFC 5737) — classified public without a
// DNS round trip. Same convention as source-capability-api/subscriptions-api.
const SRC = 'https://203.0.113.90/f.xml'
const OTHER = 'https://203.0.113.91/f.xml'
const LEGACY_OPML_SRC = 'https://203.0.113.92/f.xml'

// Field names that exist only on the administrative projections. An ordinary
// (non-admin) response body must never contain any of them — asserted against
// the SERIALIZED body, so a nested or renamed-but-still-leaking field is caught.
const ADMIN_ONLY = ['governance', 'operation', 'provenanceNote', 'adminRetained']

async function makeApp(v2: boolean) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus, null)
  const app = createApp({
    service,
    bus,
    token: 'ops-token',
    auth: makeAuth(repo),
    users: repo,
    adminEmails: new Set(['boss@x.test']),
    feeds: { publicUrl: null, hubUrl: null, rssCloud: false },
    // Presence of `sources` IS RSC_SOURCE_MODEL_V2 at the HTTP layer: server.ts
    // builds it only when the flag is on (and imports the module dynamically).
    ...(v2 ? { sources: { service: createSourceService(repo, null), repo } } : {}),
  })
  return { app, repo }
}

const json = (cookie: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
})

// --- flag OFF: today's instance, unchanged --------------------------------

async function expectLegacySurface(app: Awaited<ReturnType<typeof makeApp>>['app'], repo: Awaited<ReturnType<typeof makeApp>>['repo']) {
  expect(await (await app.request('/capabilities')).json()).toEqual({ sourceModelV2: false })

  const cookie = await registeredSession(app, 'legacy@x.test', repo)

  // Legacy subscribe: {url,type} → 201 with the remote shadow account.
  const sub = await app.request('/me/subscriptions', json(cookie, { url: SRC, type: 'webfeed' }))
  expect(sub.status).toBe(201)
  expect((await sub.json()).user.feedUrl).toBe(SRC)

  // Legacy following: full User rows, keyed by handle.
  const handle = (await (await app.request('/me', { headers: { cookie } })).json()).user.handle
  const follows = await app.request(`/users/${handle}/follows`)
  expect(follows.status).toBe(200)
  expect((await follows.json()).following.map((f: { feedUrl: string }) => f.feedUrl)).toEqual([SRC])
  expect((await app.request(`/users/${handle}/following.opml`)).status).toBe(200)

  // Legacy OPML import: no command-id header, legacy counts.
  const opml = await app.request('/me/follows/opml', {
    method: 'POST',
    headers: { cookie },
    body: `<opml version="2.0"><body><outline type="rss" text="x" xmlUrl="${LEGACY_OPML_SRC}"/></body></opml>`,
  })
  expect(opml.status).toBe(200)
  expect(Object.keys(await opml.json()).sort()).toEqual(['created', 'followed', 'skipped'])

  // Legacy admin surface.
  const admin = { headers: { cookie: await registeredSession(app, 'boss@x.test', repo) } }
  expect((await app.request('/admin/feeds', admin)).status).toBe(200)
  return admin
}

test('with the flag off the legacy surface is intact and no v2 route exists', async () => {
  const { app, repo } = await makeApp(false)
  const adminRequest = await expectLegacySurface(app, repo)

  // 404, not 403: the request passes the app.use('/admin/*') gate as an admin
  // and finds no route at all. (An UNauthenticated caller gets 401 from that
  // same gate first — house behavior for any unknown /admin/* path.)
  expect((await app.request('/admin/sources', adminRequest)).status).toBe(404)
  expect((await app.request('/me/following', adminRequest)).status).toBe(404)
  repo.close()
})

// --- flag ON: the v2 control plane, end to end ----------------------------

async function runV2ControlPlaneFlow(app: Awaited<ReturnType<typeof makeApp>>['app'], repo: Awaited<ReturnType<typeof makeApp>>['repo']) {
  const member = await registeredSession(app, 'member@x.test', repo)
  const admin = await registeredSession(app, 'boss@x.test', repo)
  const ordinaryBodies: string[] = []

  // Every ordinary (non-admin) response body is captured on the way past, so
  // the leak assertion covers the whole flow rather than a sampled endpoint.
  const ordinary = async (path: string, init?: Parameters<typeof app.request>[1]) => {
    const res = await app.request(path, init)
    const text = await res.text()
    ordinaryBodies.push(text)
    return { status: res.status, text, body: text.startsWith('<') ? undefined : JSON.parse(text) }
  }
  const adminGet = async (path: string) => {
    const res = await app.request(path, { headers: { cookie: admin } })
    return { status: res.status, body: await res.json() }
  }
  const adminPost = async (path: string, body: unknown) => {
    const res = await app.request(path, json(admin, body))
    return { status: res.status, body: await res.json() }
  }

  // 1. A user subscribes: the source is created allowed/enabled and the owner
  //    gets the owner projection, never the source row.
  const subscribed = await ordinary('/me/subscriptions', json(member, { url: SRC, commandId: 'sub-1' }))
  expect(subscribed.status).toBe(201)
  const sourceId: string = subscribed.body.subscription.sourceId
  expect(Object.keys(subscribed.body.subscription).sort()).toEqual(['attributionMode', 'availability', 'sourceId', 'subscriptionState', 'url'])

  const handle: string = (await (await app.request('/me', { headers: { cookie: member } })).json()).user.handle

  // 2. Its owner projection, and the public one it is exposed through.
  const owner = await ordinary('/me/following', { headers: { cookie: member } })
  expect(owner.body.sourceSubscriptions).toEqual([subscribed.body.subscription])
  const publicBefore = await ordinary(`/users/${handle}/follows`)
  expect(publicBefore.body.following).toEqual([{ kind: 'source', sourceId, url: SRC, displayName: '203.0.113.90' }])

  // 3. Quarantine — the subscription survives, but public exposure stops dead.
  const quarantined = await adminPost(`/admin/sources/${sourceId}/quarantine`, { commandId: 'gov-1', category: 'spam', note: 'reported' })
  expect(quarantined.status).toBe(200)
  expect(quarantined.body.source.governance).toBe('quarantined')
  expect((await ordinary(`/users/${handle}/follows`)).body.following).toEqual([])
  expect((await ordinary(`/users/${handle}/following.opml`)).text).not.toContain(SRC)
  // The owner still sees their own row — and still learns nothing about why.
  expect((await ordinary('/me/following', { headers: { cookie: member } })).body.sourceSubscriptions).toHaveLength(1)

  // 4. Allow — exposure returns, on the same stable id.
  expect((await adminPost(`/admin/sources/${sourceId}/allow`, { commandId: 'gov-2', category: 'operator_policy' })).status).toBe(200)
  expect((await ordinary(`/users/${handle}/follows`)).body.following).toEqual([{ kind: 'source', sourceId, url: SRC, displayName: '203.0.113.90' }])

  // 5. Pause / resume — the operation axis, independent of governance.
  const paused = await adminPost(`/admin/sources/${sourceId}/pause`, { commandId: 'gov-3' })
  expect(paused.body.source).toMatchObject({ operation: 'paused', governance: 'allowed' })
  const resumed = await adminPost(`/admin/sources/${sourceId}/resume`, { commandId: 'gov-4' })
  expect(resumed.body.source).toMatchObject({ operation: 'enabled', governance: 'allowed' })

  // 6. Establish federation on the RETAINED source: same row, same mode.
  const federated = await adminPost('/admin/sources', { url: SRC, attributionMode: 'single_publisher', category: 'operator_policy', note: 'partner', commandId: 'fed-1' })
  expect(federated.status).toBe(201)
  expect(federated.body.source.id).toBe(sourceId)
  expect(federated.body.federation).toMatchObject({ sourceId, status: 'approved' })

  // 7. Idempotent retries — a replayed command id reproduces the ORIGINAL
  //    status and body and writes nothing; a reused id with a changed body is a
  //    409 that also writes nothing.
  expect(await ordinary('/me/subscriptions', json(member, { url: SRC, commandId: 'sub-1' }))).toMatchObject({ status: 201, text: subscribed.text })
  expect(await ordinary('/me/subscriptions', json(member, { url: OTHER, commandId: 'sub-1' }))).toMatchObject({ status: 409, body: { error: 'idempotency conflict' } })
  expect(await adminPost(`/admin/sources/${sourceId}/quarantine`, { commandId: 'gov-1', category: 'spam', note: 'reported' })).toEqual(quarantined)
  expect(await adminPost('/admin/sources', { url: SRC, attributionMode: 'single_publisher', category: 'operator_policy', note: 'partner', commandId: 'fed-1' })).toEqual(federated)

  // 8. Unsubscribe by stable id — and the federated source is RETAINED.
  const removed = await ordinary(`/me/subscriptions/${sourceId}`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie: member }, body: JSON.stringify({ commandId: 'unsub-1' }) })
  expect(removed).toMatchObject({ status: 200, body: { ok: true } })
  expect(await ordinary(`/me/subscriptions/${sourceId}`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie: member }, body: JSON.stringify({ commandId: 'unsub-1' }) })).toMatchObject({ status: 200, text: removed.text })
  expect((await ordinary('/me/following', { headers: { cookie: member } })).body.sourceSubscriptions).toEqual([])
  expect((await adminGet(`/admin/sources/${sourceId}`)).status).toBe(200)

  // 9. The audit trail. Read back through the admin API and re-ordered by the
  //    command ids the flow issued, NOT by the listing order: audit rows written
  //    inside the same millisecond tie on created_at and break the tie on a
  //    random uuid, which would make a positional assertion flaky.
  const audit = await adminGet(`/admin/sources/${sourceId}/audit`)
  const byCommand = new Map((audit.body.items as Array<{ commandId: string; action: string }>).map((e) => [e.commandId, e.action]))
  expect(audit.body.items).toHaveLength(5) // every replay above wrote nothing
  return { auditActions: ['gov-1', 'gov-2', 'gov-3', 'gov-4', 'fed-1'].map((id) => String(byCommand.get(id))), ordinaryBodies }
}

test('with the flag on the v2 control plane runs end to end and leaks no administrative field', async () => {
  const { app, repo } = await makeApp(true)
  // V2 supersession (spec §5.6): the enabled branch is the discriminated shape.
  expect(await (await app.request('/capabilities')).json()).toEqual({ sourceModelV2: true, model: 'logical-v2', journalCursorVersion: 1, streamProtocolVersion: 1 })

  const flow = await runV2ControlPlaneFlow(app, repo)

  // The plan's Task 10 sketch spells the last one 'federation_establish'; the
  // audit action Task 6 actually writes (and every earlier test asserts) is
  // 'establish_federation'. Reality wins — see the Task 10 report.
  expect(flow.auditActions).toEqual(['quarantine', 'allow', 'pause', 'resume', 'establish_federation'])

  expect(flow.ordinaryBodies.length).toBeGreaterThan(0)
  for (const body of flow.ordinaryBodies) for (const key of ADMIN_ONLY) expect(body).not.toContain(key)
  repo.close()
})
