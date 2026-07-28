import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import {
  instancePrefix, prefixUpperBound, approvedInstanceFor, memberRows, memberRowsPage, memberCounts, MEMBER_RANGE_SQL,
} from '../src/logical/membership.ts'

// Task 2 — the ONE membership predicate (byte-prefix range over canonical_url,
// spec rev 3 §Decided model) shared by the cascade, the mint rule, the admin
// member reads, and the migration heal. healMembers itself is exercised in
// Task 3's migration test, not here.

type Raw = InstanceType<typeof Database>
const NOW = '2026-07-24T00:00:00.000Z'

async function fresh() {
  const repo = await createSqliteRepository(':memory:')
  return { raw: repo.raw as Raw }
}

function seedSource(raw: Raw, opts: {
  id: string; url: string; provenance?: string; governance?: string; operation?: string
  overridden?: 0 | 1; createdAt?: string
}): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, overridden, created_at)
     VALUES (?, ?, 'single_publisher', ?, ?, ?, NULL, 0, ?, ?)`,
  ).run(opts.id, opts.url, opts.operation ?? 'enabled', opts.governance ?? 'allowed', opts.provenance ?? 'origin_verification', opts.overridden ?? 1, opts.createdAt ?? NOW)
}

function approveFederation(raw: Raw, sourceId: string, createdAt = NOW): void {
  raw.prepare(
    `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'approved', NULL, ?, ?)`,
  ).run(sourceId, createdAt, createdAt)
}

// ---- instancePrefix / prefixUpperBound --------------------------------------

test('instancePrefix keeps scheme+host+port, drops path, and lowercases via URL normalization', () => {
  expect(instancePrefix('https://rss.chat/users/rss.xml')).toBe('https://rss.chat/')
  expect(instancePrefix('https://RSS.chat:443/x')).toBe('https://rss.chat/') // default https port dropped by URL
  expect(instancePrefix('http://rss.chat:8080/x')).toBe('http://rss.chat:8080/')
  expect(instancePrefix('not a url')).toBeNull()
  expect(instancePrefix('ftp://rss.chat/x')).toBeNull()
})

test('prefixUpperBound increments the last byte', () => {
  expect(prefixUpperBound('https://rss.chat/')).toBe('https://rss.chat0')
})

// ---- memberRows --------------------------------------------------------------

test('memberRows excludes the instance row itself, other provenances, other hosts, and an http member under an https instance', async () => {
  const { raw } = await fresh()
  seedSource(raw, { id: 'inst', url: 'https://rss.chat/hub.xml', provenance: 'admin_federation' })
  seedSource(raw, { id: 'm1', url: 'https://rss.chat/users/a.xml' }) // in range, origin_verification
  seedSource(raw, { id: 'm2', url: 'https://rss.chat/users/b.xml', provenance: 'admin_federation' }) // wrong provenance
  seedSource(raw, { id: 'm3', url: 'https://other.test/users/c.xml' }) // wrong host
  seedSource(raw, { id: 'm4', url: 'http://rss.chat/users/d.xml' }) // http under https instance — the stated ceiling
  const rows = memberRows(raw, { id: 'inst', canonical_url: 'https://rss.chat/hub.xml' })
  expect(rows.map((r) => r.id)).toEqual(['m1'])
})

// ---- approvedInstanceFor -----------------------------------------------------

test('approvedInstanceFor picks the earliest-created among two approved same-prefix aggregates', async () => {
  const { raw } = await fresh()
  seedSource(raw, { id: 'later', url: 'https://rss.chat/later.xml', provenance: 'admin_federation', createdAt: '2026-07-24T01:00:00.000Z' })
  approveFederation(raw, 'later', '2026-07-24T01:00:00.000Z')
  seedSource(raw, { id: 'earlier', url: 'https://rss.chat/earlier.xml', provenance: 'admin_federation', createdAt: '2026-07-24T00:00:00.000Z' })
  approveFederation(raw, 'earlier', '2026-07-24T00:00:00.000Z')
  const picked = approvedInstanceFor(raw, 'https://rss.chat/users/x.xml')
  expect(picked?.id).toBe('earlier')
})

test('approvedInstanceFor prefers a BLOCKED instance over an earlier allowed one — block is absolute', async () => {
  const { raw } = await fresh()
  seedSource(raw, { id: 'earlier-allowed', url: 'https://rss.chat/a.xml', provenance: 'admin_federation', governance: 'allowed', createdAt: '2026-07-24T00:00:00.000Z' })
  approveFederation(raw, 'earlier-allowed', '2026-07-24T00:00:00.000Z')
  seedSource(raw, { id: 'later-blocked', url: 'https://rss.chat/b.xml', provenance: 'admin_federation', governance: 'blocked', createdAt: '2026-07-24T01:00:00.000Z' })
  approveFederation(raw, 'later-blocked', '2026-07-24T01:00:00.000Z')
  const picked = approvedInstanceFor(raw, 'https://rss.chat/users/x.xml')
  expect(picked?.id).toBe('later-blocked')
})

test('approvedInstanceFor returns null when the only candidate is pending or has no federation relationship at all', async () => {
  const { raw } = await fresh()
  seedSource(raw, { id: 'pending', url: 'https://rss.chat/hub.xml', provenance: 'admin_federation' })
  raw.prepare(`INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'pending', NULL, ?, ?)`).run('pending', NOW, NOW)
  expect(approvedInstanceFor(raw, 'https://rss.chat/users/x.xml')).toBeNull()

  const { raw: raw2 } = await fresh()
  seedSource(raw2, { id: 'unfederated', url: 'https://rss.chat/hub.xml', provenance: 'admin_federation' })
  expect(approvedInstanceFor(raw2, 'https://rss.chat/users/x.xml')).toBeNull()
})

// ---- memberRowsPage / memberCounts — F2's approved-federation gate -----------

test('memberRowsPage and memberCounts return empty for an instance with NO approved federation relationship', async () => {
  const { raw } = await fresh()
  seedSource(raw, { id: 'inst', url: 'https://rss.chat/hub.xml', provenance: 'admin_federation' })
  seedSource(raw, { id: 'm1', url: 'https://rss.chat/users/a.xml' })
  const instance = { id: 'inst', canonical_url: 'https://rss.chat/hub.xml' }
  expect(memberRowsPage(raw, instance, undefined, 10)).toEqual({ rows: [], nextCursor: null })
  expect(memberCounts(raw, instance)).toEqual({ members: 0, overridden: 0 })
})

test('memberRowsPage and memberCounts page/count correctly once the instance is approved', async () => {
  const { raw } = await fresh()
  seedSource(raw, { id: 'inst', url: 'https://rss.chat/hub.xml', provenance: 'admin_federation' })
  approveFederation(raw, 'inst')
  seedSource(raw, { id: 'm1', url: 'https://rss.chat/users/a.xml', overridden: 0, createdAt: '2026-07-24T00:00:00.000Z' })
  seedSource(raw, { id: 'm2', url: 'https://rss.chat/users/b.xml', overridden: 1, createdAt: '2026-07-24T00:00:01.000Z' })
  const instance = { id: 'inst', canonical_url: 'https://rss.chat/hub.xml' }

  expect(memberCounts(raw, instance)).toEqual({ members: 2, overridden: 1 })

  const page1 = memberRowsPage(raw, instance, undefined, 1)
  expect(page1.rows.map((r) => r.id)).toEqual(['m2']) // created_at DESC
  expect(page1.nextCursor).not.toBeNull()

  const { decodeCursor } = await import('../src/domain/source-repository.ts')
  const cursor = decodeCursor(page1.nextCursor!)
  const page2 = memberRowsPage(raw, instance, cursor, 1)
  expect(page2.rows.map((r) => r.id)).toEqual(['m1'])
  expect(page2.nextCursor).toBeNull()
})

// ---- the shared range fragment plans as an index SEARCH ----------------------

test('the member range plans as SEARCH on the canonical_url autoindex', async () => {
  const { raw } = await fresh()
  const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT id FROM remote_sources_v2 WHERE ${MEMBER_RANGE_SQL}`).all('https://x.test/', 'https://x.test0', 'irrelevant') as { detail: string }[]
  expect(plan.map((r) => r.detail).join(' ')).toMatch(/SEARCH .*USING (COVERING )?INDEX/)
})
