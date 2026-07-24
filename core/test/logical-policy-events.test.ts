import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createService } from '../src/domain/service.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { getJournalMetadata } from '../src/logical/journal.ts'
import { fingerprintRequest } from '../src/domain/source-repository.ts'
import type { CommandEnvelope, User } from '../src/domain/types.ts'

// Task 9 (spec §3.7): the durable journal counterpart of the V1 source-command
// and local-mutation transactions. Governance/federation/attribution-mode
// changes advance the SOURCE's policy_generation AND append exactly one reset;
// pause/resume append none and retain generation; active subscription
// create/remove and local follow/unfollow append a Personal reset without
// advancing generation; a profile change appends one reset; no-op/replay change
// neither. NO source-wide item fan-out — one reset is the whole effect.

type Raw = InstanceType<typeof Database>
const T0 = '2026-01-01T00:00:00.000Z'
const NOW = '2026-07-24T00:00:00.000Z'

function count(raw: Raw, table: string, where = '', ...args: unknown[]): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args) as { n: number }).n
}
function resets(raw: Raw): number {
  return count(raw, 'logical_journal_v2', `WHERE kind = 'reset'`)
}
function journalSeq(raw: Raw): number {
  return getJournalMetadata(raw).highWaterSeq
}
function generation(raw: Raw, sourceId: string): number {
  return (raw.prepare(`SELECT policy_generation AS g FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { g: number }).g
}

function insertSourceRow(raw: Raw, opts: { canonicalUrl: string; attributionMode?: string; operation?: string; governance?: string; federation?: string }): string {
  const id = randomUUID()
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, ?, ?, 'user_subscription', NULL, 0, ?)`,
  ).run(id, opts.canonicalUrl, opts.attributionMode ?? 'single_publisher', opts.operation ?? 'enabled', opts.governance ?? 'allowed', T0)
  if (opts.federation && opts.federation !== 'none') {
    raw.prepare(`INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`).run(id, opts.federation, T0, T0)
  }
  return id
}
function insertSub(raw: Raw, ownerId: string, sourceId: string, state: string): void {
  raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), ownerId, sourceId, state, T0)
}

function adminCmd(actorId: string, commandId: string): CommandEnvelope {
  return { actorScope: 'administrator', actorId, commandId, requestFingerprint: fingerprintRequest(['t', commandId]) }
}
function ownerCmd(actorId: string, commandId: string): CommandEnvelope {
  return { actorScope: 'owner', actorId, commandId, requestFingerprint: fingerprintRequest(['s', commandId]) }
}

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  return repo
}

// --- governance / federation / mode: advance generation + one reset ---------

test('a governance transition advances the source generation and appends exactly one reset', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const id = insertSourceRow(raw, { canonicalUrl: 'https://gov.test/f' })
  expect(generation(raw, id)).toBe(0)

  const r = await repo.transition({ command: adminCmd(admin.id, 'g1'), sourceId: id, action: 'quarantine', category: 'spam', note: null, actorKind: 'administrator', now: NOW })
  expect(r).toMatchObject({ kind: 'applied' })
  expect(generation(raw, id)).toBe(1)
  expect(resets(raw)).toBe(1)
})

test('federation establishment advances generation and appends one reset', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const r = await repo.establishFederation({ command: adminCmd(admin.id, 'f1'), canonicalUrl: 'https://fed.test/f', attributionMode: 'aggregate', category: 'operator_policy', note: null, actorKind: 'administrator', now: NOW })
  expect(r).toMatchObject({ kind: 'established' })
  const src = raw.prepare(`SELECT id FROM remote_sources_v2 WHERE canonical_url = ?`).get('https://fed.test/f') as { id: string }
  expect(generation(raw, src.id)).toBe(1)
  expect(resets(raw)).toBe(1)
})

test('set_attribution_mode advances generation and appends one reset even though many subscriptions change', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const a = await repo.createLocalUser({ handle: 'a', displayName: 'A' })
  const b = await repo.createLocalUser({ handle: 'b', displayName: 'B' })
  const id = insertSourceRow(raw, { canonicalUrl: 'https://mode.test/f' })
  insertSub(raw, a.id, id, 'active')
  insertSub(raw, b.id, id, 'active')

  const r = await repo.transition({ command: adminCmd(admin.id, 'm1'), sourceId: id, action: 'set_attribution_mode', category: 'operator_policy', note: null, attributionMode: 'aggregate', actorKind: 'administrator', now: NOW })
  expect(r).toMatchObject({ kind: 'applied' })
  expect(generation(raw, id)).toBe(1)
  expect(resets(raw)).toBe(1) // ONE reset, not one-per-subscription (no fan-out)
})

// --- pause / resume: no reset, generation retained --------------------------

