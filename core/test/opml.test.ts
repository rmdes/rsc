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

import { importFollowingOpml } from '../src/domain/opml.ts'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { HandleTakenError } from '../src/domain/types.ts'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

async function importSetup(publicUrl: string | null) {
  const repo = await createSqliteRepository(':memory:')
  const svc = createService(repo, createEventBus())
  const follower = await repo.createLocalUser({ handle: 'me', displayName: 'Me' })
  const deps = {
    listRemoteUsers: () => repo.listRemoteUsers(),
    getUserByHandle: (h: string) => repo.getUserByHandle(h),
    addRemoteUser: (i: { handle: string; displayName: string; feedUrl: string }) => svc.addRemoteUser(i),
    addFollow: async (f: typeof follower, t: typeof follower) => { await svc.addFollow(f, t); return true },
    getSetting: (k: string) => repo.getSetting(k),
    countRemoteSubscriptions: (userId: string) => repo.countRemoteSubscriptions(userId),
    getRemoteUserByFeedUrl: (u: string) => repo.getRemoteUserByFeedUrl(u),
    publicUrl,
  }
  return { repo, svc, follower, deps }
}

test('import walks nested folders (H1), creates+follows, dedups by xmlUrl', async () => {
  const { repo, follower, deps } = await importSetup('https://cast.example')
  // checkCallbackUrl (addendum A) runs real DNS for hostnames; the test sandbox
  // has no reliable network, so Case-3 URLs use public IP literals (TEST-NET-3,
  // RFC 5737 — reserved for docs) which checkCallbackUrl accepts without DNS.
  const opml = `<opml version="2.0"><head><title>t</title></head><body>
    <outline text="Tech"><outline type="rss" text="A Blog" xmlUrl="https://203.0.113.10/f.xml"/></outline>
    <outline type="rss" text="B" xmlUrl="https://203.0.113.11/f.xml"/>
    <outline type="rss" text="B dup" xmlUrl="https://203.0.113.11/f.xml"/>
    <outline text="empty folder no url"/>
  </body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 2, created: 2, skipped: 1 }) // dup xmlUrl skipped; folder outline is structure, not a skip
  const following = await repo.listFollowing(follower.id)
  expect(following.map((u) => u.feedUrl).sort()).toEqual(['https://203.0.113.10/f.xml', 'https://203.0.113.11/f.xml'])
})

test('import follows an existing remote by feedUrl (case 1) without creating a duplicate', async () => {
  const { repo, svc, follower, deps } = await importSetup('https://cast.example')
  await svc.addRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  const opml = `<opml><body><outline type="rss" text="News" xmlUrl="https://ex.com/f.xml"/></body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 1, created: 0, skipped: 0 })
  expect((await repo.listRemoteUsers()).length).toBe(1)
})

test('import follows a local user for our own minted feed.json URL, not a remote shadow (H2)', async () => {
  const { repo, follower, deps } = await importSetup('https://cast.example')
  const bob = await repo.createLocalUser({ handle: 'bob', displayName: 'Bob' })
  const opml = `<opml><body><outline type="rss" text="Bob" xmlUrl="https://cast.example/users/bob/feed.json"/></body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 1, created: 0, skipped: 0 })
  expect((await repo.listFollowing(follower.id)).map((u) => u.id)).toEqual([bob.id])
  expect((await repo.listRemoteUsers()).length).toBe(0) // no shadow created
})

test('import skips non-http(s) xmlUrls without creating users (P1)', async () => {
  const { repo, follower, deps } = await importSetup('https://cast.example')
  const opml = `<opml><body>
    <outline type="rss" text="FTP" xmlUrl="ftp://x.com/f.xml"/>
    <outline type="rss" text="JS" xmlUrl="javascript:alert(1)"/>
    <outline type="rss" text="Garbage" xmlUrl="not a url"/>
  </body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 0, created: 0, skipped: 3 })
  expect((await repo.listRemoteUsers()).length).toBe(0)
})

