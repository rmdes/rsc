import { test, expect } from 'vitest'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { drainReconciliation } from '../src/logical/reconcile.ts'
import {
  PURGE_INVENTORY, PURGE_ROOT_TABLES, removeSourceEvidence, writePurgeTombstone,
} from '../src/logical/tombstones.ts'
import { resolveInitialParent } from '../src/logical/threading.ts'
import { projectItem } from '../src/logical/projector.ts'
import type { CommandEnvelope, AuditCategory } from '../src/domain/types.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'
import type { ProjectionViewer } from '../src/logical/types.ts'

// V3 Task 6 — purge blocked sources into tombstones + the structural-tombstone
// terminal state and its descendant-deletion sweep. Purge deletes a blocked
// source's evidence in FK order (the inventory), writes the tombstone + one alias
// per source_aliases_v2 row (copied before the cascade), and converts
// descendant-referenced remote ancestors into structural tombstones.

type Raw = InstanceType<typeof Database>
type Db = ReturnType<typeof createDatabaseContext>
const NOW = '2026-07-24T00:00:00.000Z'
const ADMIN = 'admin-1'
const ANON: ProjectionViewer = { localAccountId: null, activeSourceIds: [] }

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  return { raw, db, store: createLogicalStore(db) }
}
type Store = Awaited<ReturnType<typeof fresh>>['store']

const count = (raw: Raw, table: string, where = '', ...args: unknown[]): number =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args) as { n: number }).n
const fp = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const env = (commandId: string, requestFingerprint: string): CommandEnvelope =>
  ({ actorScope: 'administrator', actorId: ADMIN, commandId, requestFingerprint })
const purge = (store: Store, sourceId: string, commandId: string, category: AuditCategory = 'abuse') =>
  store.purgeSource({ command: env(commandId, fp(['purge', sourceId, ADMIN, category])), sourceId, category, note: null, now: NOW })

function seedSource(raw: Raw, id: string, url: string, governance = 'allowed', mode = 'single_publisher'): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, 'enabled', ?, 'admin_federation', NULL, 0, ?)`,
  ).run(id, url, mode, governance, NOW)
}
const block = (raw: Raw, id: string): void => { raw.prepare(`UPDATE remote_sources_v2 SET governance = 'blocked' WHERE id = ?`).run(id) }

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const ok = (body: string): Response => new Response(body, { status: 200 })
const RSS = (items: string): string => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`
// A permalinked item — two sources delivering the same <link> converge to ONE logical item.
const linkItem = (guid: string, link: string): string =>
  `<item><guid isPermaLink="false">${guid}</guid><link>${link}</link><title>t</title><description>d</description></item>`

async function acquire(db: Db, sourceId: string, url: string, body: string): Promise<void> {
  const eng = createAcquisition({ db, fetchFn: (async (i: string | URL | Request) => { const u = typeof i === 'string' ? i : i instanceof URL ? i.toString() : i.url; if (u !== url) throw new Error(`no route ${u}`); return ok(body) }) as unknown as typeof fetch, lookupFn: publicLookup, now: () => NOW })
  await eng.acquireSource(sourceId, { kind: 'scheduled' }, undefined)
}
const drain = (store: Store): number => drainReconciliation({ store, now: () => NOW })

// The logical item that owns a permalink identity key.
const itemByLink = (raw: Raw, link: string): string =>
  (raw.prepare(`SELECT logical_item_id AS id FROM logical_identity_keys_v2 WHERE kind = 'permalink' AND key = ?`).get(link) as { id: string }).id
const resetCount = (raw: Raw): number => count(raw, 'logical_journal_v2', `WHERE kind = 'reset'`)
const setParent = (raw: Raw, child: string, parent: string): void => {
  raw.prepare(`UPDATE logical_items_v2 SET parent_state = 'resolved', parent_logical_item_id = ? WHERE id = ?`).run(parent, child)
}

// Create one permalinked remote item from a source and return its logical id.
async function makeItem(db: Db, raw: Raw, store: Store, sourceId: string, url: string, link: string, governance = 'allowed'): Promise<string> {
  seedSource(raw, sourceId, url, governance)
  await acquire(db, sourceId, url, RSS(linkItem(`${sourceId}-g`, link)))
  drain(store)
  return itemByLink(raw, link)
}

