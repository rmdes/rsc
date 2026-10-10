import { Kysely, SqliteDialect } from 'kysely'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { Repository } from '../domain/repository.ts'
import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry, Subscription, PushProtocol, FeedType, Page } from '../domain/types.ts'
import { HandleTakenError } from '../domain/types.ts'
import { hideResolvedReplyContext } from '../domain/types.ts'
import type { Cursor } from '../domain/source-repository.ts'
import { clampLimit, splitPage, reapSourceIfOrphaned, DEAD_SOURCE_FAILURES } from '../domain/source-repository.ts'
import { LOGICAL_V2_SCHEMA, LOGICAL_V3_SCHEMA, LOGICAL_V4_SCHEMA, LOGICAL_PERF_INDEXES, LOGICAL_PERF_INDEXES_2, AGGREGATE_PUBLISHER_IDENTITY_FIX, assertHandleUnreserved } from '../logical/schema.ts'
import type { LogicalStore } from '../logical/store.ts'
import { healMembers } from '../logical/membership.ts'
import { findCurrentDeliveryVersion } from '../logical/acquisition.ts'
import { deleteObservationVersions } from '../logical/tombstones.ts'
import { SqliteSourceRepository } from './source-sqlite.ts'

interface UsersTable { id: string; kind: 'local' | 'remote'; handle: string; display_name: string; feed_url: string | null; created_at: string; auth_user_id: string | null; feed_type: FeedType | null }
interface PostsTable { id: string; author_id: string; source: 'local' | 'remote'; guid: string; title: string | null; content: string; url: string | null; published_at: string; created_at: string; in_reply_to: string | null; in_reply_to_post_id: string | null; thread_root_id: string | null; source_name: string | null; source_feed_url: string | null; content_markdown: string | null; edited_at: string | null; reply_context_author: string | null; reply_context_snippet: string | null; local_only: number }
interface SubscriptionsTable { id: string; protocol: 'websub' | 'rsscloud'; topic: string; callback: string; callback_host: string; secret: string | null; expires_at: string; created_at: string }
interface FollowsTable { follower_id: string; followed_id: string; created_at: string }
interface PostRevisionsTable { id: string; post_id: string; title: string | null; content: string; content_markdown: string | null; seen_at: string }
interface InstanceSettingsTable { key: string; value: string }
interface DB { users: UsersTable; posts: PostsTable; subscriptions: SubscriptionsTable; follows: FollowsTable; post_revisions: PostRevisionsTable; instance_settings: InstanceSettingsTable }

function rowToUser(r: UsersTable): User {
  return { id: r.id, kind: r.kind, handle: r.handle, displayName: r.display_name, feedUrl: r.feed_url, createdAt: r.created_at, authUserId: r.auth_user_id, feedType: r.feed_type }
}

function rowToPost(r: PostsTable): Post {
  return { id: r.id, authorId: r.author_id, source: r.source, guid: r.guid, title: r.title, content: r.content, url: r.url, publishedAt: r.published_at, createdAt: r.created_at, inReplyTo: r.in_reply_to, inReplyToPostId: r.in_reply_to_post_id, threadRootId: r.thread_root_id, sourceName: r.source_name, sourceFeedUrl: r.source_feed_url, contentMarkdown: r.content_markdown, editedAt: r.edited_at, replyContextAuthor: r.reply_context_author, replyContextSnippet: r.reply_context_snippet }
}

function rowToSubscription(r: SubscriptionsTable): Subscription {
  return { id: r.id, protocol: r.protocol, topic: r.topic, callback: r.callback, callbackHost: r.callback_host, secret: r.secret, expiresAt: r.expires_at, createdAt: r.created_at }
}

// The permanent legacy-handle reservation guard (V4 §3.5) is defined ONCE in
// logical/schema.ts, next to the table it protects, because the v2 logical store
// must call the same function on its own rename path. Here it covers insertUser
// (which backs createLocalUser/createRemoteUser, and through them service
// ensureLocalUser and auth's guest allocation) and the v1 rename.

type JoinedRow = PostsTable & { u_id: string; u_kind: 'local' | 'remote'; u_handle: string; u_display_name: string; u_feed_url: string | null; u_created_at: string; u_auth_user_id: string | null; u_feed_type: FeedType | null }

function joinedRowToEntry(r: JoinedRow): TimelineEntry {
  return hideResolvedReplyContext({
    ...rowToPost(r),
    author: { id: r.u_id, kind: r.u_kind, handle: r.u_handle, displayName: r.u_display_name, feedUrl: r.u_feed_url, createdAt: r.u_created_at, authUserId: r.u_auth_user_id, feedType: r.u_feed_type },
  })
}

export class SqliteRepository implements Repository {
  private db: Kysely<DB>
  private sqlite: InstanceType<typeof Database>
  // The source-control plane, over the same connection.
  readonly sources: SqliteSourceRepository

  // Plain assignment instead of a parameter property: Node's native type
  // stripping (which replaced tsx) can't erase parameter properties.
  constructor(db: Kysely<DB>, sqlite: InstanceType<typeof Database>) {
    this.db = db
    this.sqlite = sqlite
    this.sources = new SqliteSourceRepository(sqlite)
  }

  get raw(): Database.Database {
    return this.sqlite
  }

  private async insertUser(kind: 'local' | 'remote', handle: string, displayName: string, feedUrl: string | null, authUserId: string | null, feedType: FeedType | null): Promise<User> {
    assertHandleUnreserved(this.sqlite, handle)
    const row: UsersTable = { id: randomUUID(), kind, handle, display_name: displayName, feed_url: feedUrl, created_at: new Date().toISOString(), auth_user_id: authUserId, feed_type: feedType }
    try {
      await this.db.insertInto('users').values(row).execute()
    } catch (err) {
      // In the createUser paths the reachable UNIQUE constraints are users.handle,
      // users.auth_user_id, and (as of migration 11) users.feed_url. handle/auth_user_id
      // surface as HandleTakenError here; callers that need to distinguish re-check via
      // getUserByAuthUserId. feed_url collisions also throw HandleTakenError — callers
      // (opml.ts) already treat that as "try another handle" / skip, which is correct here too.
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HandleTakenError('handle already taken')
      throw err
    }
    return rowToUser(row)
  }
  createLocalUser(u: NewLocalUser) { return this.insertUser('local', u.handle, u.displayName, null, u.authUserId ?? null, null) }
  createRemoteUser(u: NewRemoteUser) { return this.insertUser('remote', u.handle, u.displayName, u.feedUrl, null, u.feedType ?? 'webfeed') }

