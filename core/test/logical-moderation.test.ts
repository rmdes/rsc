import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import { createStreamSource } from '../src/logical/runtime.ts'
import type { ProjectionViewer } from '../src/logical/types.ts'
import type { CommandEnvelope, AuditCategory } from '../src/domain/types.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'
const ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }
const ADMIN = 'admin-1'

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  return { raw, db, store: createLogicalStore(db) }
}

// The route (Task 8) computes the fingerprint [command, logicalItemId, actor,
// category]; Task 2's store is fingerprint-agnostic, so tests model the route's
// discipline by hashing those inputs into the envelope's requestFingerprint.
const fp = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const env = (commandId: string, requestFingerprint: string, actorId = ADMIN): CommandEnvelope =>
  ({ actorScope: 'administrator', actorId, commandId, requestFingerprint })

type Store = Awaited<ReturnType<typeof fresh>>['store']
const hide = (store: Store, id: string, commandId: string, category: AuditCategory = 'spam', note: string | null = null) =>
  store.hideItem({ command: env(commandId, fp(['hide', id, ADMIN, category])), logicalItemId: id, category, note, now: NOW })
const restore = (store: Store, id: string, commandId: string, category: AuditCategory = 'false_positive', note: string | null = null) =>
  store.restoreItem({ command: env(commandId, fp(['restore', id, ADMIN, category])), logicalItemId: id, category, note, now: NOW })