test('pause and resume append no reset and never advance the generation', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const id = insertSourceRow(raw, { canonicalUrl: 'https://pr.test/f' })

  await repo.transition({ command: adminCmd(admin.id, 'p1'), sourceId: id, action: 'pause', category: null, note: null, actorKind: 'administrator', now: NOW })
  await repo.transition({ command: adminCmd(admin.id, 'r1'), sourceId: id, action: 'resume', category: null, note: null, actorKind: 'administrator', now: NOW })
  expect(generation(raw, id)).toBe(0)
  expect(resets(raw)).toBe(0)
})

// --- subscription create / remove: Personal reset, no generation advance ----

test('creating an ACTIVE subscription appends one Personal reset and does not advance generation', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'own', displayName: 'Own' })
  const r = await repo.resolveAndSubscribeSource({ command: ownerCmd(owner.id, 's1'), ownerId: owner.id, canonicalUrl: 'https://sub.test/f', cap: 100, now: NOW })
  expect(r).toMatchObject({ kind: 'source', created: true })
  const src = raw.prepare(`SELECT id FROM remote_sources_v2 WHERE canonical_url = ?`).get('https://sub.test/f') as { id: string }
  expect(generation(raw, src.id)).toBe(0) // membership change, not source policy
  expect(resets(raw)).toBe(1)
})

test('creating a PENDING (quarantined) subscription is inactive-to-inactive and appends no reset', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'own', displayName: 'Own' })
  const id = insertSourceRow(raw, { canonicalUrl: 'https://q.test/f', governance: 'quarantined' })
  const r = await repo.resolveAndSubscribeSource({ command: ownerCmd(owner.id, 's2'), ownerId: owner.id, canonicalUrl: 'https://q.test/f', cap: 100, now: NOW })
  expect(r).toMatchObject({ kind: 'source', subscription: { subscriptionState: 'pending' } })
  expect(generation(raw, id)).toBe(0)
  expect(resets(raw)).toBe(0)
})

test('removing an ACTIVE subscription appends one reset; removing a pending one appends none', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'own', displayName: 'Own' })
  const active = insertSourceRow(raw, { canonicalUrl: 'https://rm.test/active' })
  const pending = insertSourceRow(raw, { canonicalUrl: 'https://rm.test/pending' })
  insertSub(raw, owner.id, active, 'active')
  insertSub(raw, owner.id, pending, 'pending')

  await repo.unsubscribe({ command: ownerCmd(owner.id, 'u1'), ownerId: owner.id, sourceId: pending, now: NOW })
  expect(resets(raw)).toBe(0) // inactive removal
  await repo.unsubscribe({ command: ownerCmd(owner.id, 'u2'), ownerId: owner.id, sourceId: active, now: NOW })
  expect(resets(raw)).toBe(1) // active removal
})

test('following a local account appends one reset only when a new edge is created', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'own', displayName: 'Own' })
  const target = await repo.createLocalUser({ handle: 'tgt', displayName: 'Tgt' })
  await repo.followLocalAccount({ command: ownerCmd(owner.id, 'l1'), ownerId: owner.id, targetId: target.id, now: NOW })
  expect(resets(raw)).toBe(1)
  // a second, idempotent follow (different commandId, same edge) creates nothing → no reset
  await repo.followLocalAccount({ command: ownerCmd(owner.id, 'l2'), ownerId: owner.id, targetId: target.id, now: NOW })
  expect(resets(raw)).toBe(1)
})

// --- no-op / replay: neither generation nor journal changes ------------------

test('a no-op (conflict) transition changes neither generation nor journal', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const id = insertSourceRow(raw, { canonicalUrl: 'https://noop.test/f', governance: 'blocked' })
  const r = await repo.transition({ command: adminCmd(admin.id, 'n1'), sourceId: id, action: 'quarantine', category: 'spam', note: null, actorKind: 'administrator', now: NOW })
  expect(r).toEqual({ kind: 'conflict' })
  expect(generation(raw, id)).toBe(0)
  expect(journalSeq(raw)).toBe(0)
})

test('a command-ledger REPLAY appends no new reset and does not advance generation again', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const id = insertSourceRow(raw, { canonicalUrl: 'https://replay.test/f' })
  const cmd = adminCmd(admin.id, 'rep1')
  await repo.transition({ command: cmd, sourceId: id, action: 'quarantine', category: 'spam', note: null, actorKind: 'administrator', now: NOW })
  expect(generation(raw, id)).toBe(1)
  expect(resets(raw)).toBe(1)
  // identical retry replays the stored result — no second effect
  await repo.transition({ command: cmd, sourceId: id, action: 'quarantine', category: 'spam', note: null, actorKind: 'administrator', now: NOW })
  expect(generation(raw, id)).toBe(1)
  expect(resets(raw)).toBe(1)
})

// --- fault injection: journal + audit + generation + ledger commit as ONE ----