  async updateFeedUrl(userId: string, feedUrl: string) {
    await this.db.updateTable('users').set({ feed_url: feedUrl }).where('id', '=', userId).execute()
  }

  async getUser(id: string) {
    const r = await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()
    return r ? rowToUser(r) : undefined
  }
  async getUserByHandle(handle: string) {
    const r = await this.db.selectFrom('users').selectAll().where('handle', '=', handle).executeTakeFirst()
    return r ? rowToUser(r) : undefined
  }
  async getUserByAuthUserId(authUserId: string) {
    const r = await this.db.selectFrom('users').selectAll().where('auth_user_id', '=', authUserId).executeTakeFirst()
    return r ? rowToUser(r) : undefined
  }
  async setAuthUserId(userId: string, authUserId: string) {
    await this.db.updateTable('users').set({ auth_user_id: authUserId }).where('id', '=', userId).execute()
  }
  async countFollowers(userId: string) {
    const r = await this.db.selectFrom('follows').select(({ fn }) => fn.countAll().as('n')).where('followed_id', '=', userId).executeTakeFirst()
    return Number(r?.n ?? 0)
  }
  // Root posts only (in_reply_to_post_id IS NULL), matching the river's own
  // `river` filter (projector.ts: `AND p.in_reply_to_post_id IS NULL`) — the
  // author-lens stat must count what the river above it actually displays,
  // not replies folded under their thread's top card.
  async countPostsByAuthor(authorId: string) {
    const r = await this.db.selectFrom('posts').select(({ fn }) => fn.countAll().as('n')).where('author_id', '=', authorId).where('in_reply_to_post_id', 'is', null).executeTakeFirst()
    return Number(r?.n ?? 0)
  }
  async getSetting(key: string) {
    const r = await this.db.selectFrom('instance_settings').select('value').where('key', '=', key).executeTakeFirst()
    return r?.value
  }
  async setSetting(key: string, value: string) {
    await this.db.insertInto('instance_settings').values({ key, value }).onConflict((oc) => oc.column('key').doUpdateSet({ value })).execute()
  }
  async listFollowing(followerId: string): Promise<User[]> {
    const rows = await this.db
      .selectFrom('follows')
      .innerJoin('users', 'users.id', 'follows.followed_id')
      .select(['users.id as id', 'users.kind as kind', 'users.handle as handle', 'users.display_name as display_name', 'users.feed_url as feed_url', 'users.created_at as created_at', 'users.auth_user_id as auth_user_id', 'users.feed_type as feed_type'])
      .where('follows.follower_id', '=', followerId)
      .orderBy('follows.created_at', 'asc')
      .orderBy('users.handle', 'asc') // deterministic tiebreak for same-ms follows (P2)
      .execute()
    return rows.map(rowToUser)
  }
  async getPost(id: string): Promise<Post | undefined> {
    const r = await this.db.selectFrom('posts').selectAll().where('id', '=', id).executeTakeFirst()
    return r ? rowToPost(r) : undefined
  }

  // local_only = 0 on both feed queries below: these are the PUSH twins of
  // projectLocalActivity (domain/push.ts builds the fat-ping bodies from them,
  // never from the projector). A guest post filtered out of the pulled feed but
  // present in the pushed one still federates -- measured live 2026-08-18.
  // Their only production callers are those two push bodies; the service
  // passthroughs have none.
  async getPostsByAuthor(authorId: string, limit: number): Promise<Post[]> {
    const rows = await this.db.selectFrom('posts').selectAll().where('author_id', '=', authorId).where('local_only', '=', 0).orderBy('published_at', 'desc').orderBy('id', 'desc').limit(limit).execute()
    return rows.map(rowToPost)
  }

