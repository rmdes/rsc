import { test, expect } from 'vitest'
import { buildFollowingOpml } from '../src/domain/opml.ts'
import type { User } from '../src/domain/types.ts'

const remote = (h: string, feed: string): User => ({ id: h, kind: 'remote', handle: h, displayName: h.toUpperCase(), feedUrl: feed, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null })
const local = (h: string): User => ({ id: h, kind: 'local', handle: h, displayName: h, feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null })

test('export emits remote feedUrl and minted local feed.xml when public URL is set', () => {
  const opml = buildFollowingOpml('Alice', [remote('news', 'https://ex.com/f.xml'), local('bob')], 'https://cast.example')
  expect(opml).toContain('xmlUrl="https://ex.com/f.xml"')
  expect(opml).toContain('xmlUrl="https://cast.example/users/bob/feed.xml"')
})

test('export omits local-user outlines when no public URL (H4)', () => {
  const opml = buildFollowingOpml('Alice', [remote('news', 'https://ex.com/f.xml'), local('bob')], null)
  expect(opml).toContain('https://ex.com/f.xml')
  expect(opml).not.toContain('bob')
})

test('export of a user who follows nobody yields valid empty OPML, not a throw', () => {
  // feedsmith's generateOpml rejects an empty outline list; an empty subscription
  // list is nonetheless valid OPML. Regression: this 500'd the export route.
  const opml = buildFollowingOpml('Rick & Co', [], 'https://cast.example')
  expect(opml).toContain('<opml')
  expect(opml).toContain('<body></body>')
  expect(opml).toContain('Rick &amp; Co — following') // title is XML-escaped
})

import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

// --- v2 SourceService.importOpml (Task 4) ---
// The batch analogue of subscribeByUrl (Task 4). The v1 importFollowingOpml
// tests that used to sit above went with the v1 path itself (V4 Task 11).

type Raw = InstanceType<typeof Database>

function countRows(raw: Raw, table: string): number {
  const { n } = raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
  return n
}

