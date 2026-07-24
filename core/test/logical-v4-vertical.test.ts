import { test, expect, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourcePlane } from '../src/domain/source-service.ts'
import { createPushIn } from '../src/domain/push-in.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalRuntime, compose, assertLegacyStartupAllowed } from '../src/logical/runtime.ts'
import { createApp } from '../src/api/app.ts'
import { mountLogicalHandleRoute } from '../src/api/logical-routes.ts'
import { loadConfig } from '../src/config.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

// V4 Task 10 — THE VERTICAL GATE. Two halves, and neither of them re-proves what
// a per-task suite already owns.
//
// PART A (spec §11 "Off-flag regression", WP3) is GATE ASSERTIONS ONLY: with the
// flag off the v1 branch is what answers, the V4 surfaces are absent, and nothing
// converts. The behavioral coverage stays where it is — push-in.test.ts and
// push-guard.test.ts for legacy push, the legacy ingest/feed/timeline suites for
// the rest. Duplicating them here would only give §7's retirement release a
// second file to delete.
//
// What Part A deliberately does NOT assert: that no V4 module is LOADED. That is
// not a true property of the v1 branch and never was —
// `domain/source-repository.ts` statically imports the v2 logical modules (V3
// execution handoff item 3), and the §4.3 tripwire runs ON the flag-off path by
// design, dynamically importing `logical/runtime.ts` and with it the migration
// modules (Task 8 plan correction 4). Isolation here is ROUTING and BEHAVIOR: what
// answers a request, and what is written to the database.
//
// PART B (runbook §8 step 6) asserts COMPOSITION only: a representative legacy
// instance flips on, starts, and one pass through the operator's verify list
// composes end to end. Field-level correctness of every converted output is
// already pinned by Tasks 5-8 (migration-convert / migration-cutover /
// source-admin-api / logical-push-callbacks) and is not re-asserted here.

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'
const LEGACY_AT = '2026-01-01T00:00:00.000Z'
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
// Comfortably inside every renewal horizon, so no sweep ever calls a hub here.
const LIVE_UNTIL = new Date(Date.now() + 30 * 86_400_000).toISOString()

const count = (raw: Raw, table: string, where = ''): number =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n