  async getRecentLocalPosts(limit: number): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id', 'users.feed_type as u_feed_type'])
      .where('users.kind', '=', 'local')
      .where('posts.local_only', '=', 0)
      .orderBy('posts.published_at', 'desc')
      .orderBy('posts.id', 'desc')
      .limit(limit)
      .execute()
    return rows.map(joinedRowToEntry)
  }

  async countRepliesByPostIds(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map()
    const rows = await this.db
      .selectFrom('posts')
      .select('in_reply_to_post_id')
      .select(({ fn }) => fn.countAll().as('n'))
      .where('in_reply_to_post_id', 'in', ids)
      .groupBy('in_reply_to_post_id')
      .execute()
    const counts = new Map(rows.map((r) => [r.in_reply_to_post_id as string, Number(r.n)]))
    // Union the v2 remote logical replies (they live in logical_items_v2, NOT posts),
    // mirroring the projector's childIds remote arm EXACTLY (projector.ts childIds:
    // origin='remote' AND parent_state='resolved' AND parent_logical_item_id = ?) so
    // the fat-ping source:comments count matches the pull body's directReplyCount.
    // Flag-OFF: v1 writes remote replies to `posts`, never here, so this adds +0 and
    // never double-counts (a remote reply is in EITHER posts OR logical_items_v2).
    // ponytail: counts resolved children without re-checking ordinary-visibility (the
    // projector also gates on eligible deliveries); a resolved child is visible in
    // practice — tighten to an eligibility join only if a divergence is observed.
    const ph = ids.map(() => '?').join(',')
    const remote = this.raw.prepare(
      `SELECT parent_logical_item_id AS pid, COUNT(*) AS n FROM logical_items_v2
       WHERE origin = 'remote' AND parent_state = 'resolved' AND parent_logical_item_id IN (${ph})
       GROUP BY parent_logical_item_id`,
    ).all(...ids) as { pid: string; n: number }[]
    for (const r of remote) counts.set(r.pid, (counts.get(r.pid) ?? 0) + Number(r.n))
    return counts
  }

  async upsertSubscription(s: Subscription) {
    await this.db
      .insertInto('subscriptions')
      .values({ id: s.id, protocol: s.protocol, topic: s.topic, callback: s.callback, callback_host: s.callbackHost, secret: s.secret, expires_at: s.expiresAt, created_at: s.createdAt })
      // Explicit conflict target + DO UPDATE: refreshes replace secret/expiry.
      // (The posts-table bare doNothing() pattern must not be copied here.)
      .onConflict((oc) => oc.columns(['protocol', 'topic', 'callback']).doUpdateSet({ secret: s.secret, expires_at: s.expiresAt, callback_host: s.callbackHost }))
      .execute()
  }
  async deleteSubscription(protocol: PushProtocol, topic: string, callback: string) {
    await this.db.deleteFrom('subscriptions').where('protocol', '=', protocol).where('topic', '=', topic).where('callback', '=', callback).execute()
  }
  async listActiveSubscriptions(topic: string, now: string): Promise<Subscription[]> {
    const rows = await this.db.selectFrom('subscriptions').selectAll().where('topic', '=', topic).where('expires_at', '>', now).execute()
    return rows.map(rowToSubscription)
  }
  async countActiveSubscriptions(filter: { callbackHost?: string; topic?: string }, now: string): Promise<number> {
    let q = this.db.selectFrom('subscriptions').select(({ fn }) => fn.countAll().as('n')).where('expires_at', '>', now)
    if (filter.callbackHost !== undefined) q = q.where('callback_host', '=', filter.callbackHost)
    if (filter.topic !== undefined) q = q.where('topic', '=', filter.topic)
    const row = await q.executeTakeFirst()
    return Number(row?.n ?? 0)
  }
  async purgeExpiredSubscriptions(now: string) {
    await this.db.deleteFrom('subscriptions').where('expires_at', '<=', now).execute()
  }

  // Manual cascade for a user: the LEGACY tables' FKs are plain REFERENCES with
  // no DB-level ON DELETE CASCADE. (The v2 tables DO declare ON DELETE CASCADE,
  // which is why the v2 reap below runs explicitly — the cascade removes the
  // subscription rows but cannot evaluate whether the source itself is retained.)
  // Shared by DELETE /users, removeFollow's orphaned-feed reap, removeRemoteFeed,
  // deleteLocalAccount's no-`logical`-passed branch, and sweepAnonymousUsers'
  // fallback (only when no `logical` is passed). post_revisions must go before
  // posts — its post_id FK is RESTRICT and foreign_keys=ON.
  //
  // UNSAFE for a LOCAL account that has posted under v2: `DELETE FROM posts`
  // below violates logical_local_origins_v2.post_id's ON DELETE RESTRICT,
  // because materializeLocalItem (logical/local.ts) gives every local post a
  // bridge row there (found Task 8b/8c, V1 retirement). Callers with a local
  // account MUST route through logical.deleteLocalAccount instead when a
  // `logical` store is available — see sweepAnonymousUsers and
  // service.deleteLocalAccount for the pattern. The three remaining raw
  // callers here are safe: removeFollow's reap and removeRemoteFeed only ever
  // delete `kind: 'remote'` users, and logical_local_origins_v2 is populated
  // exclusively for local posts, so a remote user's posts (if any exist) never
  // hold that bridge row; deleteLocalAccount's own call here only runs when no
  // `logical` store was passed (production always passes one; tests are the
  // only remaining case this cascade is meant for).
  deleteUserCascade(id: string): void {
    const raw = this.raw
    raw.transaction(() => {
      // v2 subscriptions go with the user via their own ON DELETE CASCADE, so
      // read the source ids first and re-evaluate retention after — otherwise
      // an account deletion leaves subscriber-less sources behind that no
      // unsubscribe will ever reach. Empty (a no-op) when the account has no
      // v2 source subscriptions.
      const sourceIds = (raw.prepare(`SELECT source_id FROM source_subscriptions_v2 WHERE owner_id = ?`).all(id) as { source_id: string }[]).map((r) => r.source_id)
      raw.prepare(`DELETE FROM follows WHERE follower_id = ? OR followed_id = ?`).run(id, id)
      raw.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(id)
      raw.prepare(`DELETE FROM post_revisions WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)`).run(id)
      raw.prepare(`DELETE FROM posts WHERE author_id = ?`).run(id)
      raw.prepare(`DELETE FROM users WHERE id = ?`).run(id)
      for (const sourceId of sourceIds) reapSourceIfOrphaned(raw, sourceId)
    })()
  }

  deleteAuthRows(authUserId: string): void {
    const raw = this.raw
    raw.transaction(() => {
      raw.prepare(`DELETE FROM session WHERE userId = ?`).run(authUserId)
      raw.prepare(`DELETE FROM account WHERE userId = ?`).run(authUserId)
      // Final review Finding 1: the apiKey plugin's `apikey` table has no FK
      // on referenceId (migration #21), so a key outlived every prior
      // deletion path here (admin hard-removal, self-serve, idle-guest
      // sweep — all three route through this one function) — the surviving
      // key then still verifyApiKey'd, and apiKeyAuth's ensureCoreUser
      // lazily minted a brand new core account for the now-orphaned
      // authUserId, resurrecting the "hard-removed" identity.
      raw.prepare(`DELETE FROM apikey WHERE referenceId = ?`).run(authUserId)
      raw.prepare(`DELETE FROM user WHERE id = ?`).run(authUserId)
    })()
  }

  // Under v2, remote feeds and remote items live in the v2 tables
  // (remote_sources_v2, logical_items_v2), not users/posts — a plain union
  // would double-count a converted DB that still has rows in both. So this
  // branches on the `v2` argument rather than unioning; production (api/app.ts)
  // always passes `true` now, and the v1 query (`false`) stays the untouched
  // original for tests.
  instanceStats(v2: boolean): { registeredUsers: number; guests: number; remoteFeeds: number; posts: number } {
    if (!v2) {
      return this.raw.prepare(
        `SELECT (SELECT COUNT(*) FROM user WHERE isAnonymous = 0 OR isAnonymous IS NULL) AS registeredUsers,
                (SELECT COUNT(*) FROM user WHERE isAnonymous = 1) AS guests,
                (SELECT COUNT(*) FROM users WHERE kind = 'remote') AS remoteFeeds,
                (SELECT COUNT(*) FROM posts) AS posts`,
      ).get() as { registeredUsers: number; guests: number; remoteFeeds: number; posts: number }
    }
    return this.raw.prepare(
      `SELECT (SELECT COUNT(*) FROM user WHERE isAnonymous = 0 OR isAnonymous IS NULL) AS registeredUsers,
              (SELECT COUNT(*) FROM user WHERE isAnonymous = 1) AS guests,
              (SELECT COUNT(*) FROM remote_sources_v2) AS remoteFeeds,
              (SELECT COUNT(*) FROM posts) + (SELECT COUNT(*) FROM logical_items_v2 WHERE origin = 'remote') AS posts`,
    ).get() as { registeredUsers: number; guests: number; remoteFeeds: number; posts: number }
  }

  listUsers(cursor: Cursor | undefined, limit: number): Page<{ handle: string; displayName: string; kind: 'local' | 'remote'; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }> {
    const lim = clampLimit(limit)
    const where = `(u.kind = 'remote' OR (u.kind = 'local' AND (au.isAnonymous = 0 OR au.isAnonymous IS NULL)))`
    const rows = (cursor
      ? this.raw.prepare(
          `SELECT u.id AS id, u.handle AS handle, u.display_name AS displayName, u.kind AS kind,
                  u.created_at AS created_at, u.feed_url AS feedUrl, au.emailVerified AS emailVerified
           FROM users u LEFT JOIN user au ON au.id = u.auth_user_id
           WHERE ${where} AND ((u.created_at < ?) OR (u.created_at = ? AND u.id < ?))
           ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
        ).all(cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
      : this.raw.prepare(
          `SELECT u.id AS id, u.handle AS handle, u.display_name AS displayName, u.kind AS kind,
                  u.created_at AS created_at, u.feed_url AS feedUrl, au.emailVerified AS emailVerified
           FROM users u LEFT JOIN user au ON au.id = u.auth_user_id
           WHERE ${where}
           ORDER BY u.created_at DESC, u.id DESC LIMIT ?`,
        ).all(lim + 1)
    ) as Array<{ id: string; created_at: string; handle: string; displayName: string; kind: 'local' | 'remote'; feedUrl: string | null; emailVerified: number | null }>
    const { page, nextCursor } = splitPage(rows, lim)
    return {
      items: page.map((r) => ({
        handle: r.handle,
        displayName: r.displayName,
        kind: r.kind,
        createdAt: r.created_at,
        feedUrl: r.feedUrl,
        emailVerified: r.emailVerified === null ? null : r.emailVerified === 1,
      })),
      nextCursor,
    }
  }

  // Same raw-query pattern against the better-auth `user` table as listUsers
  // above (and the same emailVerified integer->boolean cast) but keyed
  // directly by auth_user_id for a single-row lookup — used by
  // apiKeyAuthAdmin to re-derive an api key owner's CURRENT admin status on
  // every request, not just at key-mint time. Domain `User` has no
  // email/emailVerified fields (those live only in better-auth's own `user`
  // table), so this can't reuse getUserByAuthUserId.
  async getAuthUserAdminFields(authUserId: string): Promise<{ email: string | null; emailVerified: boolean | null } | undefined> {
    const row = this.raw.prepare(`SELECT email, emailVerified FROM user WHERE id = ?`).get(authUserId) as
      | { email: string | null; emailVerified: number | null }
      | undefined
    if (!row) return undefined
    return { email: row.email, emailVerified: row.emailVerified === null ? null : row.emailVerified === 1 }
  }

  // Security audit M4: backs the per-user api-key issuance cap in
  // logical-routes.ts (POST /me/api-keys, POST /admin/api-keys). referenceId
  // and configId each have their own single-column index (apikey_referenceId_idx,
  // apikey_configId_idx below) — no composite index, but this table stays
  // small per user (capped at 20), so the plan scan on the smaller of the two
  // indexed columns is fine.
  async countApiKeys(authUserId: string, configId: string): Promise<number> {
    const row = this.raw.prepare(`SELECT COUNT(*) AS n FROM apikey WHERE referenceId = ? AND configId = ?`).get(authUserId, configId) as { n: number }
    return row.n
  }

  close(): void {
    this.raw.pragma('wal_checkpoint(TRUNCATE)')
    this.raw.close()
  }

  // The reclaim core shared by sweepAnonymousUsers and sweepUnverifiedUsers.
  // Extracted rather than copied on purpose: the deletion path below must stay
  // single-sourced. Duplicating this loop is exactly how the post_revisions /
  // logical_local_origins_v2 FK bugs and the surviving-apikey resurrection
  // would come back. Callers pass their own candidate set; `orphans` is the
  // general users-without-an-auth-row repair and belongs to sweepAnonymousUsers
  // only, so the other caller passes [].
  //
  // Idle = latest session update, else auth-user createdAt. Candidate selection
  // happens in JS rather than SQL to dodge better-auth's date-storage format
  // (new Date() parses ISO strings and epoch numbers alike) — the cutoff is not
  // expressible as one portable comparison across both.
  // ponytail: loads every candidate row into memory per sweep. Fine for anon
  // guests ("few" was the original justification) but F-3's unverified set is
  // precisely the one that grows under sign-up abuse — bounded today by the
  // 20/hr instance-wide mail cap, so worst case is ~480 new rows/day. If that
  // cap is ever raised or bypassed, push the cutoff into SQL by normalizing
  // createdAt at write time instead of widening this scan.
  //
  // `logical` (when passed) routes both branches through
  // logical.deleteLocalAccount instead of the raw this.deleteUserCascade:
  // deleteUserCascade's `DELETE FROM posts` violates
  // logical_local_origins_v2.post_id's ON DELETE RESTRICT for any account that
  // has posted under v2, and both branches share ONE raw.transaction() here —
  // a single FK violation rolled back the whole hourly sweep batch (found
  // during Task 8b, V1 retirement). deleteLocalAccount clears each post's v2
  // origin row per-post first, so it never hits the FK. Falls back to
  // deleteUserCascade only when no logical store is available (never true in
  // production since Task 6; kept for tests that omit the store).
  private sweepAuthUsers(
    candidates: { id: string; createdAt: string | number }[],
    orphans: { id: string }[],
    ttlDays: number,
    logical?: LogicalStore,
  ): { swept: number } {
    const raw = this.raw
    const cutoff = Date.now() - ttlDays * 86400_000
    const latest = new Map(
      (raw.prepare(`SELECT userId, MAX(updatedAt) AS ts FROM session GROUP BY userId`).all() as { userId: string; ts: string | number }[]).map((r) => [r.userId, r.ts]),
    )
    const idle = candidates.filter((a) => new Date(latest.get(a.id) ?? a.createdAt).getTime() < cutoff)

    const deleteAccount = (id: string) => {
      if (logical) logical.deleteLocalAccount({ accountId: id, actorId: id, now: new Date().toISOString() })
      else this.deleteUserCascade(id)
    }

    let swept = 0
    raw.transaction(() => {
      for (const a of idle) {
        const core = raw.prepare(`SELECT id FROM users WHERE auth_user_id = ?`).get(a.id) as { id: string } | undefined
        if (core) deleteAccount(core.id)
        this.deleteAuthRows(a.id)
        swept++
      }
      for (const o of orphans) {
        deleteAccount(o.id)
        swept++
      }
    })()
    return { swept }
  }

  // Dead-source sweep. Candidates are selected ONLY on health (never succeeded,
  // failed repeatedly); every question of whether a given source may actually be
  // removed is left to reapSource, which is the one authority on that. So this
  // cannot delete a feed somebody subscribes to, a federated peer, or an
  // admin-retained source — reapSource refuses each, and the sweep just counts a
  // refusal as "not swept". Its own two evidence guards yield here because a URL
  // that has never resolved is not evidence of anything (isDeadSource).
  sweepDeadSources(): { swept: number } {
    const raw = this.raw
    const candidates = raw.prepare(
      `SELECT s.id AS id FROM remote_sources_v2 s JOIN source_health_v2 h ON h.source_id = s.id
        WHERE h.last_success_at IS NULL AND h.consecutive_failures >= ?`,
    ).all(DEAD_SOURCE_FAILURES) as { id: string }[]
    let swept = 0
    raw.transaction(() => {
      for (const c of candidates) if (reapSourceIfOrphaned(raw, c.id)) swept++
    })()
    return { swept }
  }

  sweepAnonymousUsers(ttlDays: number, logical?: LogicalStore): { swept: number } {
    const raw = this.raw
    const anons = raw.prepare(`SELECT id, createdAt FROM user WHERE isAnonymous = 1`).all() as { id: string; createdAt: string | number }[]
    const orphans = raw
      .prepare(`SELECT u.id FROM users u LEFT JOIN user au ON au.id = u.auth_user_id WHERE u.auth_user_id IS NOT NULL AND au.id IS NULL AND u.kind = 'local'`)
      .all() as { id: string }[]
    return this.sweepAuthUsers(anons, orphans, ttlDays, logical)
  }

  // F-3: an abandoned sign-up or an SMTP-down outage leaves a never-verified
  // row that nothing else reclaims. Hard deletion is safe here because
  // auth.ts sets requireEmailVerification: true, so better-auth issues no
  // session token at sign-up (docs, "Email Enumeration Protection") — an
  // unverified row can never sign in, and therefore never posted, followed or
  // subscribed. It has no session either, so `createdAt` is its only clock,
  // which the shared idle filter already falls back to.
  //
  // `COALESCE(isAnonymous, 0) = 0` is load-bearing: anonymous rows are also
  // emailVerified = 0 and are the anon sweep's business. Without it one row
  // would be swept — and counted — twice.
  sweepUnverifiedUsers(ttlDays: number, logical?: LogicalStore): { swept: number } {
    const rows = this.raw
      .prepare(`SELECT id, createdAt FROM user WHERE emailVerified = 0 AND COALESCE(isAnonymous, 0) = 0`)
      .all() as { id: string; createdAt: string | number }[]
    return this.sweepAuthUsers(rows, [], ttlDays, logical)
  }
}

// index N-1 holds the statements that bring the schema to version N.
//
// Not every version is pure SQL: migrate() (below) also runs a one-shot
// imperative heal the first time a database crosses these versions, so read
// it together with this array before reasoning about what a version did:
//   19 — ALTER (the `overridden` column) + healMembers()
//   22 — empty [] marker              + collapseVersionHistory()
//   23 — empty [] marker              + healStrandedMembers()
// An empty [] entry is never dead: it exists only to advance user_version so
// its heal fires exactly once. Append new versions at the TAIL only — a
// mid-array insertion renumbers every later version and corrupts user_version
// on live databases.
export const MIGRATIONS: string[][] = [
  [
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
  ],
  [
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
  ],
  [
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
  ],
  [
    `CREATE TABLE follows (
      follower_id text NOT NULL REFERENCES users(id),
      followed_id text NOT NULL REFERENCES users(id),
      created_at text NOT NULL,
      PRIMARY KEY (follower_id, followed_id)
    ) WITHOUT ROWID`,
    'CREATE INDEX posts_author_pub_idx ON posts (author_id, published_at, id)',
  ],
  [
    'ALTER TABLE posts ADD COLUMN in_reply_to text',
    'ALTER TABLE posts ADD COLUMN in_reply_to_post_id text',
    'ALTER TABLE posts ADD COLUMN thread_root_id text',
    'CREATE INDEX posts_thread_idx ON posts (thread_root_id)',
    'CREATE INDEX posts_reply_to_idx ON posts (in_reply_to)',
    'CREATE INDEX posts_parent_idx ON posts (in_reply_to_post_id)',
  ],
  [
    // Per-item attribution from aggregate feeds (RSS core <source url>name</source>)
    'ALTER TABLE posts ADD COLUMN source_name text',
    'ALTER TABLE posts ADD COLUMN source_feed_url text',
  ],
  [
    // Incoming source:markdown, verbatim — the Textcasting preferred display source
    'ALTER TABLE posts ADD COLUMN content_markdown text',
  ],
  [
    // better-auth 1.6.23 tables, generated by `@better-auth/cli generate`
    // (emailAndPassword + anonymous plugin). better-auth never migrates at
    // runtime; this array is the only schema mechanism. A future better-auth
    // schema change = a NEW migration entry, same rule.
    `create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "isAnonymous" integer)`,
    `create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade)`,
    `create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null)`,
    `create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null)`,
    'create index "session_userId_idx" on "session" ("userId")',
    'create index "account_userId_idx" on "account" ("userId")',
    'create index "verification_identifier_idx" on "verification" ("identifier")',
    // accounts <-> timeline identities link (SQLite UNIQUE ignores NULLs,
    // so remote feeds — always NULL — are unaffected)
    'ALTER TABLE users ADD COLUMN auth_user_id text',
    'CREATE UNIQUE INDEX users_auth_user_idx ON users (auth_user_id)',
  ],
  [
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
  ],
  [
    'ALTER TABLE posts ADD COLUMN reply_context_author text',
    'ALTER TABLE posts ADD COLUMN reply_context_snippet text',
  ],
  [
    'ALTER TABLE users ADD COLUMN feed_type text',
    // instances = Textcasting peers: their items carry source:markdown (content_markdown).
    `UPDATE users SET feed_type = 'instance'
       WHERE kind='remote' AND EXISTS (SELECT 1 FROM posts p WHERE p.author_id = users.id AND p.content_markdown IS NOT NULL)`,
    `UPDATE users SET feed_type = 'webfeed' WHERE kind='remote' AND feed_type IS NULL`,
    // atomic find-or-create + backs getRemoteUserByFeedUrl. SQLite UNIQUE ignores NULLs (local rows). Same as users_auth_user_idx.
    'CREATE UNIQUE INDEX users_feed_url_idx ON users (feed_url)',
    `CREATE TABLE instance_settings (key text PRIMARY KEY, value text)`,
    `INSERT INTO instance_settings (key, value) VALUES ('max_subs_per_user', '500')`,
  ],
  [
    // v2 source-control plane. The SQL CHECKs are deliberately WIDER than
    // the V1 TS enums in domain/types.ts (source_audit_v2.category carries
    // all nine foundation categories, actor_kind carries operator_token,
    // command_ledger_v2.actor_scope carries ops) — SQLite cannot widen a
    // CHECK without a table rebuild, so the vocabulary is pinned wide at
    // creation (rev 5, V4 §10 pin; lockstep amendment in V3 §1.2).
    `CREATE TABLE remote_sources_v2 (
      id TEXT PRIMARY KEY, canonical_url TEXT NOT NULL UNIQUE,
      attribution_mode TEXT NOT NULL CHECK(attribution_mode IN ('single_publisher','aggregate')),
      operation TEXT NOT NULL CHECK(operation IN ('enabled','paused')),
      governance TEXT NOT NULL CHECK(governance IN ('allowed','quarantined','blocked')),
      provenance TEXT NOT NULL CHECK(provenance IN ('user_subscription','opml','admin_federation','origin_verification','migration')),
      provenance_note TEXT, admin_retained INTEGER NOT NULL DEFAULT 0 CHECK(admin_retained IN (0,1)),
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE federation_relationships_v2 (
      source_id TEXT PRIMARY KEY REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('pending','approved')),
      provenance_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE source_subscriptions_v2 (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('active','pending','pending_review')),
      created_at TEXT NOT NULL, UNIQUE(owner_id,source_id)
    )`,
    `CREATE TABLE source_audit_v2 (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES remote_sources_v2(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL, actor_id TEXT,
      actor_kind TEXT NOT NULL CHECK(actor_kind IN ('administrator','operator_token','system')),
      action TEXT NOT NULL,
      category TEXT CHECK(category IS NULL OR category IN ('spam','abuse','illegal_content','compromised_source','migration_review','operator_policy','false_positive','remediated','other')),
      note TEXT, result_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`,
    `CREATE TABLE command_ledger_v2 (
      actor_scope TEXT NOT NULL CHECK(actor_scope IN ('owner','administrator','ops','system')),
      actor_id TEXT NOT NULL, command_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(actor_scope,actor_id,command_id)
    )`,
    'CREATE INDEX remote_sources_v2_page ON remote_sources_v2(created_at DESC,id DESC)',
    'CREATE INDEX source_subscriptions_v2_owner_state ON source_subscriptions_v2(owner_id,state,source_id)',
    'CREATE INDEX source_audit_v2_page ON source_audit_v2(source_id,created_at DESC,id DESC)',
  ],
  // Logical-v2 additive schema. Appended at the TAIL — mid-array insertion
  // corrupts user_version on live databases. Pure additive CREATE/ALTER/INSERT;
  // creates only the inactive activation row (flipped to active by
  // activateLogicalV2 at boot). Defined in logical/schema.ts; see plan
  // Appendix A.
  LOGICAL_V2_SCHEMA,
  // Logical-v3 additive schema (moderation/events/verification). Appended at
  // the TAIL, AFTER LOGICAL_V2_SCHEMA — mid-array insertion corrupts
  // user_version on live databases. Pure additive ALTER/CREATE. Defined in
  // logical/schema.ts; see the V3 plan Appendix A.
  LOGICAL_V3_SCHEMA,
  // Logical-v4 additive schema (migration & cutover). Appended at the TAIL,
  // AFTER LOGICAL_V3_SCHEMA — mid-array insertion corrupts user_version on
  // live databases. Pure additive CREATE/ALTER. Defined in logical/schema.ts;
  // see the V4 plan Appendix A.
  LOGICAL_V4_SCHEMA,
  // Read-path performance index (post-V4 hotfix). Appended at the TAIL, AFTER
  // LOGICAL_V4_SCHEMA — mid-array insertion corrupts user_version on live
  // databases. Pure additive CREATE INDEX on logical_identity_keys_v2
  // (logical_item_id): the read path scanned that 32k-row table per item, ~2s
  // timelines + 100% CPU on the main instance. Defined in logical/schema.ts.
  LOGICAL_PERF_INDEXES,
  // Read-path performance indexes, round 2 (migration #17). Appended at the TAIL,
  // AFTER LOGICAL_PERF_INDEXES — mid-array insertion corrupts user_version on live
  // databases. Pure additive CREATE INDEX on the 19 remaining un-indexed v2 FK
  // columns (13 tables) that SQLite left as full SCANs; results unchanged, plans
  // only. Kept exhaustive by the FK-coverage guardrail. Defined in logical/schema.ts.
  LOGICAL_PERF_INDEXES_2,
  // Aggregate-publisher identity fix (migration #18). Appended at the TAIL,
  // AFTER LOGICAL_PERF_INDEXES_2 — mid-array insertion corrupts user_version
  // on live databases. Pure data UPDATE/DELETE, no DDL. Defined in
  // logical/schema.ts; see the 2026-07-27/28 spec rev 2.
  AGGREGATE_PUBLISHER_IDENTITY_FIX,
  // 19 — instance-governed members (spec 2026-07-25): the sticky-override bit.
  // Appended at the TAIL, AFTER AGGREGATE_PUBLISHER_IDENTITY_FIX (migration
  // #18) — mid-array insertion corrupts user_version on live databases.
  // DEFAULT 1: every existing INSERT omits the column and every non-mint row
  // is a deliberate act; the origin_verification mint writes an explicit 0.
  [`ALTER TABLE remote_sources_v2 ADD COLUMN overridden INTEGER NOT NULL DEFAULT 1 CHECK (overridden IN (0,1))`],
  // 20 — scalable ingest scheduler (spec 2026-07-28, post-review): two indexes
  // on acquisition_runs_v2, which grows one row per source per poll forever.
  // NOT an index on source_health_v2(last_poll_at) as first shipped — EXPLAIN
  // QUERY PLAN confirmed that never helps listDueSources's ORDER BY (the LEFT
  // JOIN forces remote_sources_v2 as the outer loop, so no index on the inner
  // table's sort column can satisfy it; SQLite always builds a temp B-tree
  // there regardless — fine at any realistic catalog size, a sort is not the
  // concern). These two DO have a real, growing table behind them: `started_at`
  // backs schedulerStats's range scan (WHERE started_at >= ?), `status` backs
  // healOrphanedRuns's lookup (WHERE status = 'processing') — a B-tree index
  // lookup stays O(log n + matches) regardless of how skewed the status
  // distribution is (nearly all rows are 'terminal'), so this doesn't degrade
  // as the table grows the way the full scan would. Appended at the TAIL,
  // AFTER migration #19 (the overridden column) — mid-array insertion corrupts
  // user_version on live databases. Pure additive CREATE INDEX, no table rebuilt.
  [
    `CREATE INDEX acquisition_runs_v2_started_at ON acquisition_runs_v2(started_at)`,
    `CREATE INDEX acquisition_runs_v2_status ON acquisition_runs_v2(status)`,
  ],
  // 21 — @better-auth/api-key plugin, one `user`-referencing config (external-
  // API design phase 2, spec 2026-07-30). The `apikey` table, generated by
  // calling better-auth's own getMigrations()/compileMigrations() against
  // this repo's actual auth.ts config (better-auth 1.6.25 never migrates at
  // runtime; this array is the only schema mechanism — same rule as
  // migration #8's user/session/account/verification tables). Appended at
  // the TAIL, AFTER migration #20 — mid-array insertion corrupts
  // user_version on live databases.
  [
    `create table "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" date, "enabled" integer, "rateLimitEnabled" integer, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" date, "expiresAt" date, "createdAt" date not null, "updatedAt" date not null, "permissions" text, "metadata" text)`,
    `create index "apikey_configId_idx" on "apikey" ("configId")`,
    `create index "apikey_referenceId_idx" on "apikey" ("referenceId")`,
    `create index "apikey_key_idx" on "apikey" ("key")`,
  ],
  // 22 — Phase B collapse migration marker (spec 2026-08-05). Pure no-op SQL:
  // this entry exists ONLY to advance user_version so the migrate() gate below
  // fires collapseVersionHistory exactly once. The actual work (collapsing
  // pre-existing multi-version deliveries to one version + one presentation
  // entry) is imperative TS, not SQL — it calls deleteObservationVersions,
  // which MIGRATIONS (pure sqlite.exec SQL) cannot do. Same split as
  // migration #19 / healMembers.
  [],
  // 23 — instance-member reap recovery heal (spec 2026-08-06 Part 2). Pure
  // no-op SQL: this entry exists ONLY to advance user_version so the
  // migrate() gate below fires healStrandedMembers exactly once. The actual
  // work (resetting verified checks/jobs stranded by the pre-fix reap bug so
  // the normal verification drain re-mints them, now guard-protected) is
  // imperative TS, not SQL — same split as migration #19 / healMembers and
  // migration #22 / collapseVersionHistory. Appended at the TAIL, AFTER
  // migration #22 — mid-array insertion corrupts user_version on live
  // databases.
  [],
  // Migration 24 (2026-08-18): guest posts are LOCAL ONLY — a guest account is
  // transient, and once swept its per-user feed 404s forever, stranding peer
  // copies attributed to an account that no longer exists. Why the flag is on
  // the post rather than derived from the author: createLocalPost in
  // logical/local.ts. Backfill covers currently-anonymous authors; already-swept
  // guests have no rows left here, and their peer-side residue needs the dead
  // sources deleted instead.
  [
    'ALTER TABLE posts ADD COLUMN local_only integer NOT NULL DEFAULT 0',
    `UPDATE posts SET local_only = 1 WHERE author_id IN (
       SELECT u.id FROM users u JOIN user au ON au.id = u.auth_user_id WHERE au.isAnonymous = 1)`,
  ],
  // Migration 25 (2026-08-19): better-auth 1.7 account identity.
  // 1.7 recognizes an external account by the unique (issuer, accountId) pair
  // and its INSERTs supply `issuer` — without the column, every sign-up/link
  // fails with "table account has no column named issuer". Backfill per the
  // 1.7 upgrade guide's table: credential accounts get 'local:credential'.
  // This deployment is credential-only (emailAndPassword + magicLink + anonymous
  // + apiKey configure no OAuth providers; verified on prod: providerId =
  // 'credential' exclusively), so that one UPDATE covers every existing row.
  // Index name is the guide's own (account_issuer_accountId_uidx).
  [
    `ALTER TABLE account ADD COLUMN issuer text`,
    `UPDATE account SET issuer = 'local:credential' WHERE providerId = 'credential'`,
    `CREATE UNIQUE INDEX account_issuer_accountId_uidx ON account (issuer, accountId)`,
  ],
  // Migration 26 (2026-09-13): better-auth 1.7.3 dropped the issuer identity
  // again — accounts are keyed by (providerId, accountId) as in 1.6 and new rows
  // never write `issuer`. Migration 25's column and index are dead; this is the
  // 1.7 upgrade guide's SQLite cleanup, verbatim (index first: DROP COLUMN
  // refuses an indexed column).
  [
    `DROP INDEX account_issuer_accountId_uidx`,
    `ALTER TABLE account DROP COLUMN issuer`,
  ],
]

