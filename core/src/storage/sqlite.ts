import { Kysely, SqliteDialect } from 'kysely'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { Repository } from '../domain/repository.ts'
import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry } from '../domain/types.ts'

interface UsersTable { id: string; kind: 'local' | 'remote'; handle: string; display_name: string; feed_url: string | null; created_at: string }
interface PostsTable { id: string; author_id: string; source: 'local' | 'remote'; guid: string; title: string | null; content: string; url: string | null; published_at: string; created_at: string }
interface DB { users: UsersTable; posts: PostsTable }

function rowToUser(r: UsersTable): User {
  return { id: r.id, kind: r.kind, handle: r.handle, displayName: r.display_name, feedUrl: r.feed_url, createdAt: r.created_at }
}

export class SqliteRepository implements Repository {
  constructor(private db: Kysely<DB>) {}

  private async insertUser(kind: 'local' | 'remote', handle: string, displayName: string, feedUrl: string | null): Promise<User> {
    const row: UsersTable = { id: randomUUID(), kind, handle, display_name: displayName, feed_url: feedUrl, created_at: new Date().toISOString() }
    await this.db.insertInto('users').values(row).execute()
    return rowToUser(row)
  }
  createLocalUser(u: NewLocalUser) { return this.insertUser('local', u.handle, u.displayName, null) }
  createRemoteUser(u: NewRemoteUser) { return this.insertUser('remote', u.handle, u.displayName, u.feedUrl) }

  async getUser(id: string) {
    const r = await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()
    return r ? rowToUser(r) : undefined
  }
  async getUserByHandle(handle: string) {
    const r = await this.db.selectFrom('users').selectAll().where('handle', '=', handle).executeTakeFirst()
    return r ? rowToUser(r) : undefined
  }
  async listRemoteUsers() {
    const rs = await this.db.selectFrom('users').selectAll().where('kind', '=', 'remote').execute()
    return rs.map(rowToUser)
  }
  async insertPost(p: Post) {
    const [result] = await this.db
      .insertInto('posts')
      .values({ id: p.id, author_id: p.authorId, source: p.source, guid: p.guid, title: p.title, content: p.content, url: p.url, published_at: p.publishedAt, created_at: p.createdAt })
      .onConflict((oc) => oc.doNothing())
      .execute()
    return (result?.numInsertedOrUpdatedRows ?? 0n) > 0n
  }
  async hasPostsByAuthor(authorId: string) {
    const r = await this.db.selectFrom('posts').select('id').where('author_id', '=', authorId).executeTakeFirst()
    return r !== undefined
  }
  async getTimeline(limit: number): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at'])
      .orderBy('posts.published_at', 'desc')
      .orderBy('posts.id', 'desc')
      .limit(limit)
      .execute()
    return rows.map((r) => ({
      id: r.id, authorId: r.author_id, source: r.source, guid: r.guid, title: r.title, content: r.content, url: r.url, publishedAt: r.published_at, createdAt: r.created_at,
      author: { id: r.u_id, kind: r.u_kind, handle: r.u_handle, displayName: r.u_display_name, feedUrl: r.u_feed_url, createdAt: r.u_created_at },
    }))
  }
}

export async function createSqliteRepository(filename: string): Promise<SqliteRepository> {
  const sqlite = new Database(filename)
  sqlite.pragma('foreign_keys = ON')
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) })
  await db.schema.createTable('users').ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('handle', 'text', (c) => c.notNull().unique())
    .addColumn('display_name', 'text', (c) => c.notNull())
    .addColumn('feed_url', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema.createTable('posts').ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('author_id', 'text', (c) => c.notNull().references('users.id'))
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('guid', 'text', (c) => c.notNull())
    .addColumn('title', 'text')
    .addColumn('content', 'text', (c) => c.notNull())
    .addColumn('url', 'text')
    .addColumn('published_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('posts_author_guid_uq', ['author_id', 'guid'])
    .execute()
  await db.schema.createIndex('posts_published_idx').ifNotExists().on('posts').column('published_at').execute()
  return new SqliteRepository(db)
}
