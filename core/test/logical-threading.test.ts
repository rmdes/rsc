import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { resolveInitialParent, scheduleOrphanWork, claimOrphanWork, adoptOrphans, projectThread } from '../src/logical/threading.ts'
import { snapshotJournalCursor } from '../src/logical/journal.ts'
import type { NormalizedReplyReference, LogicalItemDto } from '../src/logical/types.ts'

type Raw = InstanceType<typeof Database>

const NOW = '2026-07-23T00:00:00.000Z'

function count(raw: Raw, table: string): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

// A bare logical item row (no local origin, no content) — enough to be a parent
// candidate or a new item awaiting ancestry. parent chains an existing item.
function seedItem(raw: Raw, id: string, parent: string | null = null): void {
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at)
     VALUES (?, 'remote', ?, ?, ?, NULL, NULL, ?)`,
  ).run(id, NOW, parent ? 'resolved' : 'none', parent, NOW)
}

function seedPermalink(raw: Raw, permalink: string, logicalItemId: string): void {
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES ('permalink', ?, ?)`).run(permalink, logicalItemId)
}

function seedScopedOpaque(raw: Raw, sourceId: string, key: string, logicalItemId: string): void {
  raw.prepare(`INSERT INTO logical_identity_keys_v2 (kind, key, logical_item_id) VALUES (?, ?, ?)`).run(`opaque:source:${sourceId}`, key, logicalItemId)
}

// A minimal observation-version chain so a conflict row can carry a real FK.
function seedObservation(raw: Raw, obsId: string): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES ('src', 'https://203.0.113.9/f.xml', 'single_publisher', 'enabled', 'allowed', 'user_subscription', NULL, 0, ?)`,
  ).run(NOW)
  raw.prepare(
    `INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count)
     VALUES ('del', 'src', 'opaque', 'k', ?, ?, 'run', 1)`,
  ).run(NOW, NOW)
  raw.prepare(
    `INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json)
     VALUES (?, 'del', 1, 'fp', X'00', ?, 'run', 0, ?, 'run', 1, '{}', '{}')`,
  ).run(obsId, NOW, NOW)
}

const permalinkRef = (key: string): NormalizedReplyReference => ({ kind: 'permalink', key, scope: null, raw: key })

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  return { raw: repo.raw, db: createDatabaseContext(repo.raw) }
}

test('a null reference resolves to none', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'new')
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'o', reference: null, logicalItemId: 'new' }))
  expect(r).toEqual({ state: 'none', parentLogicalItemId: null })
})

test('an exact permalink resolves to its uniquely owning logical item', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'parent')
  seedPermalink(raw, 'https://ex.test/a', 'parent')
  seedItem(raw, 'new')
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'o', reference: permalinkRef('https://ex.test/a'), logicalItemId: 'new' }))
  expect(r).toEqual({ state: 'resolved', parentLogicalItemId: 'parent' })
})

test('a permalink no item owns is missing (adoptable later, no conflict)', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'new')
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'o', reference: permalinkRef('https://ex.test/nobody'), logicalItemId: 'new' }))
  expect(r).toEqual({ state: 'missing', parentLogicalItemId: null })
  expect(count(raw, 'logical_conflicts_v2')).toBe(0)
})

test('a scoped opaque reference resolves within its source scope', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'parent')
  seedScopedOpaque(raw, 'src1', 'guid-123', 'parent')
  seedItem(raw, 'new')
  const ref: NormalizedReplyReference = { kind: 'opaque', key: 'guid-123', scope: { kind: 'source', id: 'src1' }, raw: 'guid-123' }
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'o', reference: ref, logicalItemId: 'new' }))
  expect(r).toEqual({ state: 'resolved', parentLogicalItemId: 'parent' })
})

test('an unscoped opaque reference is ambiguous and records observation-version evidence', async () => {
  const { raw, db } = await fresh()
  seedObservation(raw, 'obs1')
  seedItem(raw, 'new')
  const ref: NormalizedReplyReference = { kind: 'opaque', key: 'guid-123', scope: null, raw: 'guid-123' }
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'obs1', reference: ref, logicalItemId: 'new' }))
  expect(r).toEqual({ state: 'ambiguous', parentLogicalItemId: null })
  const conflict = raw.prepare(`SELECT logical_item_id, observation_version_id FROM logical_conflicts_v2`).get() as { logical_item_id: string; observation_version_id: string }
  expect(conflict).toEqual({ logical_item_id: 'new', observation_version_id: 'obs1' })
})

test('a self-parenting reference is a cycle conflict, not a resolved edge', async () => {
  const { raw, db } = await fresh()
  seedObservation(raw, 'obs1')
  seedItem(raw, 'new')
  seedPermalink(raw, 'https://ex.test/self', 'new')
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'obs1', reference: permalinkRef('https://ex.test/self'), logicalItemId: 'new' }))
  expect(r.state).toBe('ambiguous')
  expect(count(raw, 'logical_conflicts_v2')).toBe(1)
})

test('a candidate at depth 63 resolves but depth 64 is too deep to place a new edge', async () => {
  const { raw, db } = await fresh()
  seedObservation(raw, 'obs1')
  // chain d0 (root) -> d1 -> ... -> d64 : d[i] has depth i
  let prev: string | null = null
  for (let i = 0; i <= 64; i++) {
    seedItem(raw, `d${i}`, prev)
    seedPermalink(raw, `https://ex.test/d${i}`, `d${i}`)
    prev = `d${i}`
  }
  seedItem(raw, 'newA')
  seedItem(raw, 'newB')
  // parenting under depth-63 puts the new edge at depth 64 — allowed
  const ok = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'obs1', reference: permalinkRef('https://ex.test/d63'), logicalItemId: 'newA' }))
  expect(ok).toEqual({ state: 'resolved', parentLogicalItemId: 'd63' })
  // parenting under depth-64 would place it at depth 65 — rejected as ambiguous
  const tooDeep = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'obs1', reference: permalinkRef('https://ex.test/d64'), logicalItemId: 'newB' }))
  expect(tooDeep.state).toBe('ambiguous')
})

