import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository, MIGRATIONS } from '../src/storage/sqlite.ts'
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
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, store)
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
  // The emitted <guid> is the ORIGIN wire guid (v1 re-emitted posts.guid) — bare
  // when it IS the item's own permalink (reply-a: keyKind='permalink', guid===url),
  // isPermaLink="false" only when it is not (reply-b: opaque key, no permalink).
  expect(xml).toContain('<guid>https://origin.test/reply-a</guid>')
  expect(xml).toContain('<guid isPermaLink="false">opaque-guid-b</guid>')
  // NOT our internal UUID (the defect: the origin instance can't dedupe its own item).
  expect(xml).not.toContain(idA)
  expect(xml).not.toContain(idB)
})

// --- guests are local-only (2026-08-18) --------------------------------------
// A guest account is transient: it is swept if it never registers, and its
// per-user feed 404s from then on. Federating its posts therefore strands
// content on peers attributed to an account that no longer exists. So a guest's
// posts stay on this instance, and the flag is stamped ON THE POST at write
// time — registering later publishes nothing retroactively.

function seedGuest(raw: Raw, id: string, handle: string): void {
  raw.prepare(`INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt, isAnonymous) VALUES (?, ?, ?, 0, NULL, ?, ?, 1)`)
    .run(`auth-${id}`, handle, `${handle}@guest.invalid`, NOW, NOW)
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at, auth_user_id) VALUES (?, 'local', ?, ?, NULL, ?, ?)`)
    .run(id, handle, handle, NOW, `auth-${id}`)
}
// The exact shape onLinkAccount produces (core/src/auth.ts): the SAME core row
// is re-pointed at a registered auth user. Handle and posts are untouched.
function registerGuest(raw: Raw, id: string): void {
  raw.prepare(`INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt, isAnonymous) VALUES (?, 'real', ?, 1, NULL, ?, ?, 0)`)
    .run(`auth-real-${id}`, `real-${id}@example.test`, NOW, NOW)
  raw.prepare(`UPDATE users SET auth_user_id = ? WHERE id = ?`).run(`auth-real-${id}`, id)
}

test('a guest post is absent from the firehose and from its own per-user feed', async () => {
  const { app, repo, store } = await makeApp()
  seedUser(repo.raw, 'u1', 'alice')
  seedPost(repo.raw, { id: 'p1', author: 'u1', content: 'REGISTEREDBODY', url: 'https://rsc.test/post/p1' })
  seedGuest(repo.raw, 'g1', 'guest-abc')
  // through the REAL write path — seedPost bypasses the stamping and would
  // assert against a state the application cannot produce.
  const guest = (await repo.getUser('g1'))!
  store.createLocalPost({ author: guest, content: 'GUESTBODY', replyToId: null, now: NOW, publicUrl: 'https://rsc.test' })

  const fire = await (await app.request('/users/rss.xml')).text()
  expect(fire).toContain('REGISTEREDBODY')
  expect(fire).not.toContain('GUESTBODY')

  const own = await (await app.request('/users/guest-abc/feed.xml')).text()
  expect(own).not.toContain('GUESTBODY') // not separately subscribable either

  const ownJson = await (await app.request('/users/guest-abc/feed.json')).text()
  expect(ownJson).not.toContain('GUESTBODY')
})

test('registering does NOT publish the back-catalogue; only posts written after it federate', async () => {
  const { app, repo, store } = await makeApp()
  seedGuest(repo.raw, 'g1', 'guest-abc')
  const guest = (await repo.getUser('g1'))!
  store.createLocalPost({ author: guest, content: 'ASGUEST', replyToId: null, now: NOW, publicUrl: 'https://rsc.test' })

  registerGuest(repo.raw, 'g1')
  const nowRegistered = (await repo.getUser('g1'))!
  store.createLocalPost({ author: nowRegistered, content: 'AFTERJOINING', replyToId: null, now: NOW, publicUrl: 'https://rsc.test' })

  const fire = await (await app.request('/users/rss.xml')).text()
  expect(fire).not.toContain('ASGUEST')      // written as a guest — stays local forever
  expect(fire).toContain('AFTERJOINING')     // written as a real user — federates
})

test('a guest post stays readable on the instance itself', async () => {
  const { app, repo, store } = await makeApp()
  seedGuest(repo.raw, 'g1', 'guest-abc')
  const guest = (await repo.getUser('g1'))!
  const item = store.createLocalPost({ author: guest, content: 'GUESTBODY', replyToId: null, now: NOW, publicUrl: 'https://rsc.test' })
  const res = await app.request(`/post/${item.id}/thread`)
  expect(res.status).toBe(200)
  expect(JSON.stringify(await res.json())).toContain('GUESTBODY')
})

test('migration 24 backfill marks an existing guest author\'s posts local-only', async () => {
  const { repo } = await makeApp()
  seedGuest(repo.raw, 'g1', 'guest-abc')
  seedUser(repo.raw, 'u1', 'alice')
  // pre-migration state: both posts unflagged
  seedPost(repo.raw, { id: 'p1', author: 'g1', content: 'GUESTBODY' })
  seedPost(repo.raw, { id: 'p2', author: 'u1', content: 'REGISTEREDBODY' })
  repo.raw.prepare(`UPDATE posts SET local_only = 0`).run()

  // run the SHIPPED backfill statement, not a retyped copy of it
  for (const stmt of MIGRATIONS[23]) { if (stmt.startsWith('UPDATE')) repo.raw.exec(stmt) }

  const flag = (id: string) => (repo.raw.prepare(`SELECT local_only AS f FROM posts WHERE id = ?`).get(id) as { f: number }).f
  expect(flag('p1')).toBe(1)
  expect(flag('p2')).toBe(0)
})

// The PUSH twins. domain/push.ts builds fat-ping bodies from these repository
// methods, not from projectLocalActivity — a guest post filtered out of the
// PULLED feed but still present in the PUSHED one federates anyway, which is
// exactly what happened live on 2026-08-18.
test('the push-path feed queries exclude guest posts too', async () => {
  const { repo, store } = await makeApp()
  seedUser(repo.raw, 'u1', 'alice')
  seedPost(repo.raw, { id: 'p1', author: 'u1', content: 'REGISTEREDBODY' })
  seedGuest(repo.raw, 'g1', 'guest-abc')
  const guest = (await repo.getUser('g1'))!
  store.createLocalPost({ author: guest, content: 'GUESTBODY', replyToId: null, now: NOW, publicUrl: 'https://rsc.test' })

  const firehoseBody = await repo.getRecentLocalPosts(50)
  expect(firehoseBody.map((e) => e.content).join(' ')).toContain('REGISTEREDBODY')
  expect(firehoseBody.map((e) => e.content).join(' ')).not.toContain('GUESTBODY')

  expect(await repo.getPostsByAuthor('g1', 50)).toEqual([])
})

// --- DRIFT CANARY: the feed twins ---------------------------------------------
// RSC builds its outbound feeds TWICE and the two paths share no predicate:
//   pulled  → projectLocalActivity        (logical/projector.ts, via api/logical-routes/read.ts)
//   pushed  → getRecentLocalPosts / getPostsByAuthor
//             (storage/sqlite.ts, via domain/push.ts — the fat-ping bodies peers consume)
// This seam has leaked TWICE in one milestone: feed_item_limit reached only the
// pull path, and local_only (guest posts) reached only the pull path — shipped to
// five instances before a live guest post showed 0 in the firehose and landed on
// two peers anyway.
//
// Deliberately asserts AGREEMENT, not any specific rule: it does not encode
// "guests are excluded", so it keeps catching the NEXT divergence, whatever the
// rule turns out to be. Anyone filtering one path and not the other fails here.
test('drift canary: the pulled and pushed feeds select exactly the same posts', async () => {
  const { repo, store } = await makeApp()
  seedUser(repo.raw, 'u1', 'alice')
  seedGuest(repo.raw, 'g1', 'guest-abc')
  const alice = (await repo.getUser('u1'))!
  const guest = (await repo.getUser('g1'))!

  // a mixed corpus: registered root + reply, a guest post, and a remote item
  store.createLocalPost({ author: alice, content: 'A1', replyToId: null, now: '2026-01-01T00:00:00.000Z', publicUrl: 'https://rsc.test' })
  const a2 = store.createLocalPost({ author: alice, content: 'A2', replyToId: null, now: '2026-01-02T00:00:00.000Z', publicUrl: 'https://rsc.test' })
  store.createLocalPost({ author: alice, content: 'A3reply', replyToId: a2.id, now: '2026-01-03T00:00:00.000Z', publicUrl: 'https://rsc.test' })
  store.createLocalPost({ author: guest, content: 'G1', replyToId: null, now: '2026-01-04T00:00:00.000Z', publicUrl: 'https://rsc.test' })
  seedRemoteItem(repo.raw, 's1', 'https://feed.test/f', 'g-remote', 'REMOTEBODY')

  const pulledFirehose = store.snapshot((tx) => tx.projectLocalActivity({ authorId: null, limit: 50 })).map((d) => d.id).sort()
  const pushedFirehose = (await repo.getRecentLocalPosts(50)).map((e) => e.id).sort()
  expect(pushedFirehose).toEqual(pulledFirehose)

  for (const id of ['u1', 'g1']) {
    const pulled = store.snapshot((tx) => tx.projectLocalActivity({ authorId: id, limit: 50 })).map((d) => d.id).sort()
    const pushed = (await repo.getPostsByAuthor(id, 50)).map((p) => p.id).sort()
    expect(pushed).toEqual(pulled)
  }
})
