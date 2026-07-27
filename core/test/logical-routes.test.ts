import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { materializeLocalPost } from '../src/logical/local.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { createApp } from '../src/api/app.ts'
import { encodeCursor } from '../src/domain/cursor.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'
import { makeAuth } from './auth-helper.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-23T00:00:00.000Z'
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]

function seedSource(raw: Raw, id: string, url: string): void {
  raw.prepare(`INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at) VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`).run(id, url, NOW)
}
function seedUser(raw: Raw, id: string, handle: string): void {
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES (?, 'local', ?, ?, NULL, ?)`).run(id, handle, handle, NOW)
}
function seedPost(raw: Raw, id: string, author: string, opts: { url?: string | null; at?: string } = {}): void {
  raw.prepare(`INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url, content_markdown, edited_at, reply_context_author, reply_context_snippet) VALUES (?, ?, 'local', ?, NULL, 'c', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`).run(id, author, id, opts.url ?? null, opts.at ?? NOW, opts.at ?? NOW)
}
// White-box remote observation → reconciled logical item.
function seedRemoteItem(raw: Raw, sourceId: string, key: string): void {
  const runId = randomUUID(); const deliveryId = randomUUID(); const versionId = randomUUID(); const jobId = randomUUID()
  const material = { v: 1, keyKind: 'opaque', key, title: 't', content: 'body', link: null, published: '', updated: null, inReplyTo: null, enclosures: [] }
  const canonical = Buffer.from(JSON.stringify(material), 'utf8')
  const fingerprint = createHash('sha256').update(canonical).digest('hex')
  const normalized = JSON.stringify({ keyKind: 'opaque', key, permalink: null, inReplyTo: null, enclosures: [] })
  const rawEvidence = JSON.stringify({ title: 't', sourceName: 'Feed T', link: null, published: '', updated: null, enclosureCount: 0 })
  raw.prepare(`INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json) VALUES (?, ?, 'scheduled', 'terminal', ?, ?, ?, 'parsed', '{}', NULL, NULL, NULL)`).run(runId, sourceId, NOW, NOW, NOW)
  raw.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, 'opaque', ?, ?, ?, ?, 1)`).run(deliveryId, sourceId, key, NOW, NOW, runId)
  raw.prepare(`INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json) VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)`).run(versionId, deliveryId, fingerprint, canonical, NOW, runId, NOW, runId, rawEvidence, normalized)
  raw.prepare(`INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at) VALUES (?, 'observation', ?, ?, NULL, 'pending', 0, ?, NULL, NULL, ?)`).run(jobId, runId, versionId, NOW, NOW)
}

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, store)
  const acquisition = createAcquisition({ db, fetchFn: (async () => new Response('', { status: 200 })) as unknown as typeof fetch, lookupFn: publicLookup, now: () => NOW })
  const app = createApp({
    service, bus, token: 'ops', auth: makeAuth(repo), users: repo, adminEmails: new Set(['boss@x.test']),
    feeds: { publicUrl: 'https://rsc.test', hubUrl: null, rssCloud: false },
    sources: { service: createSourceService(repo, null), repo }, logical: { store, acquisition, now: () => NOW },
  })
  // Local posts flow through store.createLocalPost (materialized) in production;
  // seedPost writes raw, so materialize on demand for the thread/comments projector.
  const materialize = (id: string) => db.write((tx) => materializeLocalPost(tx, id))
  return { app, repo: repo as typeof repo & { raw: Raw }, store, materialize }
}
const drain = (store: ReturnType<typeof createLogicalStore>): number => drainReconciliation({ store, now: () => NOW })

// --- lens parsing: every malformed selector is the same 400 invalid lens ------

test('invalid lens selectors all return 400 {"error":"invalid lens"}', async () => {
  const { app, repo } = await makeApp()
  for (const q of ['?origin=remote', '?federated=false', '?source=local', '?feed_type=instance', '?top_level=1', '?author=a&publisher=p', '?author=', '?author=x&author=y']) {
    const res = await app.request(`/timeline${q}`)
    expect(res.status, q).toBe(400)
    expect(await res.json(), q).toEqual({ error: 'invalid lens' })
  }
  repo.close()
})