// ---- command matrix ---------------------------------------------------------

test('purge of an unknown source is unknown', async () => {
  const { store } = await fresh()
  expect(purge(store, 'nope', 'c1')).toEqual({ kind: 'unknown' })
})

test('purge of a non-blocked source is not_blocked', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's1', 'https://a.test/f', 'allowed')
  expect(purge(store, 's1', 'c1')).toEqual({ kind: 'not_blocked' })
  seedSource(raw, 's2', 'https://b.test/f', 'quarantined')
  expect(purge(store, 's2', 'c2')).toEqual({ kind: 'not_blocked' })
})

test('an identical purge retry replays the stored result; a varied fingerprint conflicts', async () => {
  const { raw, store } = await fresh()
  seedSource(raw, 's1', 'https://a.test/f', 'blocked')
  const first = purge(store, 's1', 'c1', 'abuse')
  expect(first.kind).toBe('purged')
  expect(purge(store, 's1', 'c1', 'abuse')).toEqual(first) // identical replay
  expect(purge(store, 's1', 'c1', 'spam')).toEqual({ kind: 'conflict' }) // changed category, reused id
})

// ---- the one atomic transaction ---------------------------------------------

test('purging a blocked source writes the tombstone and deletes all its evidence and the source row', async () => {
  const { raw, db, store } = await fresh()
  const id = await makeItem(db, raw, store, 's1', 'https://a.test/f', 'https://a.test/p1')
  block(raw, 's1')
  const before = resetCount(raw)

  const res = purge(store, 's1', 'c1')
  expect(res.kind).toBe('purged')
  const tid = (res as { tombstoneId: string }).tombstoneId
  const tomb = raw.prepare(`SELECT canonical_url, action, category, actor_id FROM blocked_source_tombstones_v2 WHERE id = ?`).get(tid) as { canonical_url: string; action: string; category: string; actor_id: string }
  expect(tomb).toMatchObject({ canonical_url: 'https://a.test/f', action: 'purge', category: 'abuse', actor_id: ADMIN })

  expect(count(raw, 'remote_sources_v2', 'WHERE id = ?', 's1')).toBe(0)
  for (const t of ['deliveries_v2', 'observation_versions_v2', 'presentation_entries_v2', 'publisher_claims_v2', 'publisher_names_v2', 'reconciliation_jobs_v2']) {
    expect(count(raw, t)).toBe(0)
  }
  // the item was supported only by s1 with no descendant → deleted outright
  expect(count(raw, 'logical_items_v2', 'WHERE id = ?', id)).toBe(0)
  // exactly ONE reset barrier
  expect(resetCount(raw)).toBe(before + 1)
})

test('one tombstone alias is written per source_aliases_v2 row, copied before the cascade', async () => {
  const { raw, db, store } = await fresh()
  await makeItem(db, raw, store, 's1', 'https://a.test/f', 'https://a.test/p1')
  raw.prepare(`INSERT INTO source_aliases_v2 (url, source_id, created_at) VALUES (?, 's1', ?)`).run('https://a.test/alias-1', NOW)
  raw.prepare(`INSERT INTO source_aliases_v2 (url, source_id, created_at) VALUES (?, 's1', ?)`).run('https://a.test/alias-2', NOW)
  block(raw, 's1')

  const res = purge(store, 's1', 'c1')
  const tid = (res as { tombstoneId: string }).tombstoneId
  const aliases = (raw.prepare(`SELECT url FROM tombstone_aliases_v2 WHERE tombstone_id = ? ORDER BY url`).all(tid) as { url: string }[]).map((r) => r.url)
  expect(aliases).toEqual(['https://a.test/alias-1', 'https://a.test/alias-2'])
  expect(count(raw, 'source_aliases_v2')).toBe(0) // cascaded away with the source row
})

// ---- Step 1a: the FK-graph inventory RULE -----------------------------------