test('a reference resolving to a terminal deleted marker is not a valid new parent', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'dead')
  seedPermalink(raw, 'https://ex.test/dead', 'dead')
  raw.prepare(`INSERT INTO logical_deleted_local_v2 (logical_item_id, canonical_permalink, deleted_at) VALUES ('dead', 'https://ex.test/dead', ?)`).run(NOW)
  seedItem(raw, 'new')
  const r = db.write((tx) => resolveInitialParent(tx, { observationVersionId: 'o', reference: permalinkRef('https://ex.test/dead'), logicalItemId: 'new' }))
  expect(r.state).toBe('missing')
})

// ---------------------------------------------------------------------------
// Task 7: durable late adoption (the orphan worker) — spec §4.2
// ---------------------------------------------------------------------------

const LATER = '2026-07-24T00:00:00.000Z'
let vseq = 0

// A `missing` remote item WITH the first-arrival evidence the orphan worker
// recomputes its awaited reference from (publisher claim -> observation version
// normalized inReplyTo). The frozen schema stores no reference column.
function seedMissingRemote(raw: Raw, itemId: string, inReplyTo: string, opts: { createdAt?: string; publisherId?: string } = {}): void {
  const createdAt = opts.createdAt ?? NOW
  const publisherId = opts.publisherId ?? 'pub1'
  raw.prepare(`INSERT OR IGNORE INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at) VALUES ('src','https://203.0.113.9/f.xml','single_publisher','enabled','allowed','user_subscription',NULL,0,?)`).run(NOW)
  raw.prepare(`INSERT OR IGNORE INTO remote_publishers_v2 (id, canonical_feed_url, identity_level, created_at) VALUES (?, ?, 'feed_anchored', ?)`).run(publisherId, `https://pub/${publisherId}`, NOW)
  const dId = `d-${itemId}`
  raw.prepare(`INSERT OR IGNORE INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count) VALUES (?, 'src','opaque',?,?,?,'run',1)`).run(dId, dId, NOW, NOW)
  const vId = `v-${itemId}-${vseq++}`
  raw.prepare(`INSERT INTO observation_versions_v2 (id, delivery_id, fingerprint_version, fingerprint, canonical_material, arrival_at, run_id, wire_ordinal, last_seen_at, last_seen_run_id, seen_count, raw_evidence_json, normalized_json) VALUES (?, ?, 1, ?, X'00', ?, 'run', 0, ?, 'run', 1, '{}', ?)`).run(vId, dId, vId, NOW, NOW, JSON.stringify({ inReplyTo }))
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'remote', ?, 'missing', NULL, NULL, ?, ?)`).run(itemId, NOW, publisherId, createdAt)
  raw.prepare(`INSERT INTO publisher_claims_v2 (id, logical_item_id, publisher_id, source_id, observation_version_id, evidence_level, first_seen_at) VALUES (?, ?, ?, 'src', ?, 'bound_single_publisher', ?)`).run(`pc-${itemId}`, itemId, publisherId, vId, NOW)
}

function stateOf(raw: Raw, id: string): { parent_state: string; parent_logical_item_id: string | null } {
  return raw.prepare(`SELECT parent_state, parent_logical_item_id FROM logical_items_v2 WHERE id = ?`).get(id) as { parent_state: string; parent_logical_item_id: string | null }
}

function runOrphanBatch(db: ReturnType<typeof createDatabaseContext>, alias: { aliasKind: 'permalink' | 'scoped_opaque'; aliasKey: string; candidateHighWater: string }, limit = 100) {
  return db.write((tx) => {
    scheduleOrphanWork(tx, { ...alias, createdAt: NOW })
    const claim = claimOrphanWork(tx)
    if (!claim) throw new Error('no work claimed')
    return { claim, result: adoptOrphans(tx, { claim, now: NOW, limit }) }
  })
}

test('a scheduled orphan adopts its missing item once the referenced alias exists', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'P')
  seedPermalink(raw, 'https://ex.test/P', 'P')
  seedMissingRemote(raw, 'orphan', 'https://ex.test/P')
  const { claim, result } = runOrphanBatch(db, { aliasKind: 'permalink', aliasKey: 'https://ex.test/P', candidateHighWater: NOW })
  expect(result).toEqual({ adopted: 1, ambiguous: 0, remaining: false })
  expect(stateOf(raw, 'orphan')).toEqual({ parent_state: 'resolved', parent_logical_item_id: 'P' })
  expect((raw.prepare(`SELECT status FROM orphan_work_v2 WHERE id = ?`).get(claim.workId) as { status: string }).status).toBe('complete')
})

test('a successful batch appends exactly one reset (reset-only adoption, no per-item upserts)', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'P')
  seedPermalink(raw, 'https://ex.test/P', 'P')
  seedMissingRemote(raw, 'a', 'https://ex.test/P')
  seedMissingRemote(raw, 'b', 'https://ex.test/P')
  const { result } = runOrphanBatch(db, { aliasKind: 'permalink', aliasKey: 'https://ex.test/P', candidateHighWater: NOW })
  expect(result.adopted).toBe(2)
  const journal = raw.prepare(`SELECT kind FROM logical_journal_v2`).all() as { kind: string }[]
  expect(journal).toEqual([{ kind: 'reset' }])
})

test('adoption examines only candidates through the stable high-water mark', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'P')
  seedPermalink(raw, 'https://ex.test/P', 'P')
  seedMissingRemote(raw, 'early', 'https://ex.test/P', { createdAt: NOW })
  seedMissingRemote(raw, 'late', 'https://ex.test/P', { createdAt: LATER })
  const { result } = runOrphanBatch(db, { aliasKind: 'permalink', aliasKey: 'https://ex.test/P', candidateHighWater: NOW })
  expect(result.adopted).toBe(1)
  expect(stateOf(raw, 'early').parent_state).toBe('resolved')
  expect(stateOf(raw, 'late').parent_state).toBe('missing')
})

test('a would-be cycle makes the orphan ambiguous and it cannot later adopt', async () => {
  const { raw, db } = await fresh()
  seedMissingRemote(raw, 'O', 'https://ex.test/P')
  seedItem(raw, 'P', 'O') // P is a child of O -> adopting O under P is a cycle
  seedPermalink(raw, 'https://ex.test/P', 'P')
  const { result } = runOrphanBatch(db, { aliasKind: 'permalink', aliasKey: 'https://ex.test/P', candidateHighWater: NOW })
  expect(result).toEqual({ adopted: 0, ambiguous: 1, remaining: false })
  expect(stateOf(raw, 'O').parent_state).toBe('ambiguous')
  expect(count(raw, 'logical_conflicts_v2')).toBe(1)
  // a second run cannot re-adopt an already-ambiguous item (never re-selected)
  const again = runOrphanBatch(db, { aliasKind: 'permalink', aliasKey: 'https://ex.test/P', candidateHighWater: NOW })
  expect(again.result.adopted).toBe(0)
  expect(stateOf(raw, 'O').parent_state).toBe('ambiguous')
})

test('the 64-depth formula bounds adoption: depth 63 parent adopts, depth 64 parent is too deep', async () => {
  const { raw, db } = await fresh()
  let prev: string | null = null
  for (let i = 0; i <= 64; i++) {
    seedItem(raw, `d${i}`, prev)
    seedPermalink(raw, `https://ex.test/d${i}`, `d${i}`)
    prev = `d${i}`
  }
  seedMissingRemote(raw, 'okOrphan', 'https://ex.test/d63') // 63 + 1 + 0 = 64 (ok)
  seedMissingRemote(raw, 'deepOrphan', 'https://ex.test/d64') // 64 + 1 + 0 = 65 (too deep)
  // One batch rechecks every ripe candidate against its OWN reference: okOrphan
  // adopts, deepOrphan is too deep -> ambiguous.
  const r = runOrphanBatch(db, { aliasKind: 'permalink', aliasKey: 'https://ex.test/d63', candidateHighWater: NOW })
  expect(r.result).toEqual({ adopted: 1, ambiguous: 1, remaining: false })
  expect(stateOf(raw, 'okOrphan')).toEqual({ parent_state: 'resolved', parent_logical_item_id: 'd63' })
  expect(stateOf(raw, 'deepOrphan').parent_state).toBe('ambiguous')
})

