import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

type Raw = InstanceType<typeof Database>

const PUBLIC_URL = 'https://cast.example'
const T0 = '2026-01-01T00:00:00.000Z'

interface Axes { operation: string; governance: string; federation: string }
const DEFAULT_AXES: Axes = { operation: 'enabled', governance: 'allowed', federation: 'none' }

// Axis values are plain strings so the table-driven cases below can seed one
// axis by name; the SQL CHECKs reject anything the tables don't allow.
function insertSourceRow(raw: Raw, opts: { canonicalUrl: string; attributionMode?: string } & Partial<Axes>): string {
  const id = randomUUID()
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, ?, ?, 'user_subscription', NULL, 0, ?)`,
  ).run(id, opts.canonicalUrl, opts.attributionMode ?? 'single_publisher', opts.operation ?? 'enabled', opts.governance ?? 'allowed', T0)
  if (opts.federation && opts.federation !== 'none') {
    raw.prepare(
      `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`,
    ).run(id, opts.federation, T0, T0)
  }
  return id
}

function insertSubscription(raw: Raw, ownerId: string, sourceId: string, state: 'active' | 'pending' | 'pending_review'): void {
  raw.prepare(
    `INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), ownerId, sourceId, state, T0)
}

function readAxes(raw: Raw, sourceId: string): Axes {
  const s = raw.prepare(`SELECT operation, governance FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { operation: string; governance: string }
  const f = raw.prepare(`SELECT status FROM federation_relationships_v2 WHERE source_id = ?`).get(sourceId) as { status: string } | undefined
  return { operation: s.operation, governance: s.governance, federation: f ? f.status : 'none' }
}

// Which axis a table cell's from/to value belongs to — the success table below
// names only the value, never the axis.
function axisOf(value: string): keyof Axes {
  if (value === 'enabled' || value === 'paused') return 'operation'
  if (value === 'allowed' || value === 'quarantined' || value === 'blocked') return 'governance'
  return 'federation'
}

function subStates(raw: Raw, sourceId: string): string[] {
  return (raw.prepare(`SELECT state FROM source_subscriptions_v2 WHERE source_id = ? ORDER BY state`).all(sourceId) as { state: string }[]).map((r) => r.state)
}

function counts(raw: Raw, sourceId: string): { audit: number; ledger: number } {
  return {
    audit: (raw.prepare(`SELECT count(*) AS n FROM source_audit_v2 WHERE source_id = ?`).get(sourceId) as { n: number }).n,
    ledger: (raw.prepare(`SELECT count(*) AS n FROM command_ledger_v2`).get() as { n: number }).n,
  }
}

// --- Step 2: the complete transition table ---

const success = [
  ['pause', 'enabled', 'paused'], ['resume', 'paused', 'enabled'],
  ['quarantine', 'allowed', 'quarantined'], ['allow', 'quarantined', 'allowed'],
  ['approve', 'pending', 'approved'], ['reject', 'pending', 'none'],
  ['revoke', 'approved', 'none'], ['block', 'allowed', 'blocked'],
  ['block', 'quarantined', 'blocked'], ['unblock', 'blocked', 'quarantined'],
] as const

test('every success cell applies, preserves the axes it does not mention, and writes exactly one audit and one ledger row', async () => {
  for (const [action, from, to] of success) {
    const repo = await createSqliteRepository(':memory:')
    const raw = repo.raw
    const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
    const service = createSourceService(repo, PUBLIC_URL)

    const axis = axisOf(from)
    const seed: Partial<Axes> = {}
    seed[axis] = from
    const id = insertSourceRow(raw, { canonicalUrl: `https://cell.test/${action}-${from}`, ...seed })

    const result = await service.transition({
      sourceId: id, action, category: 'operator_policy', note: null,
      commandId: `c-${action}-${from}`, actorId: admin.id, actorKind: 'administrator',
    })
    expect(result, `${action} from ${from}`).toMatchObject({ kind: 'applied' })
    expect(readAxes(raw, id), `${action}: ${from} -> ${to}`).toEqual({ ...DEFAULT_AXES, [axis]: to })
    expect(counts(raw, id)).toEqual({ audit: 1, ledger: 1 })

    repo.close()
  }
})

