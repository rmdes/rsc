import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

test('deleteUserCascade removes a remote user and its posts', async () => {
  const repo = await createSqliteRepository(':memory:')
  const u = await repo.createRemoteUser({ handle: 'peer', displayName: 'Peer', feedUrl: 'https://ex.com/f.xml' })
  // A remote-authored `posts` row — the legacy shape v2 no longer writes but
  // converted databases still hold, and exactly what this cascade must take.
  repo.raw.prepare(
    `INSERT INTO posts (id, author_id, source, guid, title, content, url, published_at, created_at)
     VALUES ('p1', ?, 'remote', 'g1', NULL, 'hi', 'https://ex.com/post/1', '2026-07-18T00:00:00Z', '2026-07-18T00:00:00Z')`,
  ).run(u.id)
  expect(await repo.getUserByHandle('peer')).toBeTruthy()
  expect(repo.instanceStats(false).posts).toBe(1) // the seed landed

  repo.deleteUserCascade(u.id)

  expect(await repo.getUserByHandle('peer')).toBeUndefined()
  expect(repo.instanceStats(false).posts).toBe(0)
})