test('the 64-depth formula accounts for the orphan subtree maximum depth', async () => {
  const { raw, db } = await fresh()
  // parent at depth 62; orphan carries a 2-deep subtree -> 62 + 1 + 2 = 65 > 64
  let prev: string | null = null
  for (let i = 0; i <= 62; i++) { seedItem(raw, `d${i}`, prev); prev = `d${i}` }
  seedPermalink(raw, 'https://ex.test/d62', 'd62')
  seedMissingRemote(raw, 'O', 'https://ex.test/d62')
  seedItem(raw, 'c1', 'O')
  seedItem(raw, 'c2', 'c1') // subtree max depth below O = 2
  const { result } = runOrphanBatch(db, { aliasKind: 'permalink', aliasKey: 'https://ex.test/d62', candidateHighWater: NOW })
  expect(result.ambiguous).toBe(1)
  expect(stateOf(raw, 'O').parent_state).toBe('ambiguous')
})

test('the 500-node structural bound makes an unprovable subtree ambiguous', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'P')
  seedPermalink(raw, 'https://ex.test/P', 'P')
  seedMissingRemote(raw, 'O', 'https://ex.test/P')
  for (let i = 0; i < 500; i++) seedItem(raw, `s${i}`, 'O') // O + 500 = 501 nodes
  const { result } = runOrphanBatch(db, { aliasKind: 'permalink', aliasKey: 'https://ex.test/P', candidateHighWater: NOW })
  expect(result.ambiguous).toBe(1)
  expect(stateOf(raw, 'O').parent_state).toBe('ambiguous')
})

