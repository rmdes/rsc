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
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { createApp } from '../src/api/app.ts'
import { encodeCursor } from '../src/domain/cursor.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

type Raw = InstanceType<typeof Database>
const OPS_TOKEN = 'ops-token-DEADBEEF'
const NOW = '2026-07-24T00:00:00.000Z'
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const ok = (body: string): Response => new Response(body, { status: 200 })
const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items}</channel></rss>`
const guidItem = (guid: string, body = 'd'): string => `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>${body}</description></item>`

async function makeApp(fetchMap: Record<string, () => Response | Promise<Response>> = {}) {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const bus = createEventBus()
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, store)
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
    logical: { store, acquisition, now: () => NOW },
  })
  return { app, repo, raw, db, store, acquisition }
}

const post = (h: Record<string, string>, body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) })
const drain = (store: ReturnType<typeof createLogicalStore>): number => drainReconciliation({ store, now: () => NOW })

// --- raw seed helpers --------------------------------------------------------
function seedSource(raw: Raw, id: string, url: string, opts: { operation?: string; governance?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', ?, ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, opts.operation ?? 'enabled', opts.governance ?? 'allowed', NOW)
}
function seedRemoteItem(raw: Raw, id: string, opts: { sortAt?: string; tombstone?: number; hiddenAt?: string | null; selDelivery?: string | null; selPublisher?: string | null } = {}): void {
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, hidden_at, structural_tombstone, created_at)
     VALUES (?, 'remote', ?, 'none', NULL, ?, ?, ?, ?, ?)`,
  ).run(id, opts.sortAt ?? NOW, opts.selDelivery ?? null, opts.selPublisher ?? null, opts.hiddenAt ?? null, opts.tombstone ?? 0, NOW)
}
function seedDelivery(raw: Raw, deliveryId: string, sourceId: string, itemId: string, firstSeen = NOW): void {
  raw.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, 'permalink', ?, ?, ?, 'run-x', 1)`).run(deliveryId, sourceId, deliveryId, firstSeen, firstSeen)
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('delivery', ?, ?)`).run(deliveryId, itemId)
}
function seedVersion(raw: Raw, v: { id: string; deliveryId: string; arrivalAt?: string; wireOrdinal?: number; fingerprint?: string; rawEvidence?: string }): void {
  raw.prepare(
    `INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json)
     VALUES (?, ?, 1, ?, ?, ?, 'run-x', ?, ?, 'run-x', 1, ?, '{}')`,
  ).run(v.id, v.deliveryId, v.fingerprint ?? 'fp', Buffer.from('{}'), v.arrivalAt ?? NOW, v.wireOrdinal ?? 0, v.arrivalAt ?? NOW, v.rawEvidence ?? '{}')
}
function seedCheck(raw: Raw, itemId: string, sourceId: string, url: string, state = 'pending', resolvedAt: string | null = null, createdAt = NOW): void {
  raw.prepare(
    `INSERT INTO verification_checks_v2 (id, logical_item_id, source_id, publisher_feed_url, batch_key, state, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), itemId, sourceId, url, url, state, createdAt, resolvedAt)
}
function seedVerJob(raw: Raw, batchKey: string, attempts: number): void {
  raw.prepare(
    `INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, created_at) VALUES (?, 'verification', NULL, NULL, ?, 'pending', ?, ?, ?)`,
  ).run(randomUUID(), batchKey, attempts, NOW, NOW)
}
function seedConflict(raw: Raw, itemId: string | null, kind = 'presentation_rollback', evidence = '{}'): string {
  const id = randomUUID()
  raw.prepare(`INSERT INTO logical_conflicts_v2 (id, logical_item_id, observation_version_id, kind, evidence_json, created_at) VALUES (?, ?, NULL, ?, ?, ?)`).run(id, itemId, kind, evidence, NOW)
  return id
}
function seedDeletedLocal(raw: Raw, id: string): void {
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'local', ?, 'none', NULL, NULL, NULL, ?)`,
  ).run(id, NOW, NOW)
  raw.prepare(`INSERT INTO logical_deleted_local_v2 (logical_item_id, canonical_permalink, deleted_at) VALUES (?, ?, ?)`).run(id, `/post/${id}`, NOW)
}
function seedTombstone(raw: Raw, id: string, url: string, action = 'purge', category = 'abuse', aliases: string[] = []): void {
  raw.prepare(
    `INSERT INTO blocked_source_tombstones_v2 (id, canonical_url, action, category, actor_id, note, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(id, url, action, category, NOW, NOW)
  for (const a of aliases) raw.prepare(`INSERT INTO tombstone_aliases_v2 (url, tombstone_id, created_at) VALUES (?, ?, ?)`).run(a, id, NOW)
}
const remoteIdForSource = (raw: Raw, sourceId: string): string =>
  (raw.prepare(`SELECT ik.logical_item_id AS id FROM logical_identity_keys_v2 ik JOIN deliveries_v2 d ON d.id = ik.key WHERE ik.kind = 'delivery' AND d.source_id = ?`).get(sourceId) as { id: string }).id

// =============================================================================
// mutation routes — disposition mapping
// =============================================================================

test('POST hide: applied 200 with model, one mutation + one audit record across a retry', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(raw, 's1', 'https://feed.test/a')
  seedRemoteItem(raw, 'li-1')
  seedDelivery(raw, 'd1', 's1', 'li-1')

  const res = await app.request('/admin/items/li-1/hide', post({ cookie }, { commandId: 'c1', category: 'spam', note: 'nsfw' }))
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ model: 'logical-v2', kind: 'applied', logicalItemId: 'li-1', hiddenAt: NOW })
  expect((raw.prepare(`SELECT hidden_at FROM logical_items_v2 WHERE id = 'li-1'`).get() as { hidden_at: string | null }).hidden_at).toBe(NOW)

  // identical retry: same 200 body, still ONE audit row (journal counts are the Task 2 suite's).
  const replay = await app.request('/admin/items/li-1/hide', post({ cookie }, { commandId: 'c1', category: 'spam', note: 'nsfw' }))
  expect(replay.status).toBe(200)
  expect((raw.prepare(`SELECT COUNT(*) AS n FROM item_audit_v2 WHERE logical_item_id = 'li-1'`).get() as { n: number }).n).toBe(1)
  repo.close()
})

test('POST hide/restore/purge/unblock: the full disposition map (404 neutral / distinct 409 bodies)', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedRemoteItem(raw, 'li-1')
  seedSource(raw, 's-allowed', 'https://feed.test/allowed', { governance: 'allowed' })
  seedSource(raw, 's-blocked', 'https://feed.test/blocked', { governance: 'blocked' })
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES ('local-1', 'local', ?, 'none', NULL, NULL, NULL, ?)`).run(NOW, NOW)
  seedTombstone(raw, 'tomb-1', 'https://blocked.example/x')

  const j = async (path: string, body: unknown) => { const r = await app.request(path, post({ cookie }, body)); return [r.status, await r.json()] as const }

  // unknown item → neutral 404 (uniform across routes)
  expect(await j('/admin/items/nope/hide', { commandId: 'u1', category: 'spam' })).toEqual([404, { model: 'logical-v2', error: 'item unavailable' }])
  // local origin → 409 (distinct)
  expect(await j('/admin/items/local-1/hide', { commandId: 'lo1', category: 'spam' })).toEqual([409, { model: 'logical-v2', error: 'local origin' }])
  // restore on a visible (non-hidden) item → not applicable 409 (distinct from idempotency)
  expect(await j('/admin/items/li-1/restore', { commandId: 'na1', category: 'false_positive' })).toEqual([409, { model: 'logical-v2', error: 'not applicable' }])
  // purge on an allowed (non-blocked) source → 409
  expect(await j('/admin/sources/s-allowed/purge', { commandId: 'nb1', category: 'abuse' })).toEqual([409, { model: 'logical-v2', error: 'source not blocked' }])
  // purge unknown source → neutral 404
  expect(await j('/admin/sources/nope/purge', { commandId: 'pu1', category: 'abuse' })).toEqual([404, { model: 'logical-v2', error: 'item unavailable' }])
  // purge blocked → 200 purged
  const [ps, pb] = await j('/admin/sources/s-blocked/purge', { commandId: 'pg1', category: 'abuse' })
  expect(ps).toBe(200)
  expect(pb).toMatchObject({ model: 'logical-v2', kind: 'purged' })
  // unblock → 200
  const [us, ub] = await j('/admin/tombstones/tomb-1/unblock', { commandId: 'ub1', category: 'remediated' })
  expect(us).toBe(200)
  expect(ub).toMatchObject({ model: 'logical-v2', kind: 'unblocked' })
  // unblock unknown tombstone → neutral 404
  expect(await j('/admin/tombstones/nope/unblock', { commandId: 'ub2', category: 'remediated' })).toEqual([404, { model: 'logical-v2', error: 'item unavailable' }])
  repo.close()
})