function migrate(sqlite: InstanceType<typeof Database>): void {
  const version = sqlite.pragma('user_version', { simple: true }) as number
  if (version > MIGRATIONS.length) {
    throw new Error(`database is newer than this build (version ${version}, this build knows ${MIGRATIONS.length})`)
  }
  if (version === 0) {
    const { n } = sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }
    // Intentionally rejects valid current-schema spine DBs too: everything
    // created before the migration era has user_version = 0, and we do not
    // sniff the schema to grandfather them in. Deletion is the designed outcome.
    if (n > 0) throw new Error('pre-migration database — delete it (dev data only) and restart')
  }
  for (let v = version + 1; v <= MIGRATIONS.length; v++) {
    sqlite.transaction(() => {
      for (const stmt of MIGRATIONS[v - 1]) sqlite.exec(stmt)
      sqlite.pragma(`user_version = ${v}`)
    })()
  }
  // 19 — instance-governed members: members adopt their instance NOW, once,
  // the first time this DB crosses migration 19. healMembers wraps its own
  // transaction — safe even if the process dies mid-heal.
  if (version < 19) healMembers(sqlite)
  // 22 — Phase B: collapse every pre-existing multi-version delivery down to
  // one version + one presentation entry, the first time this DB crosses
  // migration 22. collapseVersionHistory wraps its own transaction — safe
  // even if the process dies mid-heal, and idempotent (a re-run finds nothing
  // left with >1 version).
  if (version < 22) collapseVersionHistory(sqlite)
  // 23 — instance-member reap recovery: reset every verification_checks_v2
  // row stranded 'verified' by the pre-fix reap bug (its minted member
  // source was deleted) back to 'pending' and re-pend its verification job,
  // the first time this DB crosses migration 23. healStrandedMembers wraps its
  // own transaction, so it is ATOMIC (a crash mid-heal rolls back cleanly, no
  // corruption) and idempotent (a re-run finds nothing stranded). Like
  // migrations 19/22 it is NOT re-run-guaranteed: user_version commits in its
  // own txn above, so a crash after that bump but before the heal commit skips
  // this one-time recovery forever — harmless, since prevention (the reap
  // guard) is unaffected and members re-mint from new content over time.
  if (version < 23) healStrandedMembers(sqlite)
}