function seedSource(raw: Raw, id: string, url: string, opts: { mode?: string; governance?: string } = {}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, 'enabled', ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, opts.mode ?? 'single_publisher', opts.governance ?? 'allowed', NOW)
}
function seedUser(raw: Raw, id: string, handle: string): void {
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at) VALUES (?, 'local', ?, ?, NULL, ?)`).run(id, handle, handle, NOW)
}
function seedPost(raw: Raw, p: { id: string; author: string; content?: string; at?: string; replyTo?: string | null; threadRoot?: string | null }): void {
  raw.prepare(
    `INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at, in_reply_to, in_reply_to_post_id, thread_root_id, source_name, source_feed_url, content_markdown, edited_at, reply_context_author, reply_context_snippet)
     VALUES (?, ?, 'local', ?, NULL, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
  ).run(p.id, p.author, p.id, p.content ?? 'c', `/post/${p.id}`, p.at ?? NOW, p.at ?? NOW, p.replyTo ?? null, p.threadRoot ?? null)
}
function seedSubscription(raw: Raw, owner: string, sourceId: string): void {
  raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, 'active', ?)`).run(randomUUID(), owner, sourceId, NOW)
}
function seedFederation(raw: Raw, sourceId: string): void {
  raw.prepare(`INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'approved', NULL, ?, ?)`).run(sourceId, NOW, NOW)
}
// A bare local-origin logical item (origin='local') — enough to exercise the
// local-origin refusal without materializing a full post.
function seedLocalItem(raw: Raw, id: string): void {
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at)
     VALUES (?, 'local', ?, 'none', NULL, NULL, NULL, ?)`,
  ).run(id, NOW, NOW)
}

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const ok = (body: string): Response => new Response(body, { status: 200 })
const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed T</title>${items}</channel></rss>`
const guidItem = (guid: string, body = 'd'): string => `<item><guid isPermaLink="false">${guid}</guid><title>t</title><description>${body}</description></item>`

async function acquire(db: ReturnType<typeof createDatabaseContext>, sourceId: string, url: string, body: string): Promise<void> {
  const eng = createAcquisition({ db, fetchFn: (async (i: string | URL | Request) => { const u = typeof i === 'string' ? i : i instanceof URL ? i.toString() : i.url; if (u !== url) throw new Error(`no route ${u}`); return ok(body) }) as unknown as typeof fetch, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource(sourceId, { kind: 'scheduled' }, undefined)
}
const drain = (store: Store): number => drainReconciliation({ store, now: () => NOW })
const remoteIdForSource = (raw: Raw, sourceId: string): string =>
  (raw.prepare(`SELECT ik.logical_item_id AS id FROM logical_identity_keys_v2 ik JOIN deliveries_v2 d ON d.id = ik.key WHERE ik.kind = 'delivery' AND d.source_id = ?`).get(sourceId) as { id: string }).id

// Seed one visible remote item on an allowed source; returns its logical id.
async function visibleRemote(db: ReturnType<typeof createDatabaseContext>, raw: Raw, store: Store, sourceId = 's1', url = 'https://feed.test/f', guid = 'g1'): Promise<string> {
  seedSource(raw, sourceId, url)
  await acquire(db, sourceId, url, RSS(guidItem(guid)))
  drain(store)
  return remoteIdForSource(raw, sourceId)
}

const auditRows = (raw: Raw, id: string) =>
  raw.prepare(`SELECT command_id, actor_kind, action, category, note FROM item_audit_v2 WHERE logical_item_id = ? ORDER BY rowid`).all(id) as
    { command_id: string; actor_kind: string; action: string; category: string | null; note: string | null }[]
const hiddenAtOf = (raw: Raw, id: string): string | null =>
  (raw.prepare(`SELECT hidden_at FROM logical_items_v2 WHERE id = ?`).get(id) as { hidden_at: string | null }).hidden_at

// ---- command matrix over the ledger (spec §1.1, plan Appendix D) ------------

test('hide sets hidden_at and appends exactly one administrator audit row with category + note', async () => {
  const { raw, db, store } = await fresh()
  const id = await visibleRemote(db, raw, store)

  const res = hide(store, id, 'c1', 'spam', 'nsfw')
  expect(res).toMatchObject({ kind: 'applied', logicalItemId: id, hiddenAt: NOW })
  expect(hiddenAtOf(raw, id)).toBe(NOW)
  const audit = auditRows(raw, id)
  expect(audit).toHaveLength(1)
  expect(audit[0]).toMatchObject({ command_id: 'c1', actor_kind: 'administrator', action: 'hide', category: 'spam', note: 'nsfw' })
})

test('an identical hide retry replays the stored result and writes no second audit row', async () => {
  const { raw, db, store } = await fresh()
  const id = await visibleRemote(db, raw, store)
  const first = hide(store, id, 'c1')
  const replay = hide(store, id, 'c1')
  expect(replay).toEqual(first)
  expect(auditRows(raw, id)).toHaveLength(1) // no second write
})

test('hide on an already-hidden item is not_applicable (distinct from idempotency conflict)', async () => {
  const { raw, db, store } = await fresh()
  const id = await visibleRemote(db, raw, store)
  hide(store, id, 'c1')
  expect(hide(store, id, 'c2')).toEqual({ kind: 'not_applicable' }) // fresh command, state conflict
})

test('restore on a non-hidden item is not_applicable', async () => {
  const { raw, db, store } = await fresh()
  const id = await visibleRemote(db, raw, store)
  expect(restore(store, id, 'c1')).toEqual({ kind: 'not_applicable' })
})

test('hide of an unknown item is unknown; hide of a local-origin item is local_origin', async () => {
  const { raw, db, store } = await fresh()
  await visibleRemote(db, raw, store)
  expect(hide(store, 'no-such-item', 'c1')).toEqual({ kind: 'unknown' })
  seedLocalItem(raw, 'local-1')
  expect(hide(store, 'local-1', 'c2')).toEqual({ kind: 'local_origin' })
})

test('a reused command ID with ANY varied fingerprint input conflicts (command, item, actor, category)', async () => {
  const { raw, db, store } = await fresh()
  const id = await visibleRemote(db, raw, store)
  expect(hide(store, id, 'c1', 'spam')).toMatchObject({ kind: 'applied' })
  const varied = [
    fp(['restore', id, ADMIN, 'spam']),   // command
    fp(['hide', 'other-item', ADMIN, 'spam']), // logicalItemId
    fp(['hide', id, 'admin-2', 'spam']),  // actor
    fp(['hide', id, ADMIN, 'abuse']),     // category
  ]
  for (const f of varied) {
    expect(store.hideItem({ command: env('c1', f), logicalItemId: id, category: 'spam', note: null, now: NOW })).toEqual({ kind: 'conflict' })
  }
})

test('a changed note alone replays (note is excluded from the fingerprint)', async () => {
  const { raw, db, store } = await fresh()
  const id = await visibleRemote(db, raw, store)
  const first = hide(store, id, 'c1', 'spam', 'first note')
  // Same command/item/actor/category ⇒ same fingerprint; only the note differs.
  const replay = store.hideItem({ command: env('c1', fp(['hide', id, ADMIN, 'spam'])), logicalItemId: id, category: 'spam', note: 'different note', now: NOW })
  expect(replay).toEqual(first)
  expect(auditRows(raw, id)[0].note).toBe('first note') // the stored effect, not the retried note
})

test('restore clears hidden_at only and never publishes previously ineligible evidence', async () => {
  const { raw, db, store } = await fresh()
  // Quarantined source ⇒ no ordinary-eligible delivery even when not hidden.
  seedSource(raw, 's1', 'https://feed.test/f', { governance: 'quarantined' })
  await acquire(db, 's1', 'https://feed.test/f', RSS(guidItem('g1')))
  drain(store)
  const id = remoteIdForSource(raw, 's1')
  expect(store.snapshot((tx) => tx.projectItem(id, ANON))).toBeUndefined() // ineligible baseline

  expect(hide(store, id, 'c1')).toMatchObject({ kind: 'applied', hiddenAt: NOW })
  const res = restore(store, id, 'c2', 'false_positive')
  expect(res).toEqual({ kind: 'applied', logicalItemId: id, hiddenAt: null })
  expect(hiddenAtOf(raw, id)).toBeNull()
  expect(store.snapshot((tx) => tx.projectItem(id, ANON))).toBeUndefined() // restore published nothing
  // restore reuses the re-added false_positive category (spec §1.2).
  expect(auditRows(raw, id).map((a) => a.action)).toEqual(['hide', 'restore'])
})

// ---- the ONE visibility predicate: hidden vanishes from every surface --------

test('a hidden item is absent from the public, personal, and federated rivers', async () => {
  const { raw, db, store } = await fresh()
  const id = await visibleRemote(db, raw, store)
  seedUser(raw, 'u1', 'alice')
  seedSubscription(raw, 'u1', 's1')
  seedFederation(raw, 's1')
  const account = { id: 'u1', handle: 'alice', displayName: 'alice' }
  const viewer = { localAccountId: 'u1', activeSourceIds: [] as string[] }
  const lensIds = () => ({
    pub: store.snapshot((tx) => tx.projectTimeline({ lens: { kind: 'public' }, before: null, limit: 50, viewer })).timeline.map((d) => d.id),
    personal: store.snapshot((tx) => tx.projectTimeline({ lens: { kind: 'personal', account }, before: null, limit: 50, viewer })).timeline.map((d) => d.id),
    federated: store.snapshot((tx) => tx.projectTimeline({ lens: { kind: 'federated' }, before: null, limit: 50, viewer })).timeline.map((d) => d.id),
  })
  const before = lensIds()
  expect(before.pub).toContain(id)
  expect(before.personal).toContain(id)
  expect(before.federated).toContain(id)

  hide(store, id, 'c1')
  const after = lensIds()
  expect(after.pub).not.toContain(id)
  expect(after.personal).not.toContain(id)
  expect(after.federated).not.toContain(id)
})

test('the hidden predicate is applied in SQL BEFORE LIMIT (a hidden newest item never shorts the page)', async () => {
  const { raw, db, store } = await fresh()
  const hiddenId = await visibleRemote(db, raw, store, 's1', 'https://feed.test/f', 'g1')
  const realId = await visibleRemote(db, raw, store, 's2', 'https://feed.test/g', 'g2')
  // Force the to-be-hidden item strictly newest so a POST-fetch filter on a limit:1
  // page would return empty (the classic river-predicate discipline).
  raw.prepare(`UPDATE logical_items_v2 SET timeline_sort_at = '2026-07-24T00:00:10.000Z' WHERE id = ?`).run(hiddenId)
  hide(store, hiddenId, 'c1')
  const env1 = store.snapshot((tx) => tx.projectTimeline({ lens: { kind: 'public' }, before: null, limit: 1, viewer: ANON }))
  expect(env1.timeline.map((d) => d.id)).toEqual([realId]) // full page, not shorted by the hidden newest row
})

test('single-item and history projections return undefined for a hidden item (neutral 404 at the route)', async () => {
  const { raw, db, store } = await fresh()
  const id = await visibleRemote(db, raw, store)
  expect(store.snapshot((tx) => tx.projectItem(id, ANON))).toBeDefined()
  expect(store.snapshot((tx) => tx.projectHistory(id, ANON))).toBeDefined()
  hide(store, id, 'c1')
  expect(store.snapshot((tx) => tx.projectItem(id, ANON))).toBeUndefined()
  expect(store.snapshot((tx) => tx.projectHistory(id, ANON))).toBeUndefined()
})

test('a hidden node with a visible descendant becomes the existing unavailable placeholder; a hidden leaf 404s', async () => {
  const { raw, db, store } = await fresh()
  // parent (remote) with a remote child resolved to it.
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, 's1', 'https://feed.test/f', RSS(guidItem('parent')))
  drain(store)
  const parentId = remoteIdForSource(raw, 's1')
  // A second remote item whose parent edge resolves to parentId (white-box).
  await acquire(db, 's1', 'https://feed.test/f', RSS(guidItem('parent') + guidItem('child', 'child body')))
  drain(store)
  const childId = (raw.prepare(
    `SELECT ik.logical_item_id AS id FROM logical_identity_keys_v2 ik WHERE ik.kind = 'delivery' AND ik.logical_item_id != ?`,
  ).get(parentId) as { id: string } | undefined)?.id
  expect(childId).toBeTruthy()
  raw.prepare(`UPDATE logical_items_v2 SET parent_state = 'resolved', parent_logical_item_id = ? WHERE id = ?`).run(parentId, childId)

  hide(store, parentId, 'c1')
  // Requesting the thread from the visible child: the hidden parent connects it, so
  // it serializes as the neutral unavailable placeholder (no new kind).
  const thread = store.snapshot((tx) => tx.projectThread(childId!, ANON))!
  const parentNode = thread.nodes.find((n) => n.kind === 'placeholder' && n.logicalItemId === parentId)
  expect(parentNode).toMatchObject({ kind: 'placeholder', placeholderKind: 'unavailable' })

  // Now hide the leaf child too: requesting the child directly is an ordinary 404.
  hide(store, childId!, 'c2')
  expect(store.snapshot((tx) => tx.projectThread(childId!, ANON))).toBeUndefined()
})

test('SSE send-time projection converts a now-hidden historical upsert into an effective remove', async () => {
  const { raw, db, store } = await fresh()
  const id = await visibleRemote(db, raw, store) // drain appended an upsert row for this item
  hide(store, id, 'c1')
  const meta = store.snapshot((tx) => tx.getJournalMetadata())
  const source = createStreamSource(db)
  const batch = source.batch({ afterSequence: 0, generation: meta.resetGeneration, viewer: ANON, limit: 100 })
  const events = batch.frames.filter((f) => f.control === 'event').map((f) => f.event)
  const forItem = events.filter((e) => 'logicalItemId' in e && e.logicalItemId === id)
  expect(forItem.length).toBeGreaterThan(0)
  expect(forItem.every((e) => e.kind === 'remove')).toBe(true) // the historical upsert re-projected to a remove
})

test('hidden survives redelivery and new versions (reconciliation never clears hidden_at)', async () => {
  const { raw, db, store } = await fresh()
  seedSource(raw, 's1', 'https://feed.test/f')
  await acquire(db, 's1', 'https://feed.test/f', RSS(guidItem('g1', 'v1')))
  drain(store)
  const id = remoteIdForSource(raw, 's1')
  hide(store, id, 'c1')
  // A new version of the SAME delivery arrives and reconciles.
  await acquire(db, 's1', 'https://feed.test/f', RSS(guidItem('g1', 'v2 edited')))
  drain(store)
  expect(hiddenAtOf(raw, id)).toBe(NOW) // untouched by reconciliation
  expect(store.snapshot((tx) => tx.projectItem(id, ANON))).toBeUndefined() // still hidden
})