test('a reused commandId with a mismatched fingerprint (changed category) is the idempotency-conflict 409, distinct from the state-conflict bodies', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedRemoteItem(raw, 'li-1')
  const first = await app.request('/admin/items/li-1/hide', post({ cookie }, { commandId: 'c1', category: 'spam' }))
  expect(first.status).toBe(200)
  // same commandId, different category ⇒ fingerprint [hide, item, actor, category] mismatch
  const conflict = await app.request('/admin/items/li-1/hide', post({ cookie }, { commandId: 'c1', category: 'abuse' }))
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({ model: 'logical-v2', error: 'idempotency conflict' })
  repo.close()
})

test('commandId travels only in the JSON body; missing commandId or invalid category is a 400', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedRemoteItem(raw, 'li-1')
  expect((await app.request('/admin/items/li-1/hide', post({ cookie }, { category: 'spam' }))).status).toBe(400)
  expect((await app.request('/admin/items/li-1/hide', post({ cookie }, { commandId: 'c1' }))).status).toBe(400) // category required
  expect((await app.request('/admin/items/li-1/hide', post({ cookie }, { commandId: 'c1', category: 'not-real' }))).status).toBe(400)
  // a commandId header is ignored (not accepted); body still required
  expect((await app.request('/admin/items/li-1/hide', { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-rsc-command-id': 'hdr' }, body: '{"category":"spam"}' })).status).toBe(400)
  // false_positive + remediated (V3 re-added categories) are accepted
  expect((await app.request('/admin/items/li-1/hide', post({ cookie }, { commandId: 'fp1', category: 'false_positive' }))).status).toBe(200)
  repo.close()
})

// =============================================================================
// GET /admin/items/:id — AdminItemDetail
// =============================================================================

test('an ordinary item detail: state, selected, counts, one eligible delivery/version, empty verification', async () => {
  const { app, repo, raw, store, acquisition } = await makeApp({ 'https://feed.test/a': () => ok(RSS(guidItem('g1'))) })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(raw, 's1', 'https://feed.test/a')
  await acquisition.acquireSource('s1', { kind: 'scheduled' })
  drain(store)
  const id = remoteIdForSource(raw, 's1')

  const detail = await (await app.request(`/admin/items/${id}`, { headers: { cookie } })).json()
  expect(detail).toMatchObject({ model: 'logical-v2', logicalItemId: id, origin: 'remote', state: 'ordinary' })
  expect(detail.counts.deliveries).toBe(1)
  expect(detail.deliveries).toHaveLength(1)
  expect(detail.deliveries[0]).toMatchObject({ sourceId: 's1', eligible: true })
  expect(detail.deliveries[0].versions.length).toBeGreaterThanOrEqual(1)
  expect(detail.verification).toEqual([])
  repo.close()
})

test('bounded inline sections cap at 100 newest-first with TRUE totals in counts (101 deliveries → 100 rows, counts.deliveries === 101)', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(raw, 's1', 'https://feed.test/a')
  seedRemoteItem(raw, 'li-1')
  for (let i = 0; i < 101; i++) seedDelivery(raw, `d${String(i).padStart(3, '0')}`, 's1', 'li-1', `2026-07-24T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`)

  const detail = await (await app.request('/admin/items/li-1', { headers: { cookie } })).json()
  expect(detail.counts.deliveries).toBe(101)
  expect(detail.deliveries).toHaveLength(100) // ADMIN_SECTION_CAP
  // newest-first: the 100 returned are the newest by first_seen_at DESC
  const seen = detail.deliveries.map((d: { firstSeenAt: string }) => d.firstSeenAt)
  expect(seen[0] >= seen[99]).toBe(true)
  repo.close()
})

test('state covers all five values', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(raw, 's1', 'https://feed.test/a', { governance: 'quarantined' })
  // ordinary: a real visible item is heavy; here assert the four non-ordinary + one unsupported.
  seedRemoteItem(raw, 'hidden-1', { hiddenAt: NOW })
  seedRemoteItem(raw, 'tomb-1', { tombstone: 1 })
  seedRemoteItem(raw, 'unsupported-1') // remote, no eligible delivery ⇒ unsupported
  seedDeletedLocal(raw, 'deleted-1')

  const stateOf = async (id: string) => (await (await app.request(`/admin/items/${id}`, { headers: { cookie } })).json()).state
  expect(await stateOf('hidden-1')).toBe('hidden')
  expect(await stateOf('tomb-1')).toBe('structural_tombstone')
  expect(await stateOf('unsupported-1')).toBe('unsupported')
  expect(await stateOf('deleted-1')).toBe('deleted_local')
  repo.close()
})

test('an ordinary item reports state ordinary (real pipeline)', async () => {
  const { app, repo, raw, store, acquisition } = await makeApp({ 'https://feed.test/a': () => ok(RSS(guidItem('g1'))) })
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(raw, 's1', 'https://feed.test/a')
  await acquisition.acquireSource('s1', { kind: 'scheduled' })
  drain(store)
  const id = remoteIdForSource(raw, 's1')
  expect((await (await app.request(`/admin/items/${id}`, { headers: { cookie } })).json()).state).toBe('ordinary')
  repo.close()
})

test('raw evidence is bounded escaped text: truncated, returned verbatim (never rendered as HTML by Core)', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(raw, 's1', 'https://feed.test/a')
  seedRemoteItem(raw, 'li-1')
  seedDelivery(raw, 'd1', 's1', 'li-1')
  const longRaw = '<script>alert(1)</script>' + 'A'.repeat(8000)
  seedVersion(raw, { id: 'v1', deliveryId: 'd1', rawEvidence: longRaw })

  const detail = await (await app.request('/admin/items/li-1', { headers: { cookie } })).json()
  const rawEvidence = detail.deliveries[0].versions[0].rawEvidence
  expect(typeof rawEvidence).toBe('string')
  expect(rawEvidence.length).toBe(4096) // ADMIN_RAW_EVIDENCE_CAP
  expect(rawEvidence).toBe(longRaw.slice(0, 4096)) // verbatim prefix — Core returns semantic text; Web escapes
  repo.close()
})