test('every blocking FK edge pointing at a purge-root table is named in the purge inventory', async () => {
  const { raw } = await fresh()
  const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_v2' ESCAPE '\\'`).all() as { name: string }[]).map((r) => r.name)
  const missing: string[] = []
  for (const child of tables) {
    for (const fk of raw.prepare(`PRAGMA foreign_key_list(${child})`).all() as { table: string; on_delete: string }[]) {
      // CASCADE edges do not block a parent DELETE; RESTRICT and NO ACTION do.
      if (fk.on_delete === 'CASCADE') continue
      if (!PURGE_ROOT_TABLES.has(fk.table)) continue
      if (!PURGE_INVENTORY.has(child)) missing.push(`${child} -> ${fk.table}`)
    }
  }
  expect(missing).toEqual([])
})

// ---- per-item effects -------------------------------------------------------

test('an item still supported by another source reselects and stays visible', async () => {
  const { raw, db, store } = await fresh()
  // Both sources deliver the same permalink → ONE logical item, two deliveries.
  const id = await makeItem(db, raw, store, 's1', 'https://a.test/f', 'https://shared.test/p')
  seedSource(raw, 's2', 'https://b.test/f', 'allowed')
  await acquire(db, 's2', 'https://b.test/f', RSS(linkItem('s2-g', 'https://shared.test/p')))
  drain(store)
  expect(count(raw, 'logical_items_v2', 'WHERE origin = ?', 'remote')).toBe(1) // converged
  block(raw, 's1')

  expect(purge(store, 's1', 'c1').kind).toBe('purged')
  expect(count(raw, 'logical_items_v2', 'WHERE id = ?', id)).toBe(1) // survives
  const dto = db.read((tx) => projectItem(tx, id, ANON))
  expect(dto).toBeDefined() // still ordinarily visible via s2
  // its selected delivery now belongs to s2
  const sel = raw.prepare(`SELECT selected_delivery_id FROM logical_items_v2 WHERE id = ?`).get(id) as { selected_delivery_id: string }
  const src = raw.prepare(`SELECT source_id FROM deliveries_v2 WHERE id = ?`).get(sel.selected_delivery_id) as { source_id: string }
  expect(src.source_id).toBe('s2')
})

test('an unsupported ancestor referenced by a surviving descendant becomes a structural tombstone', async () => {
  const { raw, db, store } = await fresh()
  const root = await makeItem(db, raw, store, 's1', 'https://a.test/f', 'https://a.test/root') // from blocked s1
  const reply = await makeItem(db, raw, store, 's2', 'https://b.test/f', 'https://b.test/reply') // from allowed s2
  setParent(raw, reply, root)
  block(raw, 's1')

  expect(purge(store, 's1', 'c1').kind).toBe('purged')
  const rootRow = raw.prepare(`SELECT structural_tombstone, selected_delivery_id, selected_publisher_id, parent_logical_item_id, timeline_sort_at FROM logical_items_v2 WHERE id = ?`).get(root) as { structural_tombstone: number; selected_delivery_id: string | null; selected_publisher_id: string | null; parent_logical_item_id: string | null; timeline_sort_at: string }
  expect(rootRow.structural_tombstone).toBe(1)
  expect(rootRow.selected_delivery_id).toBeNull()
  expect(rootRow.selected_publisher_id).toBeNull()
  expect(rootRow.timeline_sort_at).toBeTruthy() // immutable sort key retained
  // evidence gone: no deliveries/claims/identity keys for the tombstone
  expect(count(raw, 'logical_identity_keys_v2', 'WHERE logical_item_id = ?', root)).toBe(0)
  expect(count(raw, 'publisher_claims_v2', 'WHERE logical_item_id = ?', root)).toBe(0)
  // it serializes ONLY as the unavailable placeholder
  expect(db.read((tx) => projectItem(tx, root, ANON))).toBeUndefined()
  // the reply survives and still edges to the tombstone
  const replyRow = raw.prepare(`SELECT parent_logical_item_id FROM logical_items_v2 WHERE id = ?`).get(reply) as { parent_logical_item_id: string }
  expect(replyRow.parent_logical_item_id).toBe(root)
  // the thread renders the tombstone as an unavailable placeholder
  const thread = store.snapshot((tx) => tx.projectThread(reply, ANON))
  const rootNode = thread!.nodes.find((n) => (n.kind === 'placeholder' ? n.logicalItemId : n.item.id) === root)
  expect(rootNode).toMatchObject({ kind: 'placeholder', placeholderKind: 'unavailable' })
})

