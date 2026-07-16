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