test('same-slug outlines collide on handle and get suffixed (H3)', async () => {
  const { repo, follower, deps } = await importSetup(null)
  const opml = `<opml><body>
    <outline type="rss" text="My Blog!" xmlUrl="https://203.0.113.20/f.xml"/>
    <outline type="rss" text="My Blog?" xmlUrl="https://203.0.113.21/f.xml"/>
  </body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r.created).toBe(2)
  const handles = (await repo.listRemoteUsers()).map((u) => u.handle).sort()
  expect(handles).toEqual(['my-blog', 'my-blog-2'])
})

test('outlines beyond MAX_OUTLINES cap are counted as skipped (H5)', async () => {
  const { svc, follower, deps } = await importSetup(null)
  await svc.setSetting('max_subs_per_user', '2000') // isolate MAX_OUTLINES from the addendum-A subscription cap (default 500)
  // Same IP literal, distinct paths — checkCallbackUrl only inspects the host,
  // so this stays a single synchronous IP check per outline (no DNS × 1001).
  const outlines = Array.from({ length: 1001 }, (_, i) => `<outline type="rss" text="F${i}" xmlUrl="https://203.0.113.30/feed${i}.xml"/>`)
  const opml = `<opml><body>${outlines.join('')}</body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r.created + r.skipped).toBe(1001)
  expect(r.skipped).toBeGreaterThanOrEqual(1)
  expect(r.created).toBe(1000)
  expect(r.skipped).toBe(1)
})

test('import stops creating/following once the per-user cap is hit (addendum A)', async () => {
  const { repo, svc, follower, deps } = await importSetup(null)
  await svc.setSetting('max_subs_per_user', '1')
  const opml = `<opml><body>
    <outline type="rss" text="One" xmlUrl="https://203.0.113.40/feed.xml"/>
    <outline type="rss" text="Two" xmlUrl="https://203.0.113.41/feed.xml"/>
  </body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 1, created: 1, skipped: 1 })
  expect((await repo.listRemoteUsers()).length).toBe(1)
})

test('import respects the cap for an existing-remote follow (case 1), not just creates', async () => {
  const { repo, svc, follower, deps } = await importSetup(null)
  await svc.addRemoteUser({ handle: 'news', displayName: 'News', feedUrl: 'https://ex.com/f.xml' })
  await svc.setSetting('max_subs_per_user', '0')
  const opml = `<opml><body><outline type="rss" text="News" xmlUrl="https://ex.com/f.xml"/></body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 0, created: 0, skipped: 1 })
  expect(await repo.listFollowing(follower.id)).toEqual([])
})

test('import skips a private/loopback xmlUrl without creating a row (addendum A SSRF)', async () => {
  const { repo, follower, deps } = await importSetup(null)
  const opml = `<opml><body><outline type="rss" text="Local" xmlUrl="http://127.0.0.1/feed.xml"/></body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 0, created: 0, skipped: 1 })
  expect((await repo.listRemoteUsers()).length).toBe(0)
})

test('import: an existing instance feed in the OPML counts skipped, not followed', async () => {
  const { svc, follower, deps } = await importSetup('https://cast.example')
  // an instance feed already in the DB, matched by feedUrl (case 1)
  await svc.addRemoteUser({ handle: 'peer', displayName: 'Peer', feedUrl: 'https://peer.example/textcast.xml', feedType: 'instance' })
  const follows: Array<[string, string]> = []
  deps.addFollow = async (f, t) => (t.feedType === 'instance' || t.id === f.id ? false : (follows.push([f.id, t.id]), true))
  const opml = `<opml><body><outline type="rss" text="Peer" xmlUrl="https://peer.example/textcast.xml"/></body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 0, created: 0, skipped: 1 })
  expect(follows).toEqual([])
})

test('import Case-3: a concurrent create winning the feed_url race is followed via re-resolve', async () => {
  const { repo, svc, follower, deps } = await importSetup(null)
  // the "winner": a row a concurrent request created between our byFeedUrl
  // snapshot and our own addRemoteUser call (HandleTakenError is the UNIQUE
  // collision on feed_url that surfaces the race).
  const winner = await svc.addRemoteUser({ handle: 'winner', displayName: 'Winner', feedUrl: 'https://203.0.113.50/f.xml', feedType: 'webfeed' })
  deps.listRemoteUsers = async () => [] // byFeedUrl snapshot predates the winner's insert
  deps.addRemoteUser = async () => { throw new HandleTakenError('handle or feed_url taken') }
  const opml = `<opml><body><outline type="rss" text="Race" xmlUrl="https://203.0.113.50/f.xml"/></body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 1, created: 0, skipped: 0 })
  expect((await repo.listFollowing(follower.id)).map((u) => u.id)).toEqual([winner.id])
})

// --- v2 SourceService.importOpml (RSC_SOURCE_MODEL_V2, dormant; Task 4) ---
// The batch analogue of Task 3's subscribeByUrl. Nothing here touches the
// legacy importFollowingOpml path above; both coexist untouched.

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
