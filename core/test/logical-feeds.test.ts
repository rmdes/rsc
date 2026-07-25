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
import type { LookupFn } from '../src/domain/push-guard.ts'
import { makeAuth } from './auth-helper.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-23T00:00:00.000Z'
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]

function seedUser(raw: Raw, id: string, handle: string): void {
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES (?, 'local', ?, ?, NULL, ?)`).run(id, handle, handle, NOW)
}
function seedPost(raw: Raw, p: { id: string; author: string; content: string; url?: string | null; replyTo?: string | null; threadRoot?: string | null; at?: string }): void {
  raw.prepare(`INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url, content_markdown, edited_at, reply_context_author, reply_context_snippet) VALUES (?, ?, 'local', ?, NULL, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`).run(p.id, p.author, p.id, p.content, p.url ?? null, p.at ?? NOW, p.at ?? NOW, p.replyTo ?? null, p.threadRoot ?? null)
}
function seedRemoteItem(raw: Raw, sourceId: string, url: string, key: string, content: string): void {
  raw.prepare(`INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at) VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`).run(sourceId, url, NOW)
  const runId = randomUUID(); const deliveryId = randomUUID(); const versionId = randomUUID(); const jobId = randomUUID()
  const material = { v: 1, keyKind: 'opaque', key, title: 't', content, link: null, published: '', updated: null, inReplyTo: null, enclosures: [] }
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
  const service = createService(repo, bus, null)
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const acquisition = createAcquisition({ db, fetchFn: (async () => new Response('', { status: 200 })) as unknown as typeof fetch, lookupFn: publicLookup, now: () => NOW })
  const app = createApp({
    service, bus, token: 'ops', auth: makeAuth(repo), users: repo, adminEmails: new Set(),
    feeds: { publicUrl: 'https://rsc.test', hubUrl: null, rssCloud: false },
    sources: { service: createSourceService(repo, null), repo }, logical: { store, acquisition, now: () => NOW },
  })
  const materialize = (...ids: string[]) => db.write((tx) => { for (const id of ids) materializeLocalPost(tx, id) }) // parent-before-child order
  return { app, repo: repo as typeof repo & { raw: Raw }, store, materialize }
}
const drain = (store: ReturnType<typeof createLogicalStore>): number => drainReconciliation({ store, now: () => NOW })

function tree(raw: Raw): void {
  seedUser(raw, 'u1', 'alice')
  seedPost(raw, { id: 'root', author: 'u1', content: 'ROOTBODY', url: 'https://rsc.test/post/root', at: '2026-07-23T00:00:03.000Z' })
  seedPost(raw, { id: 'r1', author: 'u1', content: 'DIRECTREPLY', url: 'https://rsc.test/post/r1', replyTo: 'root', threadRoot: 'root', at: '2026-07-23T00:00:02.000Z' })
  seedPost(raw, { id: 'r1a', author: 'u1', content: 'NESTEDREPLY', url: 'https://rsc.test/post/r1a', replyTo: 'r1', threadRoot: 'root', at: '2026-07-23T00:00:01.000Z' })
}

test('the firehose transports local replies and never leaks a remote item (central local projection)', async () => {
  const { app, repo, store } = await makeApp()
  tree(repo.raw)
  seedRemoteItem(repo.raw, 's1', 'https://feed.test/f', 'g1', 'REMOTEBODY')
  drain(store)
  const res = await app.request('/users/rss.xml')
  expect(res.status).toBe(200)
  const xml = await res.text()
  expect(xml).toContain('ROOTBODY')
  expect(xml).toContain('DIRECTREPLY') // replies are transported (activity, no river)
  expect(xml).not.toContain('REMOTEBODY') // firehose is origin=local only
})

test('a local-account feed transports that author replies (local_author activity lens)', async () => {
  const { app, repo } = await makeApp()
  tree(repo.raw)
  const xml = await (await app.request('/users/alice/feed.xml')).text()
  expect(xml).toContain('DIRECTREPLY')
  expect(xml).toContain('NESTEDREPLY')
})

test('the comments feed serializes ordinary-visible DIRECT replies only', async () => {
  const { app, repo, materialize } = await makeApp()
  tree(repo.raw)
  materialize('root', 'r1', 'r1a')
  const res = await app.request('/post/root/comments.xml')
  expect(res.status).toBe(200)
  const xml = await res.text()
  expect(xml).toContain('DIRECTREPLY')
  expect(xml).not.toContain('NESTEDREPLY') // nested reply belongs to r1's own comments feed
})

test('there is no publisher feed — a publisher id is not a feed handle', async () => {
  const { app, repo, store } = await makeApp()
  seedRemoteItem(repo.raw, 's1', 'https://feed.test/f', 'g1', 'REMOTEBODY')
  drain(store)
  const pubId = (repo.raw.prepare(`SELECT id FROM remote_publishers_v2 LIMIT 1`).get() as { id: string }).id
  expect((await app.request(`/users/${encodeURIComponent(pubId)}/feed.xml`)).status).toBe(404)
})

test('the comments feed of a childless post is a valid empty feed with no placeholders', async () => {
  const { app, repo, materialize } = await makeApp()
  seedUser(repo.raw, 'u1', 'alice')
  seedPost(repo.raw, { id: 'solo', author: 'u1', content: 'SOLO', url: 'https://rsc.test/post/solo' })
  materialize('solo')
  const xml = await (await app.request('/post/solo/comments.xml')).text()
  expect(xml).toContain('<rss')
  expect(xml).not.toContain('placeholder')
})

// A remote reply resolvable to a LOCAL post: full delivery/observation/job rows so
// drain reconciles it, resolves the parent by the local permalink key, and makes it
// ordinary-visible (governance allowed). deliveryKey.kind ∈ opaque|permalink is what
// becomes the item's emitted origin <guid>.
function seedRemoteReply(raw: Raw, opts: { sourceId: string; deliveryKey: { kind: string; key: string }; permalink: string | null; inReplyTo: string; content: string }): void {
  raw.prepare(`INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at) VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`).run(opts.sourceId, `https://feed.test/${opts.sourceId}`, NOW)
  const runId = randomUUID(); const deliveryId = randomUUID(); const versionId = randomUUID(); const jobId = randomUUID()
  const material = { v: 1, keyKind: opts.deliveryKey.kind, key: opts.deliveryKey.key, title: 't', content: opts.content, link: opts.permalink, published: '', updated: null, inReplyTo: opts.inReplyTo, enclosures: [] }
  const canonical = Buffer.from(JSON.stringify(material), 'utf8')
  const fingerprint = createHash('sha256').update(canonical).digest('hex')
  const normalized = JSON.stringify({ keyKind: opts.deliveryKey.kind, key: opts.deliveryKey.key, permalink: opts.permalink, inReplyTo: opts.inReplyTo, enclosures: [] })
  const rawEvidence = JSON.stringify({ title: 't', sourceName: 'Feed', link: opts.permalink, published: '', updated: null, enclosureCount: 0 })
  raw.prepare(`INSERT INTO acquisition_runs_v2 (id, source_id, reason, status, started_at, acquisition_committed_at, completed_at, outcome, counters_json, failure_category, diagnostic, push_capability_json) VALUES (?, ?, 'scheduled', 'terminal', ?, ?, ?, 'parsed', '{}', NULL, NULL, NULL)`).run(runId, opts.sourceId, NOW, NOW, NOW)
  raw.prepare(`INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(deliveryId, opts.sourceId, opts.deliveryKey.kind, opts.deliveryKey.key, NOW, NOW, runId)
  raw.prepare(`INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json) VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)`).run(versionId, deliveryId, fingerprint, canonical, NOW, runId, NOW, runId, rawEvidence, normalized)
  raw.prepare(`INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at) VALUES (?, 'observation', ?, ?, NULL, 'pending', 0, ?, NULL, NULL, ?)`).run(jobId, runId, versionId, NOW, NOW)
}

const remoteIdForSource = (raw: Raw, sourceId: string): string =>
  (raw.prepare(`SELECT ik.logical_item_id AS id FROM logical_identity_keys_v2 ik JOIN deliveries_v2 d ON d.id = ik.key WHERE ik.kind = 'delivery' AND d.source_id = ?`).get(sourceId) as { id: string }).id

test('O4: comments.xml emits a remote reply ORIGIN guid (permalink + opaque wire guid), never our internal UUID', async () => {
  const { app, repo, store, materialize } = await makeApp()
  seedUser(repo.raw, 'u1', 'alice')
  seedPost(repo.raw, { id: 'root', author: 'u1', content: 'ROOTBODY', url: 'https://rsc.test/post/root' })
  materialize('root') // mint root's permalink identity key so remote replies resolve to it
  seedRemoteReply(repo.raw, { sourceId: 'sA', deliveryKey: { kind: 'permalink', key: 'https://origin.test/reply-a' }, permalink: 'https://origin.test/reply-a', inReplyTo: 'https://rsc.test/post/root', content: 'REPLYA' })
  seedRemoteReply(repo.raw, { sourceId: 'sB', deliveryKey: { kind: 'opaque', key: 'opaque-guid-b' }, permalink: null, inReplyTo: 'https://rsc.test/post/root', content: 'REPLYB' })
  drain(store)
  const idA = remoteIdForSource(repo.raw, 'sA')
  const idB = remoteIdForSource(repo.raw, 'sB')
  const xml = await (await app.request('/post/root/comments.xml')).text()
  expect(xml).toContain('REPLYA') // both replies are serialized
  expect(xml).toContain('REPLYB')
  // The emitted <guid> is the ORIGIN wire guid (v1 re-emitted posts.guid) — the
  // permalink for a permalink delivery, the bare wire guid for an opaque one.
  expect(xml).toContain('<guid isPermaLink="false">https://origin.test/reply-a</guid>')
  expect(xml).toContain('<guid isPermaLink="false">opaque-guid-b</guid>')
  // NOT our internal UUID (the defect: the origin instance can't dedupe its own item).
  expect(xml).not.toContain(idA)
  expect(xml).not.toContain(idB)
})