test('verification lists one entry per check with fields, bounded past the cap; [] for an item with no checks', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(raw, 's1', 'https://feed.test/a')
  seedRemoteItem(raw, 'li-1')
  seedRemoteItem(raw, 'li-empty')
  // seed past the cap (101 checks, distinct URLs) …
  for (let i = 0; i < 101; i++) seedCheck(raw, 'li-1', 's1', `https://pub.test/f${i}`, 'pending', null, `2026-07-24T00:01:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`)
  // … plus one NEWEST resolved check (so it survives the newest-first cap) with a
  // batch job carrying attempts
  seedCheck(raw, 'li-1', 's1', 'https://pub.test/feed', 'verified', '2026-07-24T00:00:59.000Z', '2026-07-24T00:05:00.000Z')
  seedVerJob(raw, 'https://pub.test/feed', 3)

  const detail = await (await app.request('/admin/items/li-1', { headers: { cookie } })).json()
  expect(detail.verification).toHaveLength(100) // bounded
  const verified = detail.verification.find((v: { state: string }) => v.state === 'verified')
  expect(verified).toMatchObject({ publisherFeedUrl: 'https://pub.test/feed', state: 'verified', attempts: 3, lastCheckedAt: '2026-07-24T00:00:59.000Z' })

  const empty = await (await app.request('/admin/items/li-empty', { headers: { cookie } })).json()
  expect(empty.verification).toEqual([])
  repo.close()
})