test('a fault before the ledger write rolls back the domain change, audit, generation, AND journal together', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const admin = await repo.createLocalUser({ handle: 'admin', displayName: 'Admin' })
  const id = insertSourceRow(raw, { canonicalUrl: 'https://fault.test/f' })
  // Force storeCommand (the last write in the transaction) to throw: dropping the
  // ledger table makes its INSERT fail, so the whole BEGIN IMMEDIATE rolls back.
  raw.exec('DROP TABLE command_ledger_v2')
  await expect(repo.transition({ command: adminCmd(admin.id, 'x1'), sourceId: id, action: 'quarantine', category: 'spam', note: null, actorKind: 'administrator', now: NOW })).rejects.toThrow()

  expect((raw.prepare(`SELECT governance FROM remote_sources_v2 WHERE id = ?`).get(id) as { governance: string }).governance).toBe('allowed')
  expect(generation(raw, id)).toBe(0)
  expect(count(raw, 'source_audit_v2', 'WHERE source_id = ?', id)).toBe(0)
  expect(journalSeq(raw)).toBe(0)
})

// --- evidence-aware last-subscription cleanup (V3 Task 7 — replaces the interim
//     Rev 5 RC4 retain-if-RESTRICT-child rule) ------------------------------

test('removing the last subscription REMOVES the source and its evidence (evidence-aware cleanup)', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'own', displayName: 'Own' })
  const id = insertSourceRow(raw, { canonicalUrl: 'https://keep.test/f' })
  insertSub(raw, owner.id, id, 'active')
  // a deliveries_v2 row is evidence — Task 7 cleanup now REMOVES it (via
  // removeSourceEvidence) instead of retaining the source, then deletes the source.
  raw.prepare(
    `INSERT INTO deliveries_v2 (id, source_id, key_kind, key, first_seen_at, last_seen_at, last_seen_run_id, seen_count)
     VALUES (?, ?, 'guid', 'k1', ?, ?, 'run1', 1)`,
  ).run(randomUUID(), id, T0, T0)

  const r = await repo.unsubscribe({ command: ownerCmd(owner.id, 'u1'), ownerId: owner.id, sourceId: id, now: NOW })
  expect(r).toEqual({ kind: 'removed', sourceRemoved: true })
  expect(count(raw, 'remote_sources_v2', 'WHERE id = ?', id)).toBe(0) // source + evidence gone
  expect(count(raw, 'deliveries_v2', 'WHERE source_id = ?', id)).toBe(0)
})

test('removing the last subscription deletes an orphan source with no RESTRICT children', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'own', displayName: 'Own' })
  const id = insertSourceRow(raw, { canonicalUrl: 'https://drop.test/f' })
  insertSub(raw, owner.id, id, 'active')

  const r = await repo.unsubscribe({ command: ownerCmd(owner.id, 'u1'), ownerId: owner.id, sourceId: id, now: NOW })
  expect(r).toEqual({ kind: 'removed', sourceRemoved: true })
  expect(count(raw, 'remote_sources_v2', 'WHERE id = ?', id)).toBe(0)
})

// --- flag-gated local follow / unfollow / profile via the service + store ----

function withLogical(repo: Awaited<ReturnType<typeof createSqliteRepository>>) {
  return createService(repo, createEventBus(), 'https://cast.example', createLogicalStore(createDatabaseContext(repo.raw)))
}

test('service.addFollow / removeFollow append one Personal reset each when v2 is on', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const svc = withLogical(repo)
  const me = await repo.createLocalUser({ handle: 'me', displayName: 'Me' })
  const you = await repo.createLocalUser({ handle: 'you', displayName: 'You' }) as User

  await svc.addFollow(me, you)
  expect(resets(raw)).toBe(1)
  await svc.addFollow(me, you) // idempotent → no new edge → no reset
  expect(resets(raw)).toBe(1)
  await svc.removeFollow(me.id, you)
  expect(resets(raw)).toBe(2)
})

test('service.updateUserProfile appends one reset when v2 is on', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const svc = withLogical(repo)
  const me = await repo.createLocalUser({ handle: 'me', displayName: 'Me' })
  const updated = await svc.updateUserProfile(me.id, { displayName: 'Renamed' })
  expect(updated.displayName).toBe('Renamed')
  expect(resets(raw)).toBe(1)
})

test('with v2 OFF the same service writes NO journal row (flag-off isolation)', async () => {
  const repo = await fresh()
  const raw = repo.raw
  const svc = createService(repo, createEventBus(), 'https://cast.example') // no logical store
  const me = await repo.createLocalUser({ handle: 'me', displayName: 'Me' })
  const you = await repo.createLocalUser({ handle: 'you', displayName: 'You' }) as User
  await svc.addFollow(me, you)
  await svc.updateUserProfile(me.id, { displayName: 'Renamed' })
  expect(journalSeq(raw)).toBe(0)
})