test('the applied result carries the post-transition source and its audit event', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)
  const id = insertSourceRow(raw, { canonicalUrl: 'https://shape.test/feed' })

  const result = await service.transition({
    sourceId: id, action: 'quarantine', category: 'spam', note: 'spammy',
    commandId: 'c1', actorId: admin.id, actorKind: 'administrator',
  })
  expect(result).toMatchObject({
    kind: 'applied',
    source: { id, governance: 'quarantined', operation: 'enabled' },
    audit: { sourceId: id, commandId: 'c1', actorId: admin.id, actorKind: 'administrator', action: 'quarantine', category: 'spam', note: 'spammy' },
  })

  repo.close()
})

const conflicts = [
  // The only source-governance exits from blocked are explicit unblock or purge.
  { action: 'quarantine', seed: { governance: 'blocked' } },
  { action: 'allow', seed: { governance: 'blocked' } },
  // A blocked pending candidate must be unblocked before approval.
  { action: 'approve', seed: { governance: 'blocked', federation: 'pending' } },
  // No relationship to act on.
  { action: 'reject', seed: {} },
  { action: 'revoke', seed: {} },
] as const

test('the pinned conflict cells are refused and write nothing', async () => {
  for (const { action, seed } of conflicts) {
    const repo = await createSqliteRepository(':memory:')
    const raw = repo.raw
    const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
    const service = createSourceService(repo, PUBLIC_URL)
    const id = insertSourceRow(raw, { canonicalUrl: `https://conflict.test/${action}`, ...seed })
    const before = readAxes(raw, id)

    const result = await service.transition({
      sourceId: id, action, category: 'operator_policy', note: null,
      commandId: 'c1', actorId: admin.id, actorKind: 'administrator',
    })
    expect(result, `${action} on ${JSON.stringify(seed)}`).toEqual({ kind: 'conflict' })
    expect(readAxes(raw, id)).toEqual(before)
    expect(counts(raw, id)).toEqual({ audit: 0, ledger: 0 })

    repo.close()
  }
})

test('pause, resume, reject and revoke are permitted while blocked and leave governance blocked', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  const paused = insertSourceRow(raw, { canonicalUrl: 'https://blk.test/1', governance: 'blocked' })
  expect(await service.transition({ sourceId: paused, action: 'pause', category: null, note: null, commandId: 'p1', actorId: admin.id, actorKind: 'administrator' })).toMatchObject({ kind: 'applied' })
  expect(readAxes(raw, paused)).toEqual({ operation: 'paused', governance: 'blocked', federation: 'none' })
  expect(await service.transition({ sourceId: paused, action: 'resume', category: null, note: null, commandId: 'r1', actorId: admin.id, actorKind: 'administrator' })).toMatchObject({ kind: 'applied' })
  expect(readAxes(raw, paused)).toEqual({ operation: 'enabled', governance: 'blocked', federation: 'none' })

  const rejected = insertSourceRow(raw, { canonicalUrl: 'https://blk.test/2', governance: 'blocked', federation: 'pending' })
  expect(await service.transition({ sourceId: rejected, action: 'reject', category: 'operator_policy', note: null, commandId: 'j1', actorId: admin.id, actorKind: 'administrator' })).toMatchObject({ kind: 'applied' })
  expect(readAxes(raw, rejected)).toEqual({ operation: 'enabled', governance: 'blocked', federation: 'none' })

  const revoked = insertSourceRow(raw, { canonicalUrl: 'https://blk.test/3', governance: 'blocked', federation: 'approved' })
  expect(await service.transition({ sourceId: revoked, action: 'revoke', category: 'operator_policy', note: null, commandId: 'v1', actorId: admin.id, actorKind: 'administrator' })).toMatchObject({ kind: 'applied' })
  expect(readAxes(raw, revoked)).toEqual({ operation: 'enabled', governance: 'blocked', federation: 'none' })

  repo.close()
})

test('a paused source stays paused across governance actions (mirrors the blocked-preserves-operation coverage)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  const quarantined = insertSourceRow(raw, { canonicalUrl: 'https://paused.test/1', operation: 'paused' })
  expect(await service.transition({ sourceId: quarantined, action: 'quarantine', category: 'operator_policy', note: null, commandId: 'pq1', actorId: admin.id, actorKind: 'administrator' })).toMatchObject({ kind: 'applied' })
  expect(readAxes(raw, quarantined)).toEqual({ operation: 'paused', governance: 'quarantined', federation: 'none' })

  const blocked = insertSourceRow(raw, { canonicalUrl: 'https://paused.test/2', operation: 'paused' })
  expect(await service.transition({ sourceId: blocked, action: 'block', category: 'operator_policy', note: null, commandId: 'pb1', actorId: admin.id, actorKind: 'administrator' })).toMatchObject({ kind: 'applied' })
  expect(readAxes(raw, blocked)).toEqual({ operation: 'paused', governance: 'blocked', federation: 'none' })

  const approved = insertSourceRow(raw, { canonicalUrl: 'https://paused.test/3', operation: 'paused', federation: 'pending' })
  expect(await service.transition({ sourceId: approved, action: 'approve', category: 'operator_policy', note: null, commandId: 'pa1', actorId: admin.id, actorKind: 'administrator' })).toMatchObject({ kind: 'applied' })
  expect(readAxes(raw, approved)).toEqual({ operation: 'paused', governance: 'allowed', federation: 'approved' })

  repo.close()
})