test('GET /admin/items/:id → neutral 404 for an unknown item', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/items/nope', { headers: { cookie } })
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ model: 'logical-v2', error: 'item unavailable' })
  repo.close()
})

// =============================================================================
// paginated reads + tombstones
// =============================================================================

test('GET /admin/items/:id/audit paginates newest-first via the shared codec', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedRemoteItem(raw, 'li-1')
  for (const [i, t] of [['a1', '01'], ['a2', '02'], ['a3', '03']] as const) {
    raw.prepare(`INSERT INTO item_audit_v2 (id, logical_item_id, command_id, actor_id, actor_kind, action, category, note, result_json, created_at) VALUES (?, 'li-1', ?, 'admin', 'administrator', 'hide', 'spam', NULL, '{}', ?)`).run(i, i, `2026-07-24T00:00:${t}.000Z`)
  }
  const p1 = await (await app.request('/admin/items/li-1/audit?limit=2', { headers: { cookie } })).json()
  expect(p1.model).toBe('logical-v2')
  expect(p1.items).toHaveLength(2)
  expect(p1.nextCursor).toEqual(expect.any(String))
  const p2 = await (await app.request(`/admin/items/li-1/audit?limit=2&before=${encodeURIComponent(p1.nextCursor)}`, { headers: { cookie } })).json()
  expect(p2.items).toHaveLength(1)
  expect(p2.nextCursor).toBeNull()
  repo.close()
})