function insertQuarantinedSource(raw: Raw, canonicalUrl: string): void {
  raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES (?, ?, 'single_publisher', 'enabled', 'quarantined', 'user_subscription', NULL, 0, ?)`,
  ).run(randomUUID(), canonicalUrl, '2026-01-01T00:00:00.000Z')
}

async function countSubscriptions(repo: Awaited<ReturnType<typeof createSqliteRepository>>, ownerId: string): Promise<number> {
  const { n } = repo.raw.prepare(`SELECT count(*) AS n FROM source_subscriptions_v2 WHERE owner_id = ?`).get(ownerId) as { n: number }
  return n
}

test('importOpml: mixed local/remote import is ledgered, idempotent, and conflicts on a changed retry', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'importer', displayName: 'Importer' })
  await repo.createLocalUser({ handle: 'localfeed', displayName: 'LocalFeed' })
  insertQuarantinedSource(raw, 'https://203.0.113.70/quarantined')
  const service = createSourceService(repo, 'https://cast.example')

  const mixedXml = `<opml version="2.0"><body>
    <outline type="rss" text="Local" xmlUrl="https://cast.example/users/localfeed/feed.xml"/>
    <outline type="rss" text="Public" xmlUrl="https://203.0.113.71/feed"/>
    <outline type="rss" text="Private" xmlUrl="http://127.0.0.1/feed"/>
    <outline type="rss" text="Public dup" xmlUrl="https://203.0.113.71/feed"/>
    <outline type="rss" text="Quarantined" xmlUrl="https://203.0.113.70/quarantined"/>
  </body></opml>`

  const result = await service.importOpml(owner, mixedXml, 'import-1')
  expect(result).toEqual({ localFollowed: 1, active: 1, pending: 1, unavailable: 1, notSubscribable: 0, capSkipped: 0 })
  expect(countRows(raw, 'follows')).toBe(1)
  expect(countRows(raw, 'source_subscriptions_v2')).toBe(2)
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  // Same command id, same bounded xml -> byte-equivalent replay, no new rows.
  const replay = await service.importOpml(owner, mixedXml, 'import-1')
  expect(replay).toEqual(result)
  expect(countRows(raw, 'follows')).toBe(1)
  expect(countRows(raw, 'source_subscriptions_v2')).toBe(2)
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  // Same command id, changed xml -> conflict, no new rows.
  const changedXml = mixedXml.replace('Public dup', 'Public dup changed')
  const conflict = await service.importOpml(owner, changedXml, 'import-1')
  expect(conflict).toEqual({ kind: 'conflict' })
  expect(countRows(raw, 'source_subscriptions_v2')).toBe(2)
  expect(countRows(raw, 'command_ledger_v2')).toBe(1)

  repo.close()
})

// The import command re-implements the subscribe branches as counters, so each
// branch is pinned here through the import path too — a swapped counter is
// exactly the drift a copy invites.
test('importOpml buckets blocked as unavailable, aggregate/federated as notSubscribable, and pending_review as pending', async () => {
  const repo = await createSqliteRepository(':memory:')
  const raw = repo.raw
  const owner = await repo.createLocalUser({ handle: 'bucketer', displayName: 'Bucketer' })
  const service = createSourceService(repo, 'https://cast.example')
  const at = '2026-01-01T00:00:00.000Z'
  const insertSource = (canonicalUrl: string, attributionMode: string, governance: string): string => {
    const id = randomUUID()
    raw.prepare(
      `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
       VALUES (?, ?, ?, 'enabled', ?, 'user_subscription', NULL, 0, ?)`,
    ).run(id, canonicalUrl, attributionMode, governance, at)
    return id
  }
  const insertSub = (sourceId: string, state: string): void => {
    raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), owner.id, sourceId, state, at)
  }

  insertSource('https://203.0.113.80/blocked', 'single_publisher', 'blocked')
  insertSource('https://203.0.113.81/aggregate', 'aggregate', 'allowed')
  const federated = insertSource('https://203.0.113.82/federated', 'single_publisher', 'allowed')
  raw.prepare(`INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'approved', NULL, ?, ?)`).run(federated, at, at)
  insertSub(insertSource('https://203.0.113.83/review', 'single_publisher', 'allowed'), 'pending_review')
  insertSub(insertSource('https://203.0.113.84/active', 'single_publisher', 'allowed'), 'active')

  const xml = `<opml version="2.0"><body>
    <outline type="rss" xmlUrl="https://203.0.113.80/blocked"/>
    <outline type="rss" xmlUrl="https://203.0.113.81/aggregate"/>
    <outline type="rss" xmlUrl="https://203.0.113.82/federated"/>
    <outline type="rss" xmlUrl="https://203.0.113.83/review"/>
    <outline type="rss" xmlUrl="https://203.0.113.84/active"/>
  </body></opml>`

  expect(await service.importOpml(owner, xml, 'import-3')).toEqual({
    localFollowed: 0, active: 1, pending: 1, unavailable: 1, notSubscribable: 2, capSkipped: 0,
  })
  expect(countRows(raw, 'source_subscriptions_v2')).toBe(2) // nothing new was written

  repo.close()
})

test('importOpml commits what fits when the cap is hit mid-import and reports capSkipped', async () => {
  const repo = await createSqliteRepository(':memory:')
  const owner = await repo.createLocalUser({ handle: 'capimporter', displayName: 'CapImporter' })
  await repo.setSetting('max_subs_per_user', '1') // one remaining slot
  const service = createSourceService(repo, 'https://cast.example')

  const twoRemoteXml = `<opml><body>
    <outline type="rss" text="One" xmlUrl="https://203.0.113.72/feed"/>
    <outline type="rss" text="Two" xmlUrl="https://203.0.113.73/feed"/>
  </body></opml>`

  const result = await service.importOpml(owner, twoRemoteXml, 'import-2')
  expect(result).toMatchObject({ active: 1, capSkipped: 1 })
  expect(await countSubscriptions(repo, owner.id)).toBe(1)

  repo.close()
})