test('a malformed / v1 / empty before cursor returns 400 {"error":"invalid cursor"}', async () => {
  const { app, repo } = await makeApp()
  for (const cur of ['not-base64!!', encodeCursor(1, ['only-one']), Buffer.from(JSON.stringify([2, 'a', 'b'])).toString('base64url'), '']) {
    const res = await app.request(`/timeline?before=${encodeURIComponent(cur)}`)
    expect(res.status, cur).toBe(400)
    expect(await res.json(), cur).toEqual({ error: 'invalid cursor' })
  }
  repo.close()
})

test('the public timeline returns the logical-v2 envelope with a journal cursor', async () => {
  const { app, repo } = await makeApp()
  seedUser(repo.raw, 'u1', 'alice')
  seedPost(repo.raw, 'p1', 'u1')
  const res = await app.request('/timeline')
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toMatchObject({ model: 'logical-v2', lens: { kind: 'public' }, nextCursor: null })
  expect(typeof body.journalCursor).toBe('string')
  expect(body.timeline.map((d: { id: string }) => d.id)).toEqual(['p1'])
  repo.close()
})

test('GET /post/:id returns 200 LogicalSingleItemEnvelope for a visible item, 404 otherwise', async () => {
  const { app, repo } = await makeApp()
  seedUser(repo.raw, 'u1', 'alice')
  seedPost(repo.raw, 'p1', 'u1')
  const hit = await app.request('/post/p1')
  expect(hit.status).toBe(200)
  const body = await hit.json()
  expect(body.model).toBe('logical-v2')
  expect(body.item.id).toBe('p1')
  expect(typeof body.journalCursor).toBe('string')
  expect((await app.request('/post/does-not-exist')).status).toBe(404)
  repo.close()
})

test('GET /post/:id/thread and /posts/:id/revisions serve v2 envelopes; unknown ids are 404', async () => {
  const { app, repo, materialize } = await makeApp()
  seedUser(repo.raw, 'u1', 'alice')
  seedPost(repo.raw, 'p1', 'u1')
  materialize('p1')
  const thread = await app.request('/post/p1/thread')
  expect(thread.status).toBe(200)
  expect((await thread.json()).model).toBe('logical-v2')
  const hist = await app.request('/posts/p1/revisions')
  expect(hist.status).toBe(200)
  expect(await hist.json()).toMatchObject({ model: 'logical-v2', origin: 'local' })
  expect((await app.request('/post/nope/thread')).status).toBe(404)
  expect((await app.request('/posts/nope/revisions')).status).toBe(404)
  repo.close()
})

test('an unknown local account or publisher returns the neutral ordinary 404', async () => {
  const { app, repo } = await makeApp()
  expect((await app.request('/timeline?followed_by=ghost')).status).toBe(404)
  expect((await app.request('/timeline?author=ghost')).status).toBe(404)
  expect((await app.request('/timeline?publisher=ghost')).status).toBe(404)
  repo.close()
})

test('a resolved publisher lens returns that publisher activity', async () => {
  const { app, repo, store } = await makeApp()
  seedSource(repo.raw, 's1', 'https://feed.test/f')
  seedRemoteItem(repo.raw, 's1', 'g1')
  drain(store)
  const pubId = (repo.raw.prepare(`SELECT id FROM remote_publishers_v2 LIMIT 1`).get() as { id: string }).id
  const res = await app.request(`/timeline?publisher=${encodeURIComponent(pubId)}`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.lens.kind).toBe('publisher')
  expect(body.timeline.length).toBe(1)
  repo.close()
})

// GONE: 'with the flag off, GET /post/:id does not exist and /timeline keeps the
// v1 shape'. V1 is retired — there is no flag-off composition left to assert.