test('GET /admin/sources/:id/items paginates + carries the TRUE source-level conflictCount', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(raw, 's1', 'https://feed.test/a')
  for (const [i, t] of [['it1', '01'], ['it2', '02'], ['it3', '03']] as const) {
    seedRemoteItem(raw, i, { sortAt: `2026-07-24T00:00:${t}.000Z` })
    seedDelivery(raw, `d-${i}`, 's1', i)
  }
  seedConflict(raw, 'it1')
  seedConflict(raw, 'it2')

  const p1 = await (await app.request('/admin/sources/s1/items?limit=2', { headers: { cookie } })).json()
  expect(p1.model).toBe('logical-v2')
  expect(p1.items).toHaveLength(2)
  expect(p1.nextCursor).toEqual(expect.any(String))
  expect(p1.conflictCount).toBe(2) // true count across ALL the source's items, not just the page
  expect(p1.items[0]).toMatchObject({ logicalItemId: 'it3', state: expect.any(String), timelineSortAt: expect.any(String) })
  const p2 = await (await app.request(`/admin/sources/s1/items?limit=2&before=${encodeURIComponent(p1.nextCursor)}`, { headers: { cookie } })).json()
  expect(p2.items).toHaveLength(1)
  expect(p2.nextCursor).toBeNull()
  const ids = [...p1.items, ...p2.items].map((r: { logicalItemId: string }) => r.logicalItemId)
  expect(new Set(ids).size).toBe(3)
  repo.close()
})

// The shared invalid-cursor test table (VP7): every entry 400s with the neutral body.
const INVALID_CURSORS = ['', '@@bogus@@', 'not-base64!!', encodeCursor(1, ['only-one']), Buffer.from(JSON.stringify([2, 'a', 'b'])).toString('base64url')]

test('every invalid pagination cursor returns 400 {model,error:invalid cursor} on both paged review routes', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(raw, 's1', 'https://feed.test/a')
  seedRemoteItem(raw, 'li-1')
  for (const bad of INVALID_CURSORS) {
    const q = `before=${encodeURIComponent(bad)}`
    const audit = await app.request(`/admin/items/li-1/audit?${q}`, { headers: { cookie } })
    expect([bad, audit.status]).toEqual([bad, 400])
    expect(await audit.json()).toEqual({ model: 'logical-v2', error: 'invalid cursor' })
    const items = await app.request(`/admin/sources/s1/items?${q}`, { headers: { cookie } })
    expect([bad, items.status]).toEqual([bad, 400])
    expect(await items.json()).toEqual({ model: 'logical-v2', error: 'invalid cursor' })
  }
  repo.close()
})

test('GET /admin/tombstones lists TombstoneView[] unpaginated with aliases', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedTombstone(raw, 'tomb-1', 'https://a.example/feed', 'purge', 'abuse', ['https://a.example/alias1', 'https://a.example/alias2'])
  seedTombstone(raw, 'tomb-2', 'https://b.example/feed', 'block', 'spam')
  const body = await (await app.request('/admin/tombstones', { headers: { cookie } })).json()
  expect(body.model).toBe('logical-v2')
  expect(body.tombstones).toHaveLength(2)
  const t1 = body.tombstones.find((t: { id: string }) => t.id === 'tomb-1')
  expect(t1).toMatchObject({ canonicalUrl: 'https://a.example/feed', action: 'purge', category: 'abuse' })
  expect(t1.aliases.sort()).toEqual(['https://a.example/alias1', 'https://a.example/alias2'])
  repo.close()
})

