import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { normalizeSourceUrl } from '../src/domain/source-url.ts'
import type { LookupFn } from '../src/domain/push-guard.ts'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

type Raw = InstanceType<typeof Database>

const PUBLIC_URL = 'https://cast.example'

function countRows(raw: Raw, table: string): number {
  const { n } = raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
  return n
}

function insertSourceRow(raw: Raw, opts: { canonicalUrl: string; attributionMode?: 'single_publisher' | 'aggregate'; operation?: 'enabled' | 'paused'; governance?: 'allowed' | 'quarantined' | 'blocked' }): string {
  const id = randomUUID()
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, ?, ?, ?, 'user_subscription', NULL, 0, ?)`,
  ).run(id, opts.canonicalUrl, opts.attributionMode ?? 'single_publisher', opts.operation ?? 'enabled', opts.governance ?? 'allowed', '2026-01-01T00:00:00.000Z')
  return id
}

function insertFederationRow(raw: Raw, sourceId: string): void {
  raw.prepare(
    `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'approved', NULL, ?, ?)`,
  ).run(sourceId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
}

// --- Step 1: normalizeSourceUrl ---

test('normalizeSourceUrl: scheme/host lowercased, default port dropped, fragment removed; path/query/slash/scheme preserved; credentials and length rejected', () => {
  expect(normalizeSourceUrl('HTTPS://Example.COM:443/feed/?x=1#f')).toBe('https://example.com/feed/?x=1')
  expect(normalizeSourceUrl('http://example.com/feed/')).toBe('http://example.com/feed/')
  expect(() => normalizeSourceUrl('https://u:p@example.com/feed')).toThrow('source URL invalid')
  expect(() => normalizeSourceUrl(`https://example.com/${'x'.repeat(2049)}`)).toThrow('source URL invalid')
})

// --- Step 1: local-feed precedence + ledger idempotency ---

test('subscribeByUrl follows a local account for its canonical feed URL, ledgered and idempotent', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const target = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const owner = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
  const service = createSourceService(repo, PUBLIC_URL)
  const xmlUrl = `${PUBLIC_URL}/users/alice/feed.xml`
  const jsonUrl = `${PUBLIC_URL}/users/alice/feed.json`

  const first = await service.subscribeByUrl(owner, xmlUrl, 'c1')
  expect(first).toEqual({ kind: 'local', created: true, follow: { kind: 'local', id: target.id, handle: 'alice', displayName: 'Alice' } })
  expect(countRows(raw, 'follows')).toBe(1)
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)
  expect(countRows(raw, 'remote_sources_v2')).toBe(0)

  // Identical retry (same command id, same url) replays the stored result.
  const replay = await service.subscribeByUrl(owner, xmlUrl, 'c1')
  expect(replay).toEqual(first)
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  // Same command id, changed url -> conflict, no new ledger row.
  const conflict = await service.subscribeByUrl(owner, jsonUrl, 'c1')
  expect(conflict).toEqual({ kind: 'conflict' })
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  // A genuinely new command against the JSON form resolves to the same
  // local account (already followed) — created:false, still one follow row.
  const second = await service.subscribeByUrl(owner, jsonUrl, 'c2')
  expect(second).toEqual({ kind: 'local', created: false, follow: { kind: 'local', id: target.id, handle: 'alice', displayName: 'Alice' } })
  expect(countRows(raw, 'follows')).toBe(1)
  expect(countRows(raw, 'command_ledger_v2')).toBe(2)

  repo.close()
})

// --- Step 2: remote resolution and cap serialization ---

test('a new remote URL creates single_publisher + enabled + allowed + federation none + user_subscription', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner1', displayName: 'Owner1' })
  const service = createSourceService(repo, PUBLIC_URL)

  const result = await service.subscribeByUrl(owner, 'https://203.0.113.9/feed', 'c1')
  expect(result).toMatchObject({ kind: 'source', created: true, subscription: { attributionMode: 'single_publisher', subscriptionState: 'active', availability: 'available' } })

  const row = raw.prepare(`SELECT * FROM remote_sources_v2 WHERE canonical_url = ?`).get('https://203.0.113.9/feed') as Record<string, unknown>
  expect(row).toMatchObject({ attribution_mode: 'single_publisher', operation: 'enabled', governance: 'allowed', provenance: 'user_subscription' })
  expect(countRows(raw, 'federation_relationships_v2')).toBe(0)

  // Retry with a different command id against an existing subscription: created:false, stored value unchanged.
  const existing = await service.subscribeByUrl(owner, 'https://203.0.113.9/feed', 'c5')
  expect(existing).toMatchObject({ kind: 'source', created: false })

  repo.close()
})

test('a paused, retained, allowed source is reused unchanged by a new subscriber', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner2', displayName: 'Owner2' })
  const service = createSourceService(repo, PUBLIC_URL)
  const url = 'https://203.0.113.20/feed'
  insertSourceRow(raw, { canonicalUrl: url, operation: 'paused', governance: 'allowed' })

  const result = await service.subscribeByUrl(owner, url, 'c1')
  expect(result).toMatchObject({ kind: 'source', created: true, subscription: { subscriptionState: 'active', availability: 'available' } })

  const row = raw.prepare(`SELECT operation FROM remote_sources_v2 WHERE canonical_url = ?`).get(url) as { operation: string }
  expect(row.operation).toBe('paused') // unchanged by the subscribe path

  repo.close()
})

