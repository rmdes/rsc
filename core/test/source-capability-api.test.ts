import { test, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'

type Raw = InstanceType<typeof Database>

// checkCallbackUrl runs real DNS for hostnames; the sandbox has no network, so
// every success-path URL is a TEST-NET-3 literal (RFC 5737), which
// checkCallbackUrl classifies as public without a DNS round-trip. Same
// convention as subscriptions-api/opml/source-subscribe.
const REMOTE_URL = 'https://203.0.113.20/f.xml'
const QUARANTINED_URL = 'https://203.0.113.30/f.xml'
const BLOCKED_URL = 'https://203.0.113.31/f.xml'
const AGGREGATE_URL = 'https://203.0.113.32/f.xml'
const PUBLIC_URL = 'https://203.0.113.9' // IP literal: a hostname publicUrl would trip the SSRF gate first

async function makeApp(opts: { v2: boolean; publicUrl?: string | null } = { v2: false }) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const publicUrl = opts.publicUrl ?? null
  const service = createService(repo, bus, publicUrl)
  const app = createApp({
    service,
    bus,
    token: 'secret',
    auth: makeAuth(repo),
    users: repo,
    adminEmails: new Set(['boss@x.test']),
    feeds: { publicUrl, hubUrl: null, rssCloud: false },
    // Presence of `sources` IS the RSC_SOURCE_MODEL_V2 flag at the HTTP layer:
    // server.ts only builds it when the flag is on.
    ...(opts.v2 ? { sources: { service: createSourceService(repo, publicUrl), repo } } : {}),
  })
  return { app, repo, service }
}