const RSS = (items = ''): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`
const item = (guid: string, body = 'd'): string =>
  `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>${body}</description></item>`
const sign = (body: string, secret: string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

const routedFetch = (map: Record<string, string>): typeof fetch => (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const body = map[url]
  if (body === undefined) return new Response('not found', { status: 404 })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
}) as unknown as typeof fetch

// =============================================================================
// PART A — off-flag gate assertions
// =============================================================================

const OFF_ENV = { RSC_TOKEN: 'ops-token', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://rsc.test', RSC_POLL_SECONDS: '9999' }
const V1_WEBSUB_FEED = 'https://blog.test/f.xml'
const V1_CLOUD_FEED = 'https://cloud.test/f.xml'

function seedLegacyPush(raw: Raw, row: Record<string, string | null>): void {
  raw.prepare(
    `INSERT INTO push_subscriptions (id, user_id, mode, endpoint, topic, callback_token, secret, state, expires_at, created_at)
     VALUES (@id, @user_id, @mode, @endpoint, @topic, @callback_token, @secret, @state, @expires_at, @created_at)`,
  ).run({ secret: null, state: 'pending', expires_at: LIVE_UNTIL, created_at: LEGACY_AT, ...row })
}

// The flag-off composition, assembled exactly as server.ts's disabled branch does:
// the §4.3 tripwire first, then `compose`, then the v1 push-in handlers behind the
// four public callback routes. No `sources`, no `logical` — that is the whole
// difference, and everything Part A asserts follows from it.
async function offFlagApp(seed?: (raw: Raw) => void | Promise<void>) {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const config = loadConfig(OFF_ENV) // RSC_SOURCE_MODEL_V2 unset: the flag-off posture
  if (seed) await seed(raw)

  assertLegacyStartupAllowed(raw)
  const act = raw.prepare(`SELECT state FROM logical_activation_v2 WHERE singleton = 1`).get() as { state: string } | undefined
  if (act?.state === 'active') raw.prepare(`UPDATE logical_activation_v2 SET state = 'reconciliation_required' WHERE singleton = 1`).run()
  const workers = compose({ sourceModelV2: false, runtime: null })
  expect(workers).toEqual({ legacyPoll: true, legacyPushIn: true })

  const bus = createEventBus()
  const pushIn = createPushIn({ repo, config, fetchFn: routedFetch({ [V1_CLOUD_FEED]: RSS(item('g-cloud')) }), lookupFn: publicLookup })
  const app = createApp({
    service: createService(repo, bus, config.publicUrl), // no logical store: the OFF path
    bus,
    token: config.token,
    auth: makeAuth(repo),
    users: repo,
    adminEmails: new Set(['boss@x.test']),
    feeds: { publicUrl: config.publicUrl, hubUrl: null, rssCloud: false },
    pushIn: config.pushIn,
    pushInApi: workers.legacyPushIn
      ? {
          websubVerify: (token: string, query: Record<string, string>) => pushIn.handleWebSubVerification(token, query),
          websubDeliver: (token: string, body: string, signature: string | null) => pushIn.handleFatPing(token, body, signature, { bus }),
          rsscloudChallenge: (url: string, challenge: string) => pushIn.handleRssCloudChallenge(url, challenge),
          rsscloudPing: (url: string) => pushIn.handleThinPing(url, { bus }),
        }
      : undefined,
  })
  return { repo, raw, app }
}

test('OFF: the four callback routes dispatch to the V1 push-in handlers, and nothing v2 is written', async () => {
  const { repo, raw, app } = await offFlagApp()
  // The two remote feeds the legacy handlers resolve tokens/topics against.
  const blog = await repo.createRemoteUser({ handle: 'blog', displayName: 'Blog', feedUrl: V1_WEBSUB_FEED })
  const cloud = await repo.createRemoteUser({ handle: 'cloudy', displayName: 'Cloudy', feedUrl: V1_CLOUD_FEED })
  seedLegacyPush(raw, { id: 'ps-w', user_id: blog.id, mode: 'websub', endpoint: 'https://hub.test/hub', topic: V1_WEBSUB_FEED, callback_token: 'v1-token', secret: 'v1-secret', state: 'pending' })
  seedLegacyPush(raw, { id: 'ps-c', user_id: cloud.id, mode: 'rsscloud', endpoint: 'http://cloud.test:5337/rsscloud/pleaseNotify', topic: V1_CLOUD_FEED, callback_token: 'v1-cloud-token', state: 'active' })

  // (1) WebSub verification GET. The token exists ONLY in the legacy table, so a
  // 200 + activated legacy row can only be the v1 handler answering.
  const verify = await app.request(`/websub/callback/v1-token?hub.mode=subscribe&hub.topic=${encodeURIComponent(V1_WEBSUB_FEED)}&hub.challenge=xyz`)
  expect(verify.status).toBe(200)
  expect(await verify.text()).toBe('xyz')
  expect(raw.prepare(`SELECT state FROM push_subscriptions WHERE id = 'ps-w'`).get()).toEqual({ state: 'active' })

  // (2) Fat ping: the v1 handler ingests into the LEGACY posts table.
  const body = RSS(item('g-v1'))
  const fat = await app.request('/websub/callback/v1-token', {
    method: 'POST', headers: { 'x-hub-signature': sign(body, 'v1-secret') }, body,
  })
  expect(fat.status).toBe(202)
  expect(count(raw, 'posts', `WHERE author_id = '${blog.id}' AND guid = 'g-v1'`)).toBe(1)

  // (3) rssCloud challenge: known legacy topic confirms.
  const challenge = await app.request(`/rsscloud/notify?url=${encodeURIComponent(V1_CLOUD_FEED)}&challenge=c1`)
  expect(challenge.status).toBe(200)
  expect(await challenge.text()).toBe('confirming c1')

  // (4) Thin ping: v1 re-fetches the STORED legacy feed url (fire-and-forget) and
  // ingests through the legacy path. The v2 handler would have found no v2 row and
  // returned the same neutral 200 without fetching — the ingested row is the tell.
  const thin = await app.request('/rsscloud/notify', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ url: V1_CLOUD_FEED }).toString(),
  })
  expect(thin.status).toBe(200)
  await vi.waitFor(() => expect(count(raw, 'posts', `WHERE author_id = '${cloud.id}' AND guid = 'g-cloud'`)).toBe(1))

  // …and not one v2 row exists after all four.
  for (const t of ['push_subscriptions_v2', 'acquisition_runs_v2', 'deliveries_v2', 'logical_items_v2', 'remote_sources_v2', 'logical_journal_v2']) {
    expect([t, count(raw, t)]).toEqual([t, 0])
  }
  repo.close()
})

test('OFF: the ops route and every V4 admin field are absent', async () => {
  const { repo, app } = await offFlagApp()
  // An ADMIN session, so a 404 can only mean the route is absent: the /admin/*
  // gate answers 401 first for anyone else.
  const cookie = await registeredSession(app, 'boss@x.test', repo)

  // `SourceSummary.push` and `SourceDetail.pushExpiresAt` (V4 Task 1/3) are
  // reachable through exactly these two routes, and both live inside the v2 branch.
  for (const path of ['/admin/sources', '/admin/sources/u1']) {
    const res = await app.request(path, { headers: { cookie } })
    expect([path, res.status]).toEqual([path, 404])
  }

  // The ops-token compatibility route exists only under v2 — a VALID bearer 404s.
  const ops = await app.request('/ops/sources/federation', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ops-token' },
    body: JSON.stringify({ url: 'https://peer.test/f.xml', attributionMode: 'aggregate', category: 'operator_policy', note: 'peer', commandId: 'c1' }),
  })
  expect(ops.status).toBe(404)

  // The capability web reads once and memoizes still says legacy.
  expect(await (await app.request('/capabilities')).json()).toEqual({ sourceModelV2: false })
  repo.close()
})

test('OFF: preflight and conversion never run — no activation, no marker, no v2 row', async () => {
  const legacy = (raw: Raw): void => {
    raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at, feed_type) VALUES ('l1', 'local', 'localuser', 'Local', NULL, ?, NULL)`).run(LEGACY_AT)
    raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at, feed_type) VALUES ('u1', 'remote', 'alice', 'Alice', 'https://a.test/feed.xml', ?, 'person')`).run(LEGACY_AT)
    raw.prepare(`INSERT INTO follows (follower_id, followed_id, created_at) VALUES ('l1', 'u1', ?)`).run(LEGACY_AT)
  }
  const { repo, raw } = await offFlagApp(legacy)

  // Conversion is flag-triggered and marker-guarded: the v1 branch runs neither it
  // nor preflight, so a legacy-only database stays legacy-only.
  expect(raw.prepare(`SELECT state, converted_at, conversion_findings_json FROM logical_activation_v2 WHERE singleton = 1`).get())
    .toEqual({ state: 'never_activated', converted_at: null, conversion_findings_json: null })
  for (const t of ['remote_sources_v2', 'remote_publishers_v2', 'source_subscriptions_v2', 'handle_reservations_v2', 'logical_items_v2', 'logical_journal_v2', 'push_subscriptions_v2', 'source_audit_v2']) {
    expect([t, count(raw, t)]).toEqual([t, 0])
  }
  // …and the legacy rows are exactly as seeded.
  expect(count(raw, 'users')).toBe(2)
  expect(count(raw, 'follows')).toBe(1)
  repo.close()
})

// =============================================================================
// PART B — the on-flag whole-vertical composition (runbook §8 step 6)
// =============================================================================

// A representative legacy instance: every feed_type, a manifest-approved instance
// beside an unconfirmed one, an over-cap follower, resolved and unresolved reply
// references, revisions, and all four push-row fates.
const U1_FEED_LEGACY = 'https://A.test:443/feed.xml' // normalizes to https://a.test/feed.xml
const U1_FEED = 'https://a.test/feed.xml'
const U2_FEED = 'https://blog.test/f.xml'
const U3_FEED = 'https://peer.test/f.xml'
const U4_FEED = 'https://other.test/f.xml'
const HUB = 'https://hub.test/hub'
const SOURCE_IDS = ['u1', 'u2', 'u3', 'u4']

const USER_COLS = `id, kind, handle, display_name, feed_url, created_at, feed_type`
const POST_COLS = `id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url, content_markdown, edited_at, reply_context_author, reply_context_snippet`

function seedRepresentativeLegacy(raw: Raw): void {
  const user = raw.prepare(`INSERT INTO users (${USER_COLS}) VALUES (@id, @kind, @handle, @display_name, @feed_url, @created_at, @feed_type)`)
  const post = raw.prepare(`INSERT INTO posts (${POST_COLS}) VALUES (@id, @author_id, @source, @guid, @title, @content, @url, @published_at, @created_at, @in_reply_to, @in_reply_to_post_id, @thread_root_id, @source_name, @source_feed_url, @content_markdown, @edited_at, @reply_context_author, @reply_context_snippet)`)
  const follow = raw.prepare(`INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)`)
  const local = (id: string, handle: string) => user.run({ id, kind: 'local', handle, display_name: handle, feed_url: null, created_at: LEGACY_AT, feed_type: null })
  const remote = (id: string, handle: string, feed_url: string, feed_type: string) =>
    user.run({ id, kind: 'remote', handle, display_name: handle, feed_url, created_at: LEGACY_AT, feed_type })
  const remotePost = (over: Record<string, string | null>) =>
    post.run({
      source: 'remote', title: 'Title', content: '<p>body</p>', created_at: over.published_at ?? LEGACY_AT,
      in_reply_to: null, in_reply_to_post_id: null, thread_root_id: null, source_name: null, source_feed_url: null,
      content_markdown: null, edited_at: null, reply_context_author: null, reply_context_snippet: null, ...over,
    })

  local('l1', 'localuser')
  local('l2', 'otherlocal')
  remote('u1', 'alice', U1_FEED_LEGACY, 'person')
  remote('u2', 'blog', U2_FEED, 'webfeed')
  remote('u3', 'peer', U3_FEED, 'instance')   // manifest-approved below
  remote('u4', 'unknownpeer', U4_FEED, 'instance') // unconfirmed → quarantined

  // l1 follows all four; the cap is dropped to 3 below, so l1 is grandfathered.
  for (const id of SOURCE_IDS) follow.run('l1', id, LEGACY_AT)
  follow.run('l2', 'u1', LEGACY_AT)
  raw.prepare(`UPDATE instance_settings SET value = '3' WHERE key = 'max_subs_per_user'`).run()

  remotePost({ id: 'p1', author_id: 'u1', guid: 'g1', url: 'https://a.test/post/1', published_at: '2026-02-01T00:00:00.000Z' })
  remotePost({ id: 'p2', author_id: 'u1', guid: 'g2', url: 'https://a.test/post/2', published_at: '2026-02-02T00:00:00.000Z', in_reply_to: 'https://a.test/post/1', in_reply_to_post_id: 'p1', thread_root_id: 'p1' })
  remotePost({ id: 'p3', author_id: 'u3', guid: 'g3', url: 'https://peer.test/post/3', published_at: '2026-02-03T00:00:00.000Z', in_reply_to: 'https://elsewhere.test/gone' })
  remotePost({ id: 'p4', author_id: 'u3', guid: 'g4', url: 'https://peer.test/post/4', published_at: '2026-02-04T00:00:00.000Z' })
  remotePost({ id: 'p5', author_id: 'u2', guid: 'g5', url: 'https://blog.test/post/5', published_at: '2026-02-05T00:00:00.000Z' })
  remotePost({ id: 'p6', author_id: 'u4', guid: 'g6', url: 'https://other.test/post/6', published_at: '2026-02-06T00:00:00.000Z' })
  // one edit history, so the presentation chain converts with it
  raw.prepare(`INSERT INTO post_revisions (id, post_id, title, content, content_markdown, seen_at) VALUES ('r1', 'p1', 'Title', '<p>older body</p>', NULL, ?)`).run('2026-02-01T00:00:00.000Z')

  // all four push fates on four different sources
  seedLegacyPush(raw, { id: 'ps1', user_id: 'u1', mode: 'websub', endpoint: HUB, topic: U1_FEED_LEGACY, callback_token: 'legacy-token', secret: 'legacy-secret', state: 'active' })
  seedLegacyPush(raw, { id: 'ps2', user_id: 'u2', mode: 'rsscloud', endpoint: 'http://blog.test:5337/rsscloud/pleaseNotify', topic: U2_FEED, callback_token: 'legacy-cloud', state: 'pending' })
  seedLegacyPush(raw, { id: 'ps3', user_id: 'u3', mode: 'websub', endpoint: HUB, topic: U3_FEED, callback_token: 'dead-token', secret: 's3', state: 'active', expires_at: LEGACY_AT })
  seedLegacyPush(raw, { id: 'ps4', user_id: 'u4', mode: 'websub', endpoint: 'http://127.0.0.1:9/hub', topic: U4_FEED, callback_token: 'bad-token', secret: 's4', state: 'active' })
}

function manifestPath(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'rsc-v4-vertical-')), 'manifest.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    entries: [{ sourceId: 'u3', feedUrl: U3_FEED, attributionMode: 'aggregate', note: 'reviewed peer' }],
  }))
  return path
}

// Flip on and START: the real runtime runs THE cutover inside its one pre-listen
// activation transaction, and the app is composed over it exactly as server.ts
// composes it under v2 (push callbacks from runtime.push, the source plane, the
// logical routes, the reserved-handle lookup).
async function cutOver() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  seedRepresentativeLegacy(raw)

  const config = loadConfig({
    RSC_TOKEN: 'ops-token', RSC_AUTH_SECRET: 's', RSC_SOURCE_MODEL_V2: 'on',
    RSC_PUBLIC_URL: 'https://rsc.test', RSC_POLL_SECONDS: '9999', RSC_MIGRATION_MANIFEST: manifestPath(),
  })
  const bus = createEventBus()
  // Every converted source is schedulable the moment conversion commits, so the
  // startup poll pass fetches all four. They answer with an empty channel: paced
  // acquisition resuming is the subject, not what it finds.
  const fetchFn = routedFetch(Object.fromEntries([U1_FEED, U2_FEED, U3_FEED, U4_FEED].map((u) => [u, RSS()])))
  const acquisition = createAcquisition({ db, fetchFn, lookupFn: publicLookup, now: () => NOW })
  const runtime = createLogicalRuntime({
    db, store, acquisition, config, now: () => NOW,
    notify: (sequence) => bus.emitSequenceHint(sequence), fetchFn, lookupFn: publicLookup,
  })
  await runtime.ready // THE cutover: preflight + conversion + activation, pre-listen
  await runtime.stop()
  expect(compose({ sourceModelV2: true, runtime })).toEqual({ legacyPoll: false, legacyPushIn: false })

  const app = createApp({
    service: createService(repo, bus, config.publicUrl, store),
    bus,
    token: config.token,
    auth: makeAuth(repo),
    users: repo,
    adminEmails: new Set(['boss@x.test']),
    feeds: { publicUrl: config.publicUrl, hubUrl: null, rssCloud: false },
    pushIn: config.pushIn,
    sources: createSourcePlane(repo, config.publicUrl, store),
    logical: { store, acquisition: runtime.acquisition, now: () => NOW },
    pushInApi: {
      websubVerify: (token: string, query: Record<string, string>) => runtime.push.websubVerify(token, query),
      websubDeliver: (token: string, body: string, signature: string | null) => runtime.push.websubDeliver(token, body, signature),
      rsscloudChallenge: (url: string, challenge: string) => runtime.push.rsscloudChallenge(url, challenge),
      rsscloudPing: (url: string) => runtime.push.rsscloudPing(url),
    },
  })
  mountLogicalHandleRoute(app, { raw })
  return { repo, raw, store, app }
}

test('ON: one pass through the runbook step-6 verify list composes end to end', async () => {
  const { repo, raw, store, app } = await cutOver()

  // (1) /capabilities reports the enabled v2 shape — the flip an already-deployed
  // web observes on its next capability read, with no redeploy.
  expect(await (await app.request('/capabilities')).json()).toEqual({
    sourceModelV2: true, model: 'logical-v2', journalCursorVersion: 1, streamProtocolVersion: 1,
  })

  // (2) the SSR timeline renders converted items: the public river carries every
  // root from an ALLOWED source (u1 person, u2 webfeed, u3 manifest-approved) and
  // nothing from the quarantined instance u4. p2 is a resolved reply, so the river
  // drops it exactly as it drops any reply.
  const timeline = await app.request('/timeline')
  expect(timeline.status).toBe(200)
  const river = await timeline.json() as { timeline: { id: string; selectedAuthor: { displayName: string } }[] }
  expect(river.timeline.map((i) => i.id).sort()).toEqual(['p1', 'p3', 'p4', 'p5'])
  // Display names fall back to the feed hostname until the first post-cutover
  // reconcile writes publisher_names_v2 — the documented, self-healing cutover
  // artifact (RUNNING.md, "Known cutover artifacts").
  expect(river.timeline.find((i) => i.id === 'p1')!.selectedAuthor.displayName).toBe('a.test')

  // (3) every pre-cutover permalink resolves to the SAME id.
  const perma = await app.request('/post/p1')
  expect(perma.status).toBe(200)
  expect(await perma.json()).toMatchObject({ model: 'logical-v2', item: { id: 'p1', origin: 'remote' } })

  // (4) the reserved-handle redirect data web's /u/:handle asks for, and a
  // publisher page that actually resolves behind it.
  const lookup = await app.request('/handles/peer')
  expect(lookup.status).toBe(200)
  const reserved = await lookup.json() as { reserved: boolean; publisherId: string }
  expect(reserved.reserved).toBe(true)
  const publisher = await app.request(`/timeline?publisher=${encodeURIComponent(reserved.publisherId)}`)
  expect(publisher.status).toBe(200)
  expect((await publisher.json() as { timeline: { id: string }[] }).timeline.map((i) => i.id).sort()).toEqual(['p3', 'p4'])

  // (5) the marker's per-kind finding counts are sane: every legacy feed_type
  // landed on its intended outcome, the over-cap follower is grandfathered, the
  // unresolvable reply is counted, and all four push fates are accounted for.
  const marker = raw.prepare(`SELECT converted_at, conversion_findings_json FROM logical_activation_v2 WHERE singleton = 1`).get() as { converted_at: string; conversion_findings_json: string }
  expect(marker.converted_at).toBe(NOW)
  const counts = JSON.parse(marker.conversion_findings_json) as Record<string, number>
  expect(counts).toEqual({
    default_person: 1, default_webfeed: 1, manifest_approved: 1, instance_quarantined: 1,
    attribution_conflict: 0, unresolved_reference: 1, permalink_collision: 0, guid_collision: 0,
    push_preserved: 2, push_expired: 1, push_invalid: 1, over_cap_grandfathered: 1,
  })

  // (6) the admin source page shows the PRESERVED push state (the runbook's check).
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const detail = await (await app.request('/admin/sources/u1', { headers: { cookie } })).json() as {
    push: { mode: string; state: string; endpointFingerprint: string }; pushExpiresAt: string
  }
  expect(detail.push).toEqual({ mode: 'websub', state: 'active', endpointFingerprint: createHash('sha256').update(HUB).digest('hex').slice(0, 16) })
  expect(detail.pushExpiresAt).toBe(LIVE_UNTIL)
  expect(JSON.stringify(detail)).not.toContain('legacy-secret') // tokens/secrets never leave

  // (7) fat-ping lease continuity, through the real public route: the hub's next
  // delivery is signed with the LEGACY secret and addressed to the LEGACY callback
  // token, and it ingests without any re-subscription.
  const body = RSS(item('g-push'))
  const ping = await app.request('/websub/callback/legacy-token', {
    method: 'POST', headers: { 'x-hub-signature': sign(body, 'legacy-secret') }, body,
  })
  expect(ping.status).toBe(202)
  expect(count(raw, 'acquisition_runs_v2', `WHERE source_id = 'u1' AND delivery_mechanism = 'push'`)).toBe(1)
  expect(count(raw, 'deliveries_v2', `WHERE key = 'g-push'`)).toBe(1)

  // (8) paced acquisition resumed after commit for the enabled allowed AND enabled
  // quarantined sources — the poll pass the startup tick already ran over all four.
  expect(store.listSchedulableSources().sort()).toEqual(SOURCE_IDS)
  // Health is recorded by the scheduler's poll pass alone, so a lastPollAt on all
  // four is the proof that the loop resumed over the converted sources.
  for (const id of SOURCE_IDS) await vi.waitFor(() => expect([id, store.getHealth(id)?.lastPollAt]).toEqual([id, NOW]))
  repo.close()
})