test('a structural tombstone is not a valid reply/adoption target', async () => {
  const { raw, db, store } = await fresh()
  const root = await makeItem(db, raw, store, 's1', 'https://a.test/f', 'https://a.test/root')
  const reply = await makeItem(db, raw, store, 's2', 'https://b.test/f', 'https://b.test/reply')
  setParent(raw, reply, root)
  block(raw, 's1')
  purge(store, 's1', 'c1')
  // the tombstone kept its /root permalink? no — identity keys are stripped, so
  // resolving that permalink finds no owner (never adopts the tombstone).
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'o', reference: { kind: 'permalink', key: 'https://a.test/root', scope: null, raw: 'x' }, logicalItemId: reply }))
  expect(r.state).not.toBe('resolved')
})

test('purge sweeps a structural-tombstone ancestor whose last descendant it also deletes', async () => {
  const { raw, db, store } = await fresh()
  // ONE blocked source delivers both the root and the reply (two items, one feed).
  seedSource(raw, 's1', 'https://a.test/f', 'allowed')
  await acquire(db, 's1', 'https://a.test/f', RSS(linkItem('g1', 'https://a.test/root') + linkItem('g2', 'https://a.test/reply')))
  drain(store)
  const root = itemByLink(raw, 'https://a.test/root')
  const reply = itemByLink(raw, 'https://a.test/reply')
  setParent(raw, reply, root)
  block(raw, 's1')
  purge(store, 's1', 'c1')
  // reply (leaf, unsupported) deleted; root (its only child gone) swept — both gone
  expect(count(raw, 'logical_items_v2')).toBe(0)
  expect(count(raw, 'logical_items_v2', `WHERE structural_tombstone = 1`)).toBe(0)
})