test('governance, federation and mode actions require an enum category; pause and resume allow null', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  const id = insertSourceRow(raw, { canonicalUrl: 'https://cat.test/feed', federation: 'pending' })
  for (const action of ['quarantine', 'approve', 'block', 'set_attribution_mode'] as const) {
    const result = await service.transition({
      sourceId: id, action, category: null, note: null, attributionMode: 'aggregate',
      commandId: `n-${action}`, actorId: admin.id, actorKind: 'administrator',
    })
    expect(result, `${action} with a null category`).toEqual({ kind: 'conflict' })
  }
  expect(readAxes(raw, id)).toEqual({ operation: 'enabled', governance: 'allowed', federation: 'pending' })
  expect(counts(raw, id)).toEqual({ audit: 0, ledger: 0 })

  // unblock also requires a category (seeded separately: it needs a blocked source).
  const blocked = insertSourceRow(raw, { canonicalUrl: 'https://cat.test/blocked', governance: 'blocked' })
  expect(await service.transition({ sourceId: blocked, action: 'unblock', category: null, note: null, commandId: 'n-unblock', actorId: admin.id, actorKind: 'administrator' })).toEqual({ kind: 'conflict' })

  // pause/resume are operational, never moderation — a null category is fine.
  expect(await service.transition({ sourceId: id, action: 'pause', category: null, note: null, commandId: 'ok-pause', actorId: admin.id, actorKind: 'administrator' })).toMatchObject({ kind: 'applied' })
  expect(readAxes(raw, id).operation).toBe('paused')

  repo.close()
})

test('set_attribution_mode requires an attributionMode and moves active and pending subscriptions to pending_review on aggregate', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
  const b = await repo.createLocalUser({ handle: 'b', displayName: 'B' })
  const c = await repo.createLocalUser({ handle: 'c', displayName: 'C' })
  const service = createSourceService(repo, PUBLIC_URL)

  const id = insertSourceRow(raw, { canonicalUrl: 'https://mode.test/feed' })
  insertSubscription(raw, a.id, id, 'active')
  insertSubscription(raw, b.id, id, 'pending')
  insertSubscription(raw, c.id, id, 'pending_review')

  // Missing attributionMode -> the invalid-transition result, nothing written.
  expect(await service.transition({
    sourceId: id, action: 'set_attribution_mode', category: 'operator_policy', note: null,
    commandId: 'm0', actorId: admin.id, actorKind: 'administrator',
  })).toEqual({ kind: 'conflict' })
  expect(counts(raw, id)).toEqual({ audit: 0, ledger: 0 })

  const result = await service.transition({
    sourceId: id, action: 'set_attribution_mode', attributionMode: 'aggregate',
    category: 'operator_policy', note: null, commandId: 'm1', actorId: admin.id, actorKind: 'administrator',
  })
  expect(result).toMatchObject({ kind: 'applied', source: { attributionMode: 'aggregate' } })
  expect(subStates(raw, id)).toEqual(['pending_review', 'pending_review', 'pending_review'])
  expect(readAxes(raw, id)).toEqual({ operation: 'enabled', governance: 'allowed', federation: 'none' })
  expect(counts(raw, id)).toEqual({ audit: 1, ledger: 1 })

  repo.close()
})