test('a quarantined source creates a pending subscription projected as awaiting_review, revealing nothing else', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner3', displayName: 'Owner3' })
  const service = createSourceService(repo, PUBLIC_URL)
  const url = 'https://203.0.113.21/feed'
  insertSourceRow(raw, { canonicalUrl: url, governance: 'quarantined' })

  const result = await service.subscribeByUrl(owner, url, 'c1')
  expect(result).toMatchObject({ kind: 'source', created: true, subscription: { subscriptionState: 'pending', availability: 'awaiting_review' } })
  expect(Object.keys((result as { subscription: object }).subscription).sort()).toEqual(['attributionMode', 'availability', 'sourceId', 'subscriptionState', 'url'])

  repo.close()
})

test('an aggregate target returns the neutral not_subscribable result', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner4', displayName: 'Owner4' })
  const service = createSourceService(repo, PUBLIC_URL)
  const url = 'https://203.0.113.22/feed'
  insertSourceRow(raw, { canonicalUrl: url, attributionMode: 'aggregate' })

  const result = await service.subscribeByUrl(owner, url, 'c1')
  expect(result).toEqual({ kind: 'not_subscribable' })
  expect(countRows(raw, 'source_subscriptions_v2')).toBe(0)

  repo.close()
})

test('a source with a federation relationship returns the neutral not_subscribable result', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner5', displayName: 'Owner5' })
  const service = createSourceService(repo, PUBLIC_URL)
  const url = 'https://203.0.113.23/feed'
  const sourceId = insertSourceRow(raw, { canonicalUrl: url })
  insertFederationRow(raw, sourceId)

  const result = await service.subscribeByUrl(owner, url, 'c1')
  expect(result).toEqual({ kind: 'not_subscribable' })
  expect(countRows(raw, 'source_subscriptions_v2')).toBe(0)

  repo.close()
})

test('a blocked target returns the same generic unavailable result as a never-existed URL, and creates nothing', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'owner6', displayName: 'Owner6' })
  const service = createSourceService(repo, PUBLIC_URL)
  const url = 'https://203.0.113.24/feed'
  insertSourceRow(raw, { canonicalUrl: url, governance: 'blocked' })

  const result = await service.subscribeByUrl(owner, url, 'c1')
  expect(result).toEqual({ kind: 'unavailable' })
  expect(countRows(raw, 'source_subscriptions_v2')).toBe(0)

  repo.close()
})

test('cap check and subscription insert serialize: two final-slot subscriptions race to one source and one cap', async () => {
  const repo = await createSqliteRepository(':memory:')
  const owner = await repo.createLocalUser({ handle: 'capowner', displayName: 'CapOwner' })
  await repo.setSetting('max_subs_per_user', '1')
  const service = createSourceService(repo, PUBLIC_URL)

  const [a, b] = await Promise.all([
    service.subscribeByUrl(owner, 'https://203.0.113.10/a', 'c3'),
    service.subscribeByUrl(owner, 'https://203.0.113.11/b', 'c4'),
  ])
  expect([a.kind, b.kind].sort()).toEqual(['cap', 'source'])
  expect(countRows(repo.raw, 'source_subscriptions_v2')).toBe(1)

  repo.close()
})

// --- Step 2: SSRF guard on the remote path; local feeds bypass it ---

test('loopback, private, and link-local remote URLs are rejected as unavailable and create no v2 row', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'guardowner', displayName: 'GuardOwner' })
  const service = createSourceService(repo, PUBLIC_URL)

  for (const url of ['http://127.0.0.1/feed', 'http://10.0.0.5/feed', 'http://169.254.1.1/feed', 'http://[::1]/feed']) {
    const result = await service.subscribeByUrl(owner, url, `c-${url}`)
    expect(result).toEqual({ kind: 'unavailable' })
  }
  expect(countRows(raw, 'remote_sources_v2')).toBe(0)

  repo.close()
})

test('a hostname that resolves to a private address (DNS-to-private) is rejected the same way', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'dnsowner', displayName: 'DnsOwner' })
  const privateLookup: LookupFn = async () => [{ address: '10.0.0.5' }]
  const service = createSourceService(repo, PUBLIC_URL, privateLookup)

  const result = await service.subscribeByUrl(owner, 'https://rebound.example.com/feed', 'c1')
  expect(result).toEqual({ kind: 'unavailable' })
  expect(countRows(raw, 'remote_sources_v2')).toBe(0)

  repo.close()
})

test('local-account feed URLs bypass the SSRF guard entirely', async () => {
  const repo = await createSqliteRepository(':memory:')
  const target = await repo.createLocalUser({ handle: 'carol', displayName: 'Carol' })
  const owner = await repo.createLocalUser({ handle: 'dave', displayName: 'Dave' })
  const neverCall: LookupFn = async () => { throw new Error('lookupFn must never be called for a local-account URL') }
  const service = createSourceService(repo, PUBLIC_URL, neverCall)

  const result = await service.subscribeByUrl(owner, `${PUBLIC_URL}/users/carol/feed.xml`, 'c1')
  expect(result).toEqual({ kind: 'local', created: true, follow: { kind: 'local', id: target.id, handle: 'carol', displayName: 'Carol' } })

  repo.close()
})