// =============================================================================
// authz / redaction matrix (spec §7.3)
// =============================================================================

test('every V3 review route answers [401,403,403,200] for [none,anon,registered,admin]; a bearer token is 401', async () => {
  const { app, repo, raw } = await makeApp()
  const adminCookie = await registeredSession(app, 'boss@x.test', repo)
  seedRemoteItem(raw, 'hide-item')
  seedRemoteItem(raw, 'restore-item', { hiddenAt: NOW }) // pre-hidden so admin restore → 200
  seedSource(raw, 's-items', 'https://feed.test/items')
  seedSource(raw, 's-blocked', 'https://feed.test/blocked', { governance: 'blocked' })
  seedTombstone(raw, 'tomb-authz', 'https://tomb.example/x')

  const actors: Array<[string, Record<string, string>]> = [
    ['none', {}],
    ['anon', { cookie: await anonSession(app) }],
    ['registered', { cookie: await registeredSession(app, 'peon@x.test', repo) }],
    ['admin', { cookie: adminCookie }],
  ]
  const key = (h: Record<string, string>) => (h.cookie ? h.cookie.slice(0, 8) : 'none')
  const routes: Record<string, (h: Record<string, string>) => Response | Promise<Response>> = {
    hide: (h) => app.request('/admin/items/hide-item/hide', post(h, { commandId: `hide-${key(h)}`, category: 'spam' })),
    restore: (h) => app.request('/admin/items/restore-item/restore', post(h, { commandId: `restore-${key(h)}`, category: 'false_positive' })),
    purge: (h) => app.request('/admin/sources/s-blocked/purge', post(h, { commandId: `purge-${key(h)}`, category: 'abuse' })),
    unblock: (h) => app.request('/admin/tombstones/tomb-authz/unblock', post(h, { commandId: `unblock-${key(h)}`, category: 'remediated' })),
    detail: (h) => app.request('/admin/items/hide-item', { headers: h }),
    audit: (h) => app.request('/admin/items/hide-item/audit', { headers: h }),
    sourceItems: (h) => app.request('/admin/sources/s-items/items', { headers: h }),
    tombstones: (h) => app.request('/admin/tombstones', { headers: h }),
  }
  const expected = [401, 403, 403, 200]
  for (const [name, run] of Object.entries(routes)) {
    const statuses: number[] = []
    for (const [, h] of actors) statuses.push((await run(h)).status)
    expect([name, statuses]).toEqual([name, expected])
  }
  // a request bearing ONLY the ops token has no better-auth session → 401 (before requireAdmin)
  const bearer = await app.request('/admin/items/hide-item/hide', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OPS_TOKEN}` }, body: '{"commandId":"bt","category":"spam"}' })
  expect(bearer.status).toBe(401)
  const bearerGet = await app.request('/admin/tombstones', { headers: { authorization: `Bearer ${OPS_TOKEN}` } })
  expect(bearerGet.status).toBe(401)
  repo.close()
})

test('no review body carries the ops token (list, detail, error, audit, ledger-replay)', async () => {
  const { app, repo, raw } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  seedSource(raw, 's1', 'https://feed.test/a')
  seedRemoteItem(raw, 'li-1')
  seedDelivery(raw, 'd1', 's1', 'li-1')
  seedTombstone(raw, 'tomb-1', 'https://a.example/feed', 'purge', 'abuse', ['https://a.example/alias1'])
  await app.request('/admin/items/li-1/hide', post({ cookie }, { commandId: 'c1', category: 'spam' }))

  const bodies = await Promise.all([
    (await app.request('/admin/items/li-1', { headers: { cookie } })).text(),
    (await app.request('/admin/items/li-1/audit', { headers: { cookie } })).text(),
    (await app.request('/admin/sources/s1/items', { headers: { cookie } })).text(),
    (await app.request('/admin/tombstones', { headers: { cookie } })).text(),
    (await app.request('/admin/items/nope', { headers: { cookie } })).text(), // error
    (await app.request('/admin/items/li-1/hide', post({ cookie }, { commandId: 'c1', category: 'spam' }))).text(), // ledger replay
  ])
  for (const body of bodies) for (const secret of [OPS_TOKEN, `Bearer ${OPS_TOKEN}`]) expect(body).not.toContain(secret)
  repo.close()
})
