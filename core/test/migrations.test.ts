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
  expect(raw.pragma('user_version', { simple: true })).toBe(12)
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
  expect(check.pragma('user_version', { simple: true })).toBe(12)
  check.close()
})

const V2_ADDITIONS = [
  `CREATE TABLE subscriptions (
      id text PRIMARY KEY,
      protocol text NOT NULL,
      topic text NOT NULL,
      callback text NOT NULL,
      callback_host text NOT NULL,
      secret text,
      expires_at text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT subscriptions_triple_uq UNIQUE (protocol, topic, callback)
    )`,
  'CREATE INDEX subscriptions_topic_idx ON subscriptions (topic, expires_at)',
  'CREATE INDEX subscriptions_host_idx ON subscriptions (callback_host, expires_at)',
]

test('a version-2 database upgrades in place to version 3 with data preserved', async () => {
  const file = tempDb()
  const raw = new Database(file)
  for (const stmt of [...V1_SCHEMA, ...V2_ADDITIONS]) raw.exec(stmt)
  raw.prepare("INSERT INTO users VALUES ('u1','remote','blog','Blog','https://blog.example.com/feed.xml','2026-01-01T00:00:00.000Z')").run()
  raw.prepare("INSERT INTO subscriptions VALUES ('s1','websub','t','c','h',NULL,'2027-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run()
  raw.pragma('user_version = 2')
  raw.close()

  const repo = await createSqliteRepository(file)
  expect((await repo.getUserByHandle('blog'))?.feedUrl).toBe('https://blog.example.com/feed.xml')
  expect(await repo.countActiveSubscriptions({ topic: 't' }, '2026-06-01T00:00:00.000Z')).toBe(1)
  await repo.upsertPushSubscription({ id: 'p1', userId: 'u1', mode: 'websub', endpoint: 'e', topic: 't2', callbackToken: 'tok', secret: null, state: 'pending', expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
  const check = new Database(file, { readonly: true })
  expect(check.pragma('user_version', { simple: true })).toBe(12)
  check.close()
})

test('migration 8: better-auth tables + users.auth_user_id unique link', async () => {
  const repo = await createSqliteRepository(':memory:')
  const names = repo.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
  for (const t of ['user', 'session', 'account', 'verification']) {
    expect(names.map((n) => n.name)).toContain(t)
  }
  const a = await repo.createLocalUser({ handle: 'a', displayName: 'a', authUserId: 'auth-1' })
  expect(a.authUserId).toBe('auth-1')
  // UNIQUE: a second core user may not claim the same auth user
  await expect(repo.createLocalUser({ handle: 'b', displayName: 'b', authUserId: 'auth-1' })).rejects.toThrow()
  // multiple NULLs are fine (remote feeds never link)
  await repo.createRemoteUser({ handle: 'r1', displayName: 'r1', feedUrl: 'http://e.example/f' })
  await repo.createRemoteUser({ handle: 'r2', displayName: 'r2', feedUrl: 'http://e.example/g' })
})

// Full schema as of migration 10 (versions 1-10 combined), for raw-upgrade
// tests that need to seed rows before migration 11 (feed_type) runs.
const V10_SCHEMA = [
  ...V1_SCHEMA,
  ...V2_ADDITIONS,
  `CREATE TABLE push_subscriptions (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id),
      mode text NOT NULL,
      endpoint text NOT NULL,
      topic text NOT NULL,
      callback_token text NOT NULL UNIQUE,
      secret text,
      state text NOT NULL,
      expires_at text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT push_subscriptions_user_mode_uq UNIQUE (user_id, mode)
    )`,
  'CREATE INDEX push_subscriptions_expires_idx ON push_subscriptions (state, expires_at)',
  `CREATE TABLE follows (
      follower_id text NOT NULL REFERENCES users(id),
      followed_id text NOT NULL REFERENCES users(id),
      created_at text NOT NULL,
      PRIMARY KEY (follower_id, followed_id)
    ) WITHOUT ROWID`,
  'CREATE INDEX posts_author_pub_idx ON posts (author_id, published_at, id)',
  'ALTER TABLE posts ADD COLUMN in_reply_to text',
  'ALTER TABLE posts ADD COLUMN in_reply_to_post_id text',
  'ALTER TABLE posts ADD COLUMN thread_root_id text',
  'CREATE INDEX posts_thread_idx ON posts (thread_root_id)',
  'CREATE INDEX posts_reply_to_idx ON posts (in_reply_to)',
  'CREATE INDEX posts_parent_idx ON posts (in_reply_to_post_id)',
  'ALTER TABLE posts ADD COLUMN source_name text',
  'ALTER TABLE posts ADD COLUMN source_feed_url text',
  'ALTER TABLE posts ADD COLUMN content_markdown text',
  `create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "isAnonymous" integer)`,
  `create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade)`,
  `create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null)`,
  `create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null)`,
  'create index "session_userId_idx" on "session" ("userId")',
  'create index "account_userId_idx" on "account" ("userId")',
  'create index "verification_identifier_idx" on "verification" ("identifier")',
  'ALTER TABLE users ADD COLUMN auth_user_id text',
  'CREATE UNIQUE INDEX users_auth_user_idx ON users (auth_user_id)',
  'ALTER TABLE posts ADD COLUMN edited_at text',
  `CREATE TABLE post_revisions (
      id text PRIMARY KEY,
      post_id text NOT NULL REFERENCES posts(id),
      title text,
      content text NOT NULL,
      content_markdown text,
      seen_at text NOT NULL
    )`,
  'CREATE INDEX post_revisions_post_idx ON post_revisions (post_id, seen_at)',
  'ALTER TABLE posts ADD COLUMN reply_context_author text',
  'ALTER TABLE posts ADD COLUMN reply_context_snippet text',
]

test('migration 11: feed_type classified by content_markdown, UNIQUE(feed_url), follows survive', async () => {
  const file = tempDb()
  const raw = new Database(file)
  for (const stmt of V10_SCHEMA) raw.exec(stmt)
  raw.prepare("INSERT INTO users VALUES ('follower1','local','alice','Alice',NULL,'2026-01-01T00:00:00.000Z',NULL)").run()
  raw.prepare("INSERT INTO users VALUES ('local2','local','bob','Bob',NULL,'2026-01-01T00:00:00.000Z',NULL)").run()
  raw.prepare("INSERT INTO users VALUES ('inst1','remote','peer','Peer','https://peer/f','2026-01-01T00:00:00.000Z',NULL)").run()
  raw.prepare("INSERT INTO users VALUES ('wf1','remote','blog','Blog','https://blog/f','2026-01-01T00:00:00.000Z',NULL)").run()
  // inst1 has a post carrying content_markdown → classified 'instance'
  raw.prepare(
    "INSERT INTO posts (id,author_id,source,guid,title,content,url,published_at,created_at,content_markdown) VALUES ('p1','inst1','remote','g1',NULL,'hi','','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','hi md')",
  ).run()
  // wf1 has a post with no content_markdown → classified 'webfeed'
  raw.prepare(
    "INSERT INTO posts (id,author_id,source,guid,title,content,url,published_at,created_at,content_markdown) VALUES ('p2','wf1','remote','g2',NULL,'yo','','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL)",
  ).run()
  // follower1 follows a local user AND the (to-be) instance-classified remote — both must survive migration 11.
  raw.prepare("INSERT INTO follows VALUES ('follower1','local2','2026-01-01T00:00:00.000Z')").run()
  raw.prepare("INSERT INTO follows VALUES ('follower1','inst1','2026-01-01T00:00:00.000Z')").run()
  raw.pragma('user_version = 10')
  raw.close()

  const repo = await createSqliteRepository(file)
  const inst = await repo.getUserByHandle('peer')
  const wf = await repo.getUserByHandle('blog')
  expect(inst?.feedType).toBe('instance')
  expect(wf?.feedType).toBe('webfeed')
  const following = await repo.listFollowing('follower1')
  expect(following.map((u) => u.handle).sort()).toEqual(['bob', 'peer'])

  // UNIQUE(feed_url) is now enforced on the upgraded DB
  await expect(repo.createRemoteUser({ handle: 'dup', displayName: 'Dup', feedUrl: 'https://blog/f' })).rejects.toThrow()

  const check = new Database(file, { readonly: true })
  expect(check.pragma('user_version', { simple: true })).toBe(12)
  check.close()
})