// Phase B collapse migration (spec 2026-08-05, plan Task 4; review C-A/C-C/I-B).
// For every remote delivery still carrying more than one observation_versions_v2
// row (the pre-Task-1/2 cap era let a changed fingerprint append a sibling
// instead of overwriting in place), keep exactly the CURRENT-DISPLAY version —
// the one backing the delivery's top-sequence presentation_entries_v2 row, or,
// absent a presentation entry (I-B), the newest by arrival_at — and delete every
// other version of that delivery via the shared deleteObservationVersions
// cascade (tombstones.ts:205), which also removes their publisher_claims_v2/
// publisher_names_v2 rows. No byline re-point (review C-C): selectAuthor already
// prefers the retained current publisher, so the survivor's own claim is a fine
// byline post-collapse. Local post_revisions/posts are a separate table tree,
// untouched. Idempotent: a delivery already down to one version never matches
// the GROUP BY HAVING > 1 below, so a second run is a no-op.
export function collapseVersionHistory(sqlite: InstanceType<typeof Database>): void {
  sqlite.transaction(() => {
    const deliveries = sqlite.prepare(
      `SELECT delivery_id AS id FROM observation_versions_v2 GROUP BY delivery_id HAVING COUNT(*) > 1`,
    ).all() as { id: string }[]
    for (const { id: deliveryId } of deliveries) {
      const survivor = findCurrentDeliveryVersion(sqlite, deliveryId)
      if (!survivor) continue // unreachable (the GROUP BY guarantees >=2 rows) — never delete on an absent survivor
      const others = (sqlite.prepare(
        `SELECT id FROM observation_versions_v2 WHERE delivery_id = ? AND id != ?`,
      ).all(deliveryId, survivor.id) as { id: string }[]).map((r) => r.id)
      deleteObservationVersions(sqlite, others)
      // At most one presentation_entries_v2 row can remain for this delivery now
      // (UNIQUE observation_version_id, and every other version's entry was just
      // deleted with it) — normalize its sequence to 0, matching the one-entry-
      // per-delivery invariant Task 1 established for the write path.
      sqlite.prepare(`UPDATE presentation_entries_v2 SET sequence = 0 WHERE delivery_id = ?`).run(deliveryId)
    }
  })()
}

