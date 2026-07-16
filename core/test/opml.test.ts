import { test, expect } from 'vitest'
import { buildFollowingOpml } from '../src/domain/opml.ts'
import type { User } from '../src/domain/types.ts'

const remote = (h: string, feed: string): User => ({ id: h, kind: 'remote', handle: h, displayName: h.toUpperCase(), feedUrl: feed, createdAt: '2026-01-01T00:00:00.000Z' })
const local = (h: string): User => ({ id: h, kind: 'local', handle: h, displayName: h, feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z' })

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

async function importSetup(publicUrl: string | null) {
  const repo = await createSqliteRepository(':memory:')
  const svc = createService(repo, createEventBus())
  const follower = await repo.createLocalUser({ handle: 'me', displayName: 'Me' })
  const deps = {
    listRemoteUsers: () => repo.listRemoteUsers(),
    getUserByHandle: (h: string) => repo.getUserByHandle(h),
    addRemoteUser: (i: { handle: string; displayName: string; feedUrl: string }) => svc.addRemoteUser(i),
    addFollow: (f: typeof follower, t: typeof follower) => svc.addFollow(f, t),
    publicUrl,
  }
  return { repo, svc, follower, deps }
}

test('import walks nested folders (H1), creates+follows, dedups by xmlUrl', async () => {
  const { repo, follower, deps } = await importSetup('https://cast.example')
  const opml = `<opml version="2.0"><head><title>t</title></head><body>
    <outline text="Tech"><outline type="rss" text="A Blog" xmlUrl="https://a.com/f.xml"/></outline>
    <outline type="rss" text="B" xmlUrl="https://b.com/f.xml"/>
    <outline type="rss" text="B dup" xmlUrl="https://b.com/f.xml"/>
    <outline text="empty folder no url"/>
  </body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r).toEqual({ followed: 2, created: 2, skipped: 1 }) // dup xmlUrl skipped; folder outline is structure, not a skip
  const following = await repo.listFollowing(follower.id)
  expect(following.map((u) => u.feedUrl).sort()).toEqual(['https://a.com/f.xml', 'https://b.com/f.xml'])
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
    <outline type="rss" text="My Blog!" xmlUrl="https://one.com/f.xml"/>
    <outline type="rss" text="My Blog?" xmlUrl="https://two.com/f.xml"/>
  </body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r.created).toBe(2)
  const handles = (await repo.listRemoteUsers()).map((u) => u.handle).sort()
  expect(handles).toEqual(['my-blog', 'my-blog-2'])
})

test('outlines beyond MAX_OUTLINES cap are counted as skipped (H5)', async () => {
  const { repo, follower, deps } = await importSetup(null)
  const outlines = Array.from({ length: 1001 }, (_, i) => `<outline type="rss" text="F${i}" xmlUrl="https://f${i}.example/feed.xml"/>`)
  const opml = `<opml><body>${outlines.join('')}</body></opml>`
  const r = await importFollowingOpml(deps, follower, opml)
  expect(r.created + r.skipped).toBe(1001)
  expect(r.skipped).toBeGreaterThanOrEqual(1)
  expect(r.created).toBe(1000)
  expect(r.skipped).toBe(1)
})
