import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'txc-mig-')), 'test.db')
}

test('a fresh database migrates to the current version and works', async () => {
  const file = tempDb()
  const repo = await createSqliteRepository(file)
  const u = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  expect((await repo.getTimeline(10)).length).toBe(0)
  expect(u.handle).toBe('alice')
  const raw = new Database(file, { readonly: true })
  expect(raw.pragma('user_version', { simple: true })).toBe(2)
  raw.close()
})

test('reopening an already-current database is a no-op', async () => {
  const file = tempDb()
  const first = await createSqliteRepository(file)
  await first.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const second = await createSqliteRepository(file)
  expect((await second.getUserByHandle('alice'))?.handle).toBe('alice')
})

test('a version-0 database that already has tables fails fast', async () => {
  const file = tempDb()
  const raw = new Database(file)
  raw.exec('CREATE TABLE users (id text)')
  raw.close()
  await expect(createSqliteRepository(file)).rejects.toThrow(/pre-migration database/)
})

test('a database stamped newer than this build fails fast', async () => {
  const file = tempDb()
  const raw = new Database(file)
  raw.pragma('user_version = 99')
  raw.close()
  await expect(createSqliteRepository(file)).rejects.toThrow(/newer than this build/)
})

const V1_SCHEMA = [
  `CREATE TABLE users (
      id text PRIMARY KEY,
      kind text NOT NULL,
      handle text NOT NULL UNIQUE,
      display_name text NOT NULL,
      feed_url text,
      created_at text NOT NULL
    )`,
  `CREATE TABLE posts (
      id text PRIMARY KEY,
      author_id text NOT NULL REFERENCES users(id),
      source text NOT NULL,
      guid text NOT NULL,
      title text,
      content text NOT NULL,
      url text,
      published_at text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT posts_author_guid_uq UNIQUE (author_id, guid)
    )`,
  'CREATE INDEX posts_published_idx ON posts (published_at, id)',
  'CREATE INDEX posts_created_idx ON posts (created_at, id)',
]

test('a version-1 database upgrades in place to version 2 with data preserved', async () => {
  const file = tempDb()
  const raw = new Database(file)
  for (const stmt of V1_SCHEMA) raw.exec(stmt)
  raw.prepare("INSERT INTO users VALUES ('u1','local','alice','Alice',NULL,'2026-01-01T00:00:00.000Z')").run()
  raw.prepare("INSERT INTO posts VALUES ('p1','u1','local','g1',NULL,'kept','','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run()
  raw.pragma('user_version = 1')
  raw.close()

  const repo = await createSqliteRepository(file)
  expect((await repo.getUserByHandle('alice'))?.displayName).toBe('Alice')
  expect((await repo.getTimeline(10)).map((e) => e.content)).toEqual(['kept'])
  await repo.upsertSubscription({ id: 'x1', protocol: 'websub', topic: 't', callback: 'c', callbackHost: 'h', secret: null, expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const check = new Database(file, { readonly: true })
  expect(check.pragma('user_version', { simple: true })).toBe(2)
  check.close()
})