// One-time recovery heal (spec 2026-08-06 Part 2, plan Task 4). The pre-fix
// reapSource bug deleted an instance-governed member's remote_sources_v2 row
// whenever its verified_origin claim churned away between polls, leaving
// verification_checks_v2 stuck 'verified' for a source that no longer
// exists and its reconciliation_jobs_v2 verification job stuck terminal.
// Reset both back to their fresh-scheduleVerification shape so the normal
// verification drain re-mints the member — now guard-protected by Task 1, so
// it cannot be reaped out from under itself again. A batch key covered by a
// live remote_sources_v2 row, or by a blocked_source_tombstones_v2 row (a
// deliberately purged member — never resurrect it), is left untouched.
export function healStrandedMembers(sqlite: InstanceType<typeof Database>): void {
  const bks = (sqlite.prepare(`
    SELECT DISTINCT vc.batch_key AS bk FROM verification_checks_v2 vc
    WHERE vc.state = 'verified'
      AND NOT EXISTS (SELECT 1 FROM remote_sources_v2 s WHERE s.canonical_url = vc.batch_key)
      AND NOT EXISTS (SELECT 1 FROM blocked_source_tombstones_v2 t WHERE t.canonical_url = vc.batch_key)
  `).all() as { bk: string }[]).map((r) => r.bk)
  if (bks.length === 0) return
  const now = new Date().toISOString()
  const CHUNK = 500
  const run = sqlite.transaction(() => {
    for (let i = 0; i < bks.length; i += CHUNK) {
      const c = bks.slice(i, i + CHUNK); const ph = c.map(() => '?').join(',')
      sqlite.prepare(`UPDATE verification_checks_v2 SET state='pending', resolved_at=NULL WHERE state='verified' AND batch_key IN (${ph})`).run(...c)
      sqlite.prepare(`UPDATE reconciliation_jobs_v2 SET status='pending', attempts=0, next_attempt_at=?, failure_category=NULL, diagnostic=NULL WHERE kind='verification' AND verification_batch_key IN (${ph})`).run(now, ...c)
    }
  })
  run()
}

