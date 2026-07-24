import { test, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createSourceService, createSourcePlane } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createVerificationRunner } from '../src/logical/verification.ts'
import { unblockTombstone } from '../src/logical/tombstones.ts'
import type { CommandEnvelope, AuditCategory, User } from '../src/domain/types.ts'
import type { AcquisitionRun } from '../src/logical/types.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'

// V3 Task 7 — tombstone-aware resolution (oracle-free), unblock, and the item
// effects V1 deferred. Resolution of a URL matching a tombstone's canonical URL
// OR one of its aliases returns the EXISTING generic unavailable result — a
// caller cannot distinguish a tombstoned URL from any other unavailable one.

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'
const PUBLIC_URL = 'https://cast.example'
const ADMIN = 'admin-1'

const publicLookup: LookupFn = async () => [{ address: '93.184.216.34' }]
const fp = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const env = (commandId: string, requestFingerprint: string): CommandEnvelope =>
  ({ actorScope: 'administrator', actorId: ADMIN, commandId, requestFingerprint })
const count = (raw: Raw, table: string, where = '', ...args: unknown[]): number =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args) as { n: number }).n

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const db = createDatabaseContext(raw)
  const store = createLogicalStore(db)
  const service = createSourceService(repo, PUBLIC_URL, publicLookup, store.isTombstoned)
  return { repo, raw, db, store, service }
}

// Hand-seed a block+purge tombstone with optional aliases; returns its id.
function seedTombstone(raw: Raw, canonicalUrl: string, aliases: string[] = [], category: AuditCategory = 'abuse'): string {
  const id = randomUUID()
  raw.prepare(
    `INSERT INTO blocked_source_tombstones_v2 (id, canonical_url, action, category, actor_id, note, created_at, updated_at)
     VALUES (?, ?, 'purge', ?, ?, NULL, ?, ?)`,
  ).run(id, canonicalUrl, category, ADMIN, NOW, NOW)
  for (const a of aliases) raw.prepare(`INSERT INTO tombstone_aliases_v2 (url, tombstone_id, created_at) VALUES (?, ?, ?)`).run(a, id, NOW)
  return id
}