test('pause never applies a caller-supplied attributionMode (the set_attribution_mode action guard is load-bearing)', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
  const b = await repo.createLocalUser({ handle: 'b', displayName: 'B' })
  const service = createSourceService(repo, PUBLIC_URL)

  const id = insertSourceRow(raw, { canonicalUrl: 'https://guard.test/feed' })
  insertSubscription(raw, a.id, id, 'active')
  insertSubscription(raw, b.id, id, 'pending')

  const result = await service.transition({
    sourceId: id, action: 'pause', attributionMode: 'aggregate', category: null, note: null,
    commandId: 'guard1', actorId: admin.id, actorKind: 'administrator',
  })
  expect(result).toMatchObject({ kind: 'applied' })
  expect((raw.prepare(`SELECT attribution_mode FROM remote_sources_v2 WHERE id = ?`).get(id) as { attribution_mode: string }).attribution_mode).toBe('single_publisher')
  expect(subStates(raw, id)).toEqual(['active', 'pending'])

  repo.close()
})

test('allow and approve activate ordinary pending subscriptions on a single-publisher source and never pending_review', async () => {
  for (const action of ['allow', 'approve'] as const) {
    const repo = await createSqliteRepository(':memory:')
    const raw = repo.raw
    const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
    const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
    const b = await repo.createLocalUser({ handle: 'b', displayName: 'B' })
    const c = await repo.createLocalUser({ handle: 'c', displayName: 'C' })
    const service = createSourceService(repo, PUBLIC_URL)

    // Quarantined for both: `allow` lifts it directly, `approve` lifts it as part
    // of approving a quarantined federation candidate.
    const id = insertSourceRow(raw, { canonicalUrl: `https://act.test/${action}`, governance: 'quarantined', federation: action === 'approve' ? 'pending' : 'none' })
    insertSubscription(raw, a.id, id, 'pending')
    insertSubscription(raw, b.id, id, 'pending_review')
    insertSubscription(raw, c.id, id, 'active')

    const result = await service.transition({
      sourceId: id, action, category: 'operator_policy', note: null,
      commandId: 'x1', actorId: admin.id, actorKind: 'administrator',
    })
    expect(result, action).toMatchObject({ kind: 'applied', source: { governance: 'allowed' } })
    expect(subStates(raw, id), action).toEqual(['active', 'active', 'pending_review'])

    repo.close()
  }
})

test('an aggregate source never auto-activates pending subscriptions when allowed', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
  const service = createSourceService(repo, PUBLIC_URL)

  const id = insertSourceRow(raw, { canonicalUrl: 'https://agg.test/feed', governance: 'quarantined', attributionMode: 'aggregate' })
  insertSubscription(raw, a.id, id, 'pending')

  expect(await service.transition({ sourceId: id, action: 'allow', category: 'operator_policy', note: null, commandId: 'a1', actorId: admin.id, actorKind: 'administrator' })).toMatchObject({ kind: 'applied', source: { governance: 'allowed' } })
  expect(subStates(raw, id)).toEqual(['pending'])

  repo.close()
})

test('an unknown source id returns unknown, ledgered idempotently', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)

  const input = { sourceId: 'nope', action: 'block' as const, category: 'abuse' as const, note: null, commandId: 'u1', actorId: admin.id, actorKind: 'administrator' as const }
  expect(await service.transition(input)).toEqual({ kind: 'unknown' })
  expect(await service.transition(input)).toEqual({ kind: 'unknown' })
  expect((raw.prepare(`SELECT count(*) AS n FROM command_ledger_v2`).get() as { n: number }).n).toBe(1)

  repo.close()
})

test('an identical retry replays; the same command id with a changed action or mode conflicts', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const service = createSourceService(repo, PUBLIC_URL)
  const id = insertSourceRow(raw, { canonicalUrl: 'https://replay.test/feed' })

  const base = { sourceId: id, action: 'quarantine' as const, category: 'spam' as const, note: null, commandId: 'k1', actorId: admin.id, actorKind: 'administrator' as const }
  const first = await service.transition(base)
  expect(first).toMatchObject({ kind: 'applied' })
  expect(counts(raw, id)).toEqual({ audit: 1, ledger: 1 })

  // Identical retry: the stored result, no second audit row.
  expect(await service.transition(base)).toEqual(first)
  expect(counts(raw, id)).toEqual({ audit: 1, ledger: 1 })

  // Same command id, different action -> conflict (fingerprint mismatch).
  expect(await service.transition({ ...base, action: 'block' })).toEqual({ kind: 'conflict' })
  // Same command id, different attributionMode -> conflict.
  expect(await service.transition({ ...base, action: 'set_attribution_mode', attributionMode: 'aggregate' })).toEqual({ kind: 'conflict' })
  expect(counts(raw, id)).toEqual({ audit: 1, ledger: 1 })
  expect(readAxes(raw, id).governance).toBe('quarantined')

  repo.close()
})