function insertSourceRow(raw: Raw, opts: { canonicalUrl: string; attributionMode?: string; governance?: string }): string {
  const id = randomUUID()
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, 'enabled', ?, 'user_subscription', NULL, 0, ?)`,
  ).run(id, opts.canonicalUrl, opts.attributionMode ?? 'single_publisher', opts.governance ?? 'allowed', '2026-01-01T00:00:00.000Z')
  return id
}

const json = (cookie: string, body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })

async function subscribe(app: ReturnType<typeof createApp>, cookie: string, body: unknown) {
  const res = await app.request('/me/subscriptions', json(cookie, body))
  return { status: res.status, body: await res.json() }
}

// --- Step 1: the capability endpoint is served in BOTH states ---

test('GET /capabilities is always served and reports the flag exactly', async () => {
  const off = await makeApp({ v2: false })
  const on = await makeApp({ v2: true })
  expect(await (await off.app.request('/capabilities')).json()).toEqual({ sourceModelV2: false })
  expect(await (await on.app.request('/capabilities')).json()).toEqual({ sourceModelV2: true })
  off.repo.close()
  on.repo.close()
})

test('while off no v2 route is registered; while on /admin/sources answers the admin', async () => {
  const off = await makeApp({ v2: false })
  const offAdmin = { headers: { cookie: await registeredSession(off.app, 'boss@x.test', off.repo) } }
  expect((await off.app.request('/admin/feeds', offAdmin)).status).toBe(200)
  expect((await off.app.request('/admin/sources', offAdmin)).status).toBe(404)
  expect((await off.app.request('/me/following', offAdmin)).status).toBe(404)

  const on = await makeApp({ v2: true })
  const onAdmin = { headers: { cookie: await registeredSession(on.app, 'boss@x.test', on.repo) } }
  expect((await on.app.request('/admin/feeds', onAdmin)).status).toBe(200)
  expect((await on.app.request('/admin/sources', onAdmin)).status).toBe(200)
  off.repo.close()
  on.repo.close()
})

test('while off the legacy subscribe/OPML/following routes behave exactly as today', async () => {
  const { app, repo } = await makeApp({ v2: false })
  const cookie = await registeredSession(app, 'legacy@x.test', repo)

  // Legacy shape: {url,type} → 201 {user,followed}; a v2-shaped body 400s on the
  // legacy `type` validator (proof no v2 handler is in front of it).
  const legacy = await subscribe(app, cookie, { url: REMOTE_URL, type: 'webfeed' })
  expect(legacy.status).toBe(201)
  expect(legacy.body.followed).toBe(true)
  expect(legacy.body.user.feedUrl).toBe(REMOTE_URL)
  const v2Shaped = await subscribe(app, cookie, { url: 'https://203.0.113.21/f.xml', commandId: 'off-1' })
  expect(v2Shaped.status).toBe(400)

  const me = await (await app.request('/me', { headers: { cookie } })).json()
  const follows = await (await app.request(`/users/${me.user.handle}/follows`)).json()
  // Legacy projection: full User rows (remote shadow accounts), never v2 entries.
  expect(follows.following.map((f: { feedUrl: string }) => f.feedUrl)).toEqual([REMOTE_URL])

  // Legacy OPML import needs no command-id header and returns legacy counts.
  const opml = await app.request('/me/follows/opml', {
    method: 'POST',
    headers: { cookie },
    body: '<opml version="2.0"><body><outline type="rss" text="x" xmlUrl="https://203.0.113.22/f.xml"/></body></opml>',
  })
  expect(opml.status).toBe(200)
  expect(Object.keys(await opml.json()).sort()).toEqual(['created', 'followed', 'skipped'])
  repo.close()
})

// --- Step 1 (cont.): while ON, v2 supersedes legacy on the shared paths ---

test('while on, v2 supersedes the legacy handlers on every shared path', async () => {
  const { app, repo } = await makeApp({ v2: true })
  const cookie = await registeredSession(app, 'v2@x.test', repo)

  // Legacy would 201 here (url+type is a valid legacy body); v2 rejects the
  // missing commandId — so the v2 handler, not the legacy one, ran.
  const legacyShaped = await subscribe(app, cookie, { url: REMOTE_URL, type: 'webfeed' })
  expect(legacyShaped).toEqual({ status: 400, body: { error: 'commandId invalid' } })

  // And a v2 body (no `type`) succeeds, which legacy would have 400'd.
  const created = await subscribe(app, cookie, { url: REMOTE_URL, commandId: 'sub-1' })
  expect(created.status).toBe(201)
  // Owner projection only — never the RemoteSource row.
  expect(Object.keys(created.body.subscription).sort()).toEqual(['attributionMode', 'availability', 'sourceId', 'subscriptionState', 'url'])
  expect(created.body.subscription.availability).toBe('available')
  expect(JSON.stringify(created.body)).not.toMatch(/governance|provenance|adminRetained|operation/)
  // No legacy remote-user shadow row was minted.
  expect((await repo.listRemoteUsers()).filter((u) => u.feedUrl === REMOTE_URL)).toHaveLength(0)

  // Replaying the same command id returns the ORIGINAL result verbatim, so it
  // keeps the original 201; a fresh command id against the now-existing
  // subscription is the not-created case → 200.
  expect(await subscribe(app, cookie, { url: REMOTE_URL, commandId: 'sub-1' })).toEqual(created)
  expect(await subscribe(app, cookie, { url: REMOTE_URL, commandId: 'sub-2' })).toEqual({ status: 200, body: created.body })

  // Legacy OPML import needs no header; v2 requires x-rsc-command-id.
  const noHeader = await app.request('/me/follows/opml', { method: 'POST', headers: { cookie }, body: '<opml version="2.0"><body></body></opml>' })
  expect(noHeader.status).toBe(400)
  expect(await noHeader.json()).toEqual({ error: 'commandId invalid' })

  // Public projections come from the v2 tables: legacy would report nothing at
  // all for this user (no `follows` row exists).
  const me = await (await app.request('/me', { headers: { cookie } })).json()
  const follows = await (await app.request(`/users/${me.user.handle}/follows`)).json()
  expect(follows.following).toEqual([{ kind: 'source', sourceId: created.body.subscription.sourceId, url: REMOTE_URL, displayName: '203.0.113.20' }])
  const opml = await app.request(`/users/${me.user.handle}/following.opml`)
  expect(opml.status).toBe(200)
  expect(await opml.text()).toContain(REMOTE_URL)

  // GET /me/following is the owner view (v2-only route).
  const following = await (await app.request('/me/following', { headers: { cookie } })).json()
  expect(Object.keys(following).sort()).toEqual(['localFollows', 'sourceSubscriptions'])
  expect(following.sourceSubscriptions).toEqual([created.body.subscription])
  repo.close()
})

test('a pending subscription answers the neutral payload only — 202 then 200, never the owner projection', async () => {
  const { app, repo } = await makeApp({ v2: true })
  const cookie = await registeredSession(app, 'pending@x.test', repo)
  insertSourceRow(repo.raw, { canonicalUrl: QUARANTINED_URL, governance: 'quarantined' })

  expect(await subscribe(app, cookie, { url: QUARANTINED_URL, commandId: 'pending-1' })).toEqual({
    status: 202,
    body: { subscription: 'pending', message: 'This source is awaiting review.' },
  })
  expect(await subscribe(app, cookie, { url: QUARANTINED_URL, commandId: 'pending-2' })).toEqual({
    status: 200,
    body: { subscription: 'pending', message: 'This source is awaiting review.' },
  })
  repo.close()
})

test('blocked and not-subscribable answer one indistinguishable 409; cap is 429; a malformed URL is 400', async () => {
  const { app, repo, service } = await makeApp({ v2: true })
  const cookie = await registeredSession(app, 'refused@x.test', repo)
  insertSourceRow(repo.raw, { canonicalUrl: BLOCKED_URL, governance: 'blocked' })
  insertSourceRow(repo.raw, { canonicalUrl: AGGREGATE_URL, attributionMode: 'aggregate' })

  const blocked = await subscribe(app, cookie, { url: BLOCKED_URL, commandId: 'r-1' })
  const aggregate = await subscribe(app, cookie, { url: AGGREGATE_URL, commandId: 'r-2' })
  expect(blocked.status).toBe(409)
  expect(aggregate).toEqual(blocked) // a caller cannot tell blocked from never-existed
  // A URL that never existed and was SSRF-refused lands in the same bucket.
  expect(await subscribe(app, cookie, { url: 'http://127.0.0.1/x', commandId: 'r-3' })).toEqual(blocked)

  expect(await subscribe(app, cookie, { url: 'not a url', commandId: 'r-4' })).toEqual({ status: 400, body: { error: 'url invalid' } })

  await service.setSetting('max_subs_per_user', '1')
  expect((await subscribe(app, cookie, { url: 'https://203.0.113.33/f.xml', commandId: 'r-5' })).status).toBe(201)
  const capped = await subscribe(app, cookie, { url: 'https://203.0.113.34/f.xml', commandId: 'r-6' })
  expect(capped.status).toBe(429)
  repo.close()
})

test('an own-instance feed URL still resolves to a local follow under v2', async () => {
  const { app, repo } = await makeApp({ v2: true, publicUrl: PUBLIC_URL })
  const target = await registeredSession(app, 'localtarget@x.test', repo)
  const targetMe = await (await app.request('/me', { headers: { cookie: target } })).json()
  const cookie = await registeredSession(app, 'localfollower@x.test', repo)

  const res = await subscribe(app, cookie, { url: `${PUBLIC_URL}/users/${targetMe.user.handle}/feed.xml`, commandId: 'local-1' })
  expect(res.status).toBe(201)
  expect(res.body.follow).toEqual({ kind: 'local', id: targetMe.user.id, handle: targetMe.user.handle, displayName: targetMe.user.displayName })
  repo.close()
})