test('purge sweeps a pre-existing structural tombstone orphaned by the deletion', async () => {
  const { raw, db, store } = await fresh()
  // hand-seed a bare structural tombstone T (edges/sort key only)
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at, structural_tombstone) VALUES ('T', 'remote', ?, 'none', NULL, NULL, NULL, ?, 1)`).run(NOW, NOW)
  const child = await makeItem(db, raw, store, 's1', 'https://a.test/f', 'https://a.test/c')
  setParent(raw, child, 'T')
  block(raw, 's1')
  purge(store, 's1', 'c1')
  expect(count(raw, 'logical_items_v2', 'WHERE id = ?', 'T')).toBe(0) // swept
  expect(count(raw, 'logical_items_v2', 'WHERE id = ?', child)).toBe(0)
})

// ---- structural tombstone vs deleted_local, side by side --------------------

test('a structural tombstone is swept but a deleted_local marker keeps its anchor and is never swept', async () => {
  const { raw, db, store } = await fresh()
  // deleted_local: a local post, deleted, leaves a permanent marker
  raw.prepare(`INSERT INTO users (id, kind, handle, display_name, feed_url, created_at, auth_user_id, feed_type) VALUES ('u1', 'local', 'alice', 'Alice', NULL, ?, NULL, NULL)`).run(NOW)
  const post = store.createLocalPost({ author: { id: 'u1', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: NOW, authUserId: null, feedType: null }, content: 'hi', replyToId: null, now: NOW })
  store.deleteLocalPost({ postId: post.id, actorId: 'u1', now: NOW })
  // marker persists with its canonical permalink; the local logical row survives
  expect(count(raw, 'logical_deleted_local_v2', 'WHERE logical_item_id = ?', post.id)).toBe(1)
  expect(count(raw, 'logical_items_v2', 'WHERE id = ?', post.id)).toBe(1)
  // and it is NEVER a structural tombstone
  const localRow = raw.prepare(`SELECT origin, structural_tombstone FROM logical_items_v2 WHERE id = ?`).get(post.id) as { origin: string; structural_tombstone: number }
  expect(localRow).toEqual({ origin: 'local', structural_tombstone: 0 })

  // structural tombstone: purge a blocked source whose remote item has no descendant → deleted (swept, no lingering row)
  const rid = await makeItem(db, raw, store, 's1', 'https://a.test/f', 'https://a.test/r')
  block(raw, 's1')
  purge(store, 's1', 'c1')
  expect(count(raw, 'logical_items_v2', 'WHERE id = ?', rid)).toBe(0)
})

// ---- reconciliation arrival guard -------------------------------------------

test('reconciliation never resurrects a structural tombstone from an arriving delivery', async () => {
  const { raw, db, store } = await fresh()
  // Build a real item, convert it to a structural tombstone but leave a delivery
  // homed to it (hand-seeded) plus a fresh pending observation job for that delivery.
  const id = await makeItem(db, raw, store, 's1', 'https://a.test/f', 'https://a.test/p')
  const del = raw.prepare(`SELECT id FROM deliveries_v2 WHERE source_id = 's1'`).get() as { id: string }
  raw.prepare(`UPDATE logical_items_v2 SET structural_tombstone = 1, selected_delivery_id = NULL, selected_publisher_id = NULL WHERE id = ?`).run(id)
  // a second version arrives for the same delivery (still homed to the tombstone)
  raw.prepare(
    `INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json)
     VALUES ('v2new', ?, 1, 'fp2', ?, ?, ?, 1, ?, ?, 1, ?, ?)`,
  ).run(del.id, Buffer.from(JSON.stringify({ title: 't2', content: 'd2', link: 'https://a.test/p', inReplyTo: null })), NOW, (raw.prepare(`SELECT run_id FROM observation_versions_v2 WHERE delivery_id = ? LIMIT 1`).get(del.id) as { run_id: string }).run_id, NOW, NOW, JSON.stringify({ title: 't2', sourceName: null }), JSON.stringify({ keyKind: 'permalink', key: 'https://a.test/p', permalink: 'https://a.test/p', inReplyTo: null, enclosures: [] }))
  const runId = (raw.prepare(`SELECT run_id FROM observation_versions_v2 WHERE id = 'v2new'`).get() as { run_id: string }).run_id
  raw.prepare(`INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at) VALUES ('jnew', 'observation', ?, 'v2new', NULL, 'pending', 0, ?, NULL, NULL, ?)`).run(runId, NOW, NOW)
  const before = count(raw, 'logical_journal_v2', 'WHERE logical_item_id = ?', id)

  drain(store)
  const row = raw.prepare(`SELECT structural_tombstone FROM logical_items_v2 WHERE id = ?`).get(id) as { structural_tombstone: number }
  expect(row.structural_tombstone).toBe(1) // never resurrected
  expect(db.read((tx) => projectItem(tx, id, ANON))).toBeUndefined()
  expect(count(raw, 'logical_journal_v2', 'WHERE logical_item_id = ?', id)).toBe(before) // no upsert frame emitted
})

// ---- fault injection --------------------------------------------------------

test('a fault before the ledger write rolls back everything including the tombstone', async () => {
  const { raw, db, store } = await fresh()
  const id = await makeItem(db, raw, store, 's1', 'https://a.test/f', 'https://a.test/p')
  block(raw, 's1')
  const resetBefore = resetCount(raw)
  const itemsBefore = count(raw, 'logical_items_v2')

  expect(() => db.write((tx) => {
    writePurgeTombstone(tx, { sourceId: 's1', canonicalUrl: 'https://a.test/f', category: 'abuse', note: null, actorId: ADMIN, now: NOW })
    removeSourceEvidence(tx, { sourceId: 's1', now: NOW })
    throw new Error('fault-before-ledger')
  })).toThrow('fault-before-ledger')

  expect(count(raw, 'blocked_source_tombstones_v2')).toBe(0)
  expect(resetCount(raw)).toBe(resetBefore)
  expect(count(raw, 'logical_items_v2')).toBe(itemsBefore)
  expect(count(raw, 'remote_sources_v2', 'WHERE id = ?', 's1')).toBe(1) // source intact
  expect(count(raw, 'deliveries_v2')).toBe(1) // evidence intact
  expect(db.read((tx) => projectItem(tx, id, ANON))).toBeUndefined() // blocked ⇒ invisible, still present
})