test('a small provable subtree adopts and shifts under the new parent', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'P')
  seedPermalink(raw, 'https://ex.test/P', 'P')
  seedMissingRemote(raw, 'O', 'https://ex.test/P')
  seedItem(raw, 'child', 'O')
  const { result } = runOrphanBatch(db, { aliasKind: 'permalink', aliasKey: 'https://ex.test/P', candidateHighWater: NOW })
  expect(result.adopted).toBe(1)
  expect(stateOf(raw, 'O')).toEqual({ parent_state: 'resolved', parent_logical_item_id: 'P' })
  expect(stateOf(raw, 'child').parent_logical_item_id).toBe('O') // subtree edge untouched
})

test('a deleted-marker target is not adopted and the orphan stays missing', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'dead')
  seedPermalink(raw, 'https://ex.test/dead', 'dead')
  raw.prepare(`INSERT INTO logical_deleted_local_v2 (logical_item_id, canonical_permalink, deleted_at) VALUES ('dead', 'https://ex.test/dead', ?)`).run(NOW)
  seedMissingRemote(raw, 'O', 'https://ex.test/dead')
  const { result } = runOrphanBatch(db, { aliasKind: 'permalink', aliasKey: 'https://ex.test/dead', candidateHighWater: NOW })
  expect(result).toEqual({ adopted: 0, ambiguous: 0, remaining: false })
  expect(stateOf(raw, 'O').parent_state).toBe('missing')
  expect(count(raw, 'logical_conflicts_v2')).toBe(0)
})