const redirect = (to: string): Response => new Response(null, { status: 308, headers: { location: to } })
function seedAllowedSource(raw: Raw, id: string, url: string): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'user_subscription', NULL, 0, ?)`,
  ).run(id, url, NOW)
}
function countingFetch(map: Record<string, () => Response>): { fn: typeof fetch; callsFor: (u: string) => number } {
  const byUrl: Record<string, number> = {}
  const fn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    byUrl[url] = (byUrl[url] ?? 0) + 1
    const h = map[url]
    if (!h) throw new Error(`no route: ${url}`)
    return h()
  }) as unknown as typeof fetch
  return { fn, callsFor: (u) => byUrl[u] ?? 0 }
}

// ---- resolution: oracle-free (spec §5.1) -----------------------------------

test('subscribe to a tombstoned canonical URL OR an alias returns the generic unavailable result', async () => {
  const { repo, raw, service } = await fresh()
  const owner = await repo.createLocalUser({ handle: 'owner', displayName: 'Owner' }) as User
  seedTombstone(raw, 'https://tomb.test/feed', ['https://alias.test/feed'])

  // Byte-identical to the ordinary unavailable body (SSRF/invalid-URL path).
  expect(await service.subscribeByUrl(owner, 'https://tomb.test/feed', 's1')).toEqual({ kind: 'unavailable' })
  expect(await service.subscribeByUrl(owner, 'https://alias.test/feed', 's2')).toEqual({ kind: 'unavailable' })
  // No source was created for either — indistinguishable from never-existed.
  expect(count(raw, 'remote_sources_v2')).toBe(0)
  repo.close()
})

test('OPML import folds a tombstoned URL into the generic unavailable bucket', async () => {
  const { repo, raw, service } = await fresh()
  const owner = await repo.createLocalUser({ handle: 'owner2', displayName: 'Owner2' }) as User
  seedTombstone(raw, 'https://tomb.test/feed')
  const xml = `<?xml version="1.0"?><opml version="2.0"><body>
    <outline type="rss" xmlUrl="https://tomb.test/feed"/>
    <outline type="rss" xmlUrl="https://good.test/feed"/>
  </body></opml>`
  const result = await service.importOpml(owner, xml, 'imp1')
  expect(result).toMatchObject({ unavailable: 1, active: 1 })
  // The tombstoned URL created no source; only the good one did.
  const urls = (raw.prepare(`SELECT canonical_url FROM remote_sources_v2`).all() as { canonical_url: string }[]).map((r) => r.canonical_url)
  expect(urls).toEqual(['https://good.test/feed'])
  repo.close()
})

test('federation establishment against a tombstoned URL returns unavailable', async () => {
  const { repo, raw, service } = await fresh()
  seedTombstone(raw, 'https://tomb.test/feed')
  const result = await service.establishFederation({
    url: 'https://tomb.test/feed', attributionMode: 'aggregate', category: 'operator_policy',
    note: null, commandId: 'fed1', actorId: ADMIN, actorKind: 'administrator',
  })
  expect(result).toEqual({ kind: 'unavailable' })
  expect(count(raw, 'remote_sources_v2')).toBe(0)
  repo.close()
})

test('an acquisition redirect hop landing on a tombstoned URL is rejected and never fetched', async () => {
  const { repo, raw, db } = await fresh()
  seedAllowedSource(raw, 'src-r', 'https://agg.test/feed')
  seedTombstone(raw, 'https://evil.test/feed')
  const fetch = countingFetch({ 'https://agg.test/feed': () => redirect('https://evil.test/feed') })
  const eng = createAcquisition({ db, fetchFn: fetch.fn, lookupFn: publicLookup, now: () => NOW })
  const run = await eng.acquireSource('src-r', { kind: 'scheduled' }, undefined) as AcquisitionRun
  expect(fetch.callsFor('https://evil.test/feed')).toBe(0) // tombstoned target never fetched
  expect(run.outcome).toBe('operational_failure')
  expect(count(raw, 'deliveries_v2')).toBe(0)
  repo.close()
})

test('a verification redirect hop landing on a tombstoned URL is rejected and never fetched', async () => {
  const { repo, raw, db, store } = await fresh()
  const ORIGIN = 'https://origin.test/feed'
  const EVIL = 'https://evil.test/feed'
  seedTombstone(raw, EVIL)
  seedAllowedSource(raw, 's-agg', 'https://agg.test/f')
  raw.prepare(`INSERT INTO logical_items_v2 (id, origin, timeline_sort_at, parent_state, parent_logical_item_id, selected_delivery_id, selected_publisher_id, created_at) VALUES ('li-v', 'remote', ?, 'none', NULL, NULL, NULL, ?)`).run(NOW, NOW)
  raw.prepare(`INSERT INTO verification_checks_v2 (id, logical_item_id, source_id, publisher_feed_url, batch_key, state, created_at, resolved_at) VALUES (?, 'li-v', 's-agg', ?, ?, 'pending', ?, NULL)`).run(randomUUID(), ORIGIN, ORIGIN, NOW)
  const jobId = randomUUID()
  raw.prepare(`INSERT INTO reconciliation_jobs_v2 (id, kind, run_id, observation_version_id, verification_batch_key, status, attempts, next_attempt_at, failure_category, diagnostic, created_at) VALUES (?, 'verification', NULL, NULL, ?, 'pending', 0, ?, NULL, NULL, ?)`).run(jobId, ORIGIN, NOW, NOW)

  const fetch = countingFetch({ [ORIGIN]: () => redirect(EVIL) })
  const runner = createVerificationRunner({ db, store, fetchFn: fetch.fn, lookupFn: publicLookup, now: () => NOW })
  await runner.runVerificationBatch({ kind: 'verification', jobId, batchKey: ORIGIN }, NOW)
  expect(fetch.callsFor(ORIGIN)).toBe(1)
  expect(fetch.callsFor(EVIL)).toBe(0) // tombstoned target never fetched
  expect(count(raw, 'verification_checks_v2', "WHERE state = 'verified'")).toBe(0)
  repo.close()
})

// ---- unblock (spec §5) -----------------------------------------------------

test('unblock deletes the tombstone and its aliases, creates no source, writes no item/source audit, and the ledger row is the audit', async () => {
  const { repo, raw, db } = await fresh()
  const id = seedTombstone(raw, 'https://tomb.test/feed', ['https://a1.test/feed', 'https://a2.test/feed'])

  const result = db.write((tx) => unblockTombstone(tx, {
    command: env('unb1', fp(['tombstone-unblock', id, ADMIN, 'remediated'])),
    tombstoneId: id, category: 'remediated', note: 'source cleaned up', now: NOW,
  }))
  expect(result).toMatchObject({ kind: 'unblocked', tombstoneId: id, category: 'remediated', note: 'source cleaned up' })

  expect(count(raw, 'blocked_source_tombstones_v2')).toBe(0)
  expect(count(raw, 'tombstone_aliases_v2')).toBe(0)
  expect(count(raw, 'remote_sources_v2')).toBe(0) // unblock creates NO source
  // The ledger row IS the audit — no standalone audit table row is written.
  expect(count(raw, 'item_audit_v2')).toBe(0)
  expect(count(raw, 'source_audit_v2')).toBe(0)
  const ledger = raw.prepare(`SELECT result_json FROM command_ledger_v2`).get() as { result_json: string }
  const stored = JSON.parse(ledger.result_json)
  expect(stored).toMatchObject({ kind: 'unblocked', action: 'unblock', tombstoneId: id, category: 'remediated', note: 'source cleaned up' })
  repo.close()
})

test('after unblock the same URL resolves as an ordinary fresh creation', async () => {
  const { repo, raw, db, service } = await fresh()
  const owner = await repo.createLocalUser({ handle: 'owner7', displayName: 'Owner7' }) as User
  const id = seedTombstone(raw, 'https://tomb.test/feed', ['https://alias.test/feed'])

  // While tombstoned: unavailable.
  expect(await service.subscribeByUrl(owner, 'https://tomb.test/feed', 'b1')).toEqual({ kind: 'unavailable' })

  db.write((tx) => unblockTombstone(tx, { command: env('unb1', fp(['tombstone-unblock', id, ADMIN, 'remediated'])), tombstoneId: id, category: 'remediated', note: null, now: NOW }))

  // The next resolution is a normal creation, not unavailable — for the canonical
  // URL and for what used to be an alias.
  const sub = await service.subscribeByUrl(owner, 'https://tomb.test/feed', 'b2')
  expect(sub).toMatchObject({ kind: 'source', created: true })
  const sub2 = await service.subscribeByUrl(owner, 'https://alias.test/feed', 'b3')
  expect(sub2).toMatchObject({ kind: 'source', created: true })
  expect(count(raw, 'remote_sources_v2')).toBe(2)
  repo.close()
})

test('unblock requires a category, replays on identical retry, and conflicts on a varied fingerprint', async () => {
  const { repo, raw, db } = await fresh()
  const id = seedTombstone(raw, 'https://tomb.test/feed')

  const first = db.write((tx) => unblockTombstone(tx, { command: env('u1', fp(['tombstone-unblock', id, ADMIN, 'remediated'])), tombstoneId: id, category: 'remediated', note: null, now: NOW }))
  expect(first.kind).toBe('unblocked')
  // Identical retry replays the stored result (tombstone already gone; no re-delete).
  const replay = db.write((tx) => unblockTombstone(tx, { command: env('u1', fp(['tombstone-unblock', id, ADMIN, 'remediated'])), tombstoneId: id, category: 'remediated', note: 'changed note replays', now: NOW }))
  expect(replay).toEqual(first) // note is excluded from the fingerprint → replay
  // Same command id, varied category (in the fingerprint) → conflict, nothing new.
  const conflict = db.write((tx) => unblockTombstone(tx, { command: env('u1', fp(['tombstone-unblock', id, ADMIN, 'operator_policy'])), tombstoneId: id, category: 'operator_policy', note: null, now: NOW }))
  expect(conflict).toEqual({ kind: 'conflict' })
  expect(count(raw, 'command_ledger_v2')).toBe(1)
  repo.close()
})

test('unblock of an unknown tombstone is ledgered idempotently', async () => {
  const { repo, raw, db } = await fresh()
  const missing = randomUUID()
  const r1 = db.write((tx) => unblockTombstone(tx, { command: env('u1', fp(['tombstone-unblock', missing, ADMIN, 'remediated'])), tombstoneId: missing, category: 'remediated', note: null, now: NOW }))
  expect(r1).toEqual({ kind: 'unknown' })
  const r2 = db.write((tx) => unblockTombstone(tx, { command: env('u1', fp(['tombstone-unblock', missing, ADMIN, 'remediated'])), tombstoneId: missing, category: 'remediated', note: null, now: NOW }))
  expect(r2).toEqual({ kind: 'unknown' })
  expect(count(raw, 'command_ledger_v2')).toBe(1)
  repo.close()
})

// ---- the PRODUCTION wiring, not just the seam -------------------------------
// Every other test here hands `store.isTombstoned` to createSourceService BY HAND,
// which proves the seam and NOT that server.ts wires it (it did not: the 4th
// argument was omitted, so subscribe/OPML/federation never consulted a tombstone
// on any live instance). server.ts now composes through createSourcePlane — this
// guard fails if that composition stops passing the store.
test('createSourcePlane wires the tombstone guard from the logical store; with v2 off it consults nothing', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw as Raw
  const store = createLogicalStore(createDatabaseContext(raw))
  const owner = await repo.createLocalUser({ handle: 'owner', displayName: 'Owner' }) as User
  // an IP-literal public host: checkCallbackUrl passes it without any DNS, so the
  // ONLY thing that can make this URL unavailable is the tombstone guard.
  const tombstoned = 'https://93.184.216.34/feed'
  seedTombstone(raw, tombstoned, ['https://93.184.216.35/feed'])

  const on = createSourcePlane(repo, PUBLIC_URL, store)
  expect(on.repo).toBe(repo)
  expect(await on.service.subscribeByUrl(owner, tombstoned, 's1')).toEqual({ kind: 'unavailable' })
  expect(await on.service.subscribeByUrl(owner, 'https://93.184.216.35/feed', 's2')).toEqual({ kind: 'unavailable' })

  // flag OFF (no logical store): the same URL subscribes exactly as it does today.
  const off = createSourcePlane(repo, PUBLIC_URL, undefined)
  expect((await off.service.subscribeByUrl(owner, tombstoned, 's3')).kind).not.toBe('unavailable')
  repo.close()
})