export async function createSqliteRepository(filename: string): Promise<SqliteRepository> {
  const sqlite = new Database(filename)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  // Cap the WAL file so a big write burst can't leave a giant file behind. Without
  // this (default -1 = unbounded) the WAL grows during a burst and NEVER shrinks:
  // the only TRUNCATE was at close() and it's busy-blocked while the app holds
  // readers, so a heavy-federation instance grew a 2.1GB WAL (main's is 11MB) whose
  // per-op scans/checkpoints stalled the synchronous event loop for seconds.
  // journal_size_limit truncates the WAL back to this cap after each checkpoint.
  sqlite.pragma('journal_size_limit = 67108864') // 64MB
  // Cheap read-path wins (v2 read model): memory-map the DB, a bigger page cache,
  // and temp tables in RAM. Additive — plans/latency only, never results.
  sqlite.pragma('mmap_size = 268435456') // 256MB memory-mapped I/O
  sqlite.pragma('cache_size = -65536') // 64MB page cache (negative = KiB)
  sqlite.pragma('temp_store = MEMORY')
  migrate(sqlite)
  // One-time reclamation of an already-bloated WAL. Runs HERE — after migrate,
  // before the server/streams/poll open any second reader — so this connection is
  // EXCLUSIVE and TRUNCATE is never busy-blocked (the running-app checkpoint always
  // is). On a healthy DB it is a fast no-op; on the 2.1GB-WAL instance it shrinks
  // the file to zero on the next boot. journal_size_limit keeps it capped after.
  sqlite.pragma('wal_checkpoint(TRUNCATE)')
  // SQLite-recommended self-tuning ANALYZE on open; cheap, refreshes stat plans.
  sqlite.pragma('optimize')
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) })
  return new SqliteRepository(db, sqlite)
}