test('a bounded batch stops at the limit and reports remaining ripe candidates', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'P')
  seedPermalink(raw, 'https://ex.test/P', 'P')
  seedMissingRemote(raw, 'a', 'https://ex.test/P')
  seedMissingRemote(raw, 'b', 'https://ex.test/P')
  const { claim, result } = db.write((tx) => {
    scheduleOrphanWork(tx, { aliasKind: 'permalink', aliasKey: 'https://ex.test/P', candidateHighWater: NOW, createdAt: NOW })
    const c = claimOrphanWork(tx)!
    return { claim: c, result: adoptOrphans(tx, { claim: c, now: NOW, limit: 1 }) }
  })
  expect(result).toEqual({ adopted: 1, ambiguous: 0, remaining: true })
  expect((raw.prepare(`SELECT status FROM orphan_work_v2 WHERE id = ?`).get(claim.workId) as { status: string }).status).toBe('processing')
  // drain the rest
  const rest = db.write((tx) => adoptOrphans(tx, { claim, now: NOW, limit: 100 }))
  expect(rest).toEqual({ adopted: 1, ambiguous: 0, remaining: false })
})

// ---------------------------------------------------------------------------
// Task 7: bounded thread projection — spec §4.3
// ---------------------------------------------------------------------------

// Minimal ordinary-visible DTO; the projection only cares that it is defined.
function dto(id: string, parent: string | null): LogicalItemDto {
  return {
    kind: 'logical_item', id, origin: 'remote', parentResolutionState: parent ? 'resolved' : 'none',
    parentLogicalItemId: parent, threadRootId: null,
    selectedAuthor: { kind: 'remote_publisher', id: 'p', displayName: 'P', canonicalFeedUrl: null, profileAvailable: false, attributionLevel: 'source_scoped_fallback' },
    title: null, content: 'x', contentMarkdown: 'x', permalink: null, originGuid: null, inReplyToRef: null, sourceLink: null, replyContext: null,
    enclosures: [], publishedAt: NOW, updatedAt: null, updatedAtProvenance: null,
    directReplyCount: 0, conversationReplyCount: 0, classification: { personal: false, federated: true },
    removed: false,
  }
}

// Seed with an explicit timeline_sort_at for sibling-ordering tests.
function seedItemTs(raw: Raw, id: string, parent: string | null, ts: string): void {
  raw.prepare(
    `INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES (?, 'remote', ?, ?, ?, NULL, NULL, ?)`,
  ).run(id, ts, parent ? 'resolved' : 'none', parent, NOW)
}

// A projectItem stub: `visible` ids project to a DTO; everything else is undefined.
function visibility(raw: Raw, visible: Set<string>) {
  return (id: string): LogicalItemDto | undefined => {
    if (!visible.has(id)) return undefined
    const row = raw.prepare(`SELECT parent_logical_item_id FROM logical_items_v2 WHERE id = ?`).get(id) as { parent_logical_item_id: string | null }
    return dto(id, row.parent_logical_item_id)
  }
}

test('projectThread reserves the root-to-requested path and orders by depth', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'root')
  seedItem(raw, 'mid', 'root')
  seedItem(raw, 'req', 'mid')
  seedItem(raw, 'reply', 'req')
  const env = db.read((tx) => projectThread(tx, 'req', visibility(raw, new Set(['root', 'mid', 'req', 'reply']))))!
  expect(env.model).toBe('logical-v2')
  expect(env.requestedLogicalItemId).toBe('req')
  expect(env.rootId).toBe('root')
  expect(env.nodes.map((n) => (n.kind === 'item' ? n.item.id : n.logicalItemId))).toEqual(['root', 'mid', 'req', 'reply'])
  expect(env.truncated).toEqual({ depth: false, nodes: false, cycle: false })
})

test('projectThread journalCursor comes from the read snapshot', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'req')
  const [env, cursor] = db.read((tx) => [projectThread(tx, 'req', visibility(raw, new Set(['req'])))!, snapshotJournalCursor(tx)] as const)
  expect(env.journalCursor).toBe(cursor)
})

test('an unavailable connective node becomes a neutral placeholder (structure before policy)', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'root')
  seedItem(raw, 'mid', 'root')
  seedItem(raw, 'req', 'mid')
  const env = db.read((tx) => projectThread(tx, 'req', visibility(raw, new Set(['root', 'req']))))! // mid unavailable
  const midNode = env.nodes.find((n) => (n.kind === 'item' ? n.item.id : n.logicalItemId) === 'mid')!
  expect(midNode.kind).toBe('placeholder')
  expect(midNode).toEqual({ kind: 'placeholder', logicalItemId: 'mid', parentLogicalItemId: 'root', timelineSortAt: NOW, placeholderKind: 'unavailable' })
})

test('an unavailable requested item returns a thread only via a placeholder connecting visible descendants', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'root')
  seedItem(raw, 'req', 'root')
  seedItem(raw, 'reply', 'req')
  const env = db.read((tx) => projectThread(tx, 'req', visibility(raw, new Set(['root', 'reply']))))! // req unavailable
  const reqNode = env.nodes.find((n) => (n.kind === 'item' ? n.item.id : n.logicalItemId) === 'req')!
  expect(reqNode.kind).toBe('placeholder')
  expect(env.nodes.some((n) => n.kind === 'item' && n.item.id === 'reply')).toBe(true)
})

test('an unavailable leaf returns 404 even with visible ancestors', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'root')
  seedItem(raw, 'req', 'root')
  const env = db.read((tx) => projectThread(tx, 'req', visibility(raw, new Set(['root'])))) // req unavailable, no visible descendant
  expect(env).toBeUndefined()
})

test('a thread with no ordinary-visible item is 404', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'root')
  seedItem(raw, 'req', 'root')
  const env = db.read((tx) => projectThread(tx, 'req', visibility(raw, new Set())))
  expect(env).toBeUndefined()
})

test('a nonexistent requested item is 404', async () => {
  const { raw, db } = await fresh()
  const env = db.read((tx) => projectThread(tx, 'ghost', visibility(raw, new Set())))
  expect(env).toBeUndefined()
})

test('a descendant branch with no ordinary-visible node is pruned', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'req')
  seedItem(raw, 'keep', 'req')
  seedItem(raw, 'dropParent', 'req')
  seedItem(raw, 'dropChild', 'dropParent')
  const env = db.read((tx) => projectThread(tx, 'req', visibility(raw, new Set(['req', 'keep']))))!
  const ids = env.nodes.map((n) => (n.kind === 'item' ? n.item.id : n.logicalItemId))
  expect(ids).toContain('keep')
  expect(ids).not.toContain('dropParent')
  expect(ids).not.toContain('dropChild')
})

test('sibling descendants are ordered by (timelineSortAt ASC, logicalItemId ASC)', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'req')
  seedItemTs(raw, 'b', 'req', '2026-07-23T00:00:02.000Z')
  seedItemTs(raw, 'a', 'req', '2026-07-23T00:00:02.000Z') // same ts as b -> id tiebreak a<b
  seedItemTs(raw, 'c', 'req', '2026-07-23T00:00:01.000Z') // earliest ts -> first
  const visible = new Set(['req', 'a', 'b', 'c'])
  const env = db.read((tx) => projectThread(tx, 'req', visibility(raw, visible)))!
  const ids = env.nodes.map((n) => (n.kind === 'item' ? n.item.id : n.logicalItemId))
  expect(ids).toEqual(['req', 'c', 'a', 'b'])
})

test('exactly 500 structural nodes is not truncation; a 501st sets the nodes flag', async () => {
  const { raw, db } = await fresh()
  seedItem(raw, 'req')
  for (let i = 0; i < 499; i++) seedItem(raw, `n${i}`, 'req') // req + 499 = 500 nodes
  const visible499 = new Set<string>(['req'])
  for (let i = 0; i < 499; i++) visible499.add(`n${i}`)
  const at500 = db.read((tx) => projectThread(tx, 'req', visibility(raw, visible499)))!
  expect(at500.truncated.nodes).toBe(false)
  expect(at500.nodes.length).toBe(500)
  seedItem(raw, 'n499', 'req') // now 501 structural nodes
  const over = db.read((tx) => projectThread(tx, 'req', visibility(raw, new Set([...visible499, 'n499']))))!
  expect(over.truncated.nodes).toBe(true)
})

test('thread truncation flags are independent (a deep chain flags depth, not nodes)', async () => {
  const { raw, db } = await fresh()
  const visible = new Set<string>()
  let prev: string | null = null
  for (let i = 0; i <= 66; i++) { seedItem(raw, `x${i}`, prev); visible.add(`x${i}`); prev = `x${i}` }
  // request the deep leaf: the upward walk exceeds 64 edges -> depth truncation, no root
  const env = db.read((tx) => projectThread(tx, 'x66', visibility(raw, visible)))!
  expect(env.truncated.depth).toBe(true)
  expect(env.truncated.nodes).toBe(false)
  expect(env.truncated.cycle).toBe(false)
  expect(env.rootId).toBeNull()
})
