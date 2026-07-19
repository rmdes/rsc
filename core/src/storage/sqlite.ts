import { Kysely, SqliteDialect } from 'kysely'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { Repository } from '../domain/repository.ts'
import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry, TimelineCursor, Subscription, PushSubscription, PushProtocol, FeedType } from '../domain/types.ts'
import { HandleTakenError } from '../domain/types.ts'
import { hideResolvedReplyContext } from '../domain/types.ts'

interface UsersTable { id: string; kind: 'local' | 'remote'; handle: string; display_name: string; feed_url: string | null; created_at: string; auth_user_id: string | null; feed_type: FeedType | null }
interface PostsTable { id: string; author_id: string; source: 'local' | 'remote'; guid: string; title: string | null; content: string; url: string | null; published_at: string; created_at: string; in_reply_to: string | null; in_reply_to_post_id: string | null; thread_root_id: string | null; source_name: string | null; source_feed_url: string | null; content_markdown: string | null; edited_at: string | null; reply_context_author: string | null; reply_context_snippet: string | null }
interface SubscriptionsTable { id: string; protocol: 'websub' | 'rsscloud'; topic: string; callback: string; callback_host: string; secret: string | null; expires_at: string; created_at: string }
interface PushSubscriptionsTable { id: string; user_id: string; mode: 'websub' | 'rsscloud'; endpoint: string; topic: string; callback_token: string; secret: string | null; state: 'pending' | 'active'; expires_at: string; created_at: string }
interface FollowsTable { follower_id: string; followed_id: string; created_at: string }
interface PostRevisionsTable { id: string; post_id: string; title: string | null; content: string; content_markdown: string | null; seen_at: string }
interface InstanceSettingsTable { key: string; value: string }
interface DB { users: UsersTable; posts: PostsTable; subscriptions: SubscriptionsTable; push_subscriptions: PushSubscriptionsTable; follows: FollowsTable; post_revisions: PostRevisionsTable; instance_settings: InstanceSettingsTable }

function rowToUser(r: UsersTable): User {
  return { id: r.id, kind: r.kind, handle: r.handle, displayName: r.display_name, feedUrl: r.feed_url, createdAt: r.created_at, authUserId: r.auth_user_id, feedType: r.feed_type }
}

function rowToPost(r: PostsTable): Post {
  return { id: r.id, authorId: r.author_id, source: r.source, guid: r.guid, title: r.title, content: r.content, url: r.url, publishedAt: r.published_at, createdAt: r.created_at, inReplyTo: r.in_reply_to, inReplyToPostId: r.in_reply_to_post_id, threadRootId: r.thread_root_id, sourceName: r.source_name, sourceFeedUrl: r.source_feed_url, contentMarkdown: r.content_markdown, editedAt: r.edited_at, replyContextAuthor: r.reply_context_author, replyContextSnippet: r.reply_context_snippet }
}

function rowToSubscription(r: SubscriptionsTable): Subscription {
  return { id: r.id, protocol: r.protocol, topic: r.topic, callback: r.callback, callbackHost: r.callback_host, secret: r.secret, expiresAt: r.expires_at, createdAt: r.created_at }
}

function rowToPushSubscription(r: PushSubscriptionsTable): PushSubscription {
  return { id: r.id, userId: r.user_id, mode: r.mode, endpoint: r.endpoint, topic: r.topic, callbackToken: r.callback_token, secret: r.secret, state: r.state, expiresAt: r.expires_at, createdAt: r.created_at }
}

type JoinedRow = PostsTable & { u_id: string; u_kind: 'local' | 'remote'; u_handle: string; u_display_name: string; u_feed_url: string | null; u_created_at: string; u_auth_user_id: string | null }

function joinedRowToEntry(r: JoinedRow): TimelineEntry {
  return hideResolvedReplyContext({
    ...rowToPost(r),
    author: { id: r.u_id, kind: r.u_kind, handle: r.u_handle, displayName: r.u_display_name, feedUrl: r.u_feed_url, createdAt: r.u_created_at, authUserId: r.u_auth_user_id },
  })
}

// A flat thread must never show a reply before the post it replies to. RSS's
// pubDate (RFC-822) truncates sub-second precision, so a reply that round-trips
// through a feed can carry a published_at that sorts EARLIER than its own,
// finer-grained parent even though it was written later — a plain ORDER BY
// published_at inverts that pair. Walk the resolved reply graph (inReplyToPostId)
// depth-first instead: entries arrive pre-sorted by (published_at, id) from the
// query below, so that ordering still governs SIBLINGS, but a child can never
// sort before its parent regardless of clock/precision skew.
function orderThread(entries: TimelineEntry[], rootId: string): TimelineEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const childrenOf = new Map<string, TimelineEntry[]>()
  for (const e of entries) {
    // cycle-breaker: the root is never a child, so any adoption-formed
    // mutual-reply cycle breaks here — do not remove.
    // ponytail: walk recursion depth = conversation depth (Node stack
    // ~10k); iterative stack if a pathological chain ever matters.
    if (e.id === rootId) continue
    const parentId = e.inReplyToPostId && byId.has(e.inReplyToPostId) ? e.inReplyToPostId : rootId
    const siblings = childrenOf.get(parentId)
    if (siblings) siblings.push(e)
    else childrenOf.set(parentId, [e])
  }
  const out: TimelineEntry[] = []
  const walk = (id: string) => {
    const node = byId.get(id)
    if (node) out.push(node)
    for (const child of childrenOf.get(id) ?? []) walk(child.id)
  }
  walk(rootId)
  return out
}

export class SqliteRepository implements Repository {
  private db: Kysely<DB>
  private sqlite: InstanceType<typeof Database>

  // Plain assignment instead of a parameter property: Node's native type
  // stripping (which replaced tsx) can't erase parameter properties.
  constructor(db: Kysely<DB>, sqlite: InstanceType<typeof Database>) {
    this.db = db
    this.sqlite = sqlite
  }

  get raw(): Database.Database {
    return this.sqlite
  }

  private async insertUser(kind: 'local' | 'remote', handle: string, displayName: string, feedUrl: string | null, authUserId: string | null, feedType: FeedType | null): Promise<User> {
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
  async updateUserProfile(userId: string, patch: { handle?: string; displayName?: string }) {
    try {
      const r = await this.db
        .updateTable('users')
        .set({ ...(patch.handle !== undefined ? { handle: patch.handle } : {}), ...(patch.displayName !== undefined ? { display_name: patch.displayName } : {}) })
        .where('id', '=', userId)
        .returningAll()
        .executeTakeFirstOrThrow()
      return rowToUser(r)
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HandleTakenError('handle already taken')
      throw err
    }
  }
  async listRemoteUsers() {
    const rs = await this.db.selectFrom('users').selectAll().where('kind', '=', 'remote').execute()
    return rs.map(rowToUser)
  }
  // Textcasting peers: remote feeds whose ingested items have carried
  // source:markdown — the marker every Textcasting item bears (inReplyTo/
  // comments/account only appear situationally, so requiring them would
  // exclude quiet peers).
  async listTextcastingPeers() {
    const rs = await this.db
      .selectFrom('users')
      .selectAll()
      .where('kind', '=', 'remote')
      .where(({ exists, selectFrom }) =>
        exists(selectFrom('posts').select('posts.id').whereRef('posts.author_id', '=', 'users.id').where('posts.content_markdown', 'is not', null)))
      .orderBy('handle', 'asc')
      .execute()
    return rs.map(rowToUser)
  }
  async getRemoteUserByFeedUrl(url: string) {
    const r = await this.db.selectFrom('users').selectAll().where('kind', '=', 'remote').where('feed_url', '=', url).executeTakeFirst()
    return r ? rowToUser(r) : undefined
  }
  async countRemoteSubscriptions(userId: string) {
    const r = await this.db
      .selectFrom('follows')
      .innerJoin('users', 'users.id', 'follows.followed_id')
      .select(({ fn }) => fn.countAll().as('n'))
      .where('follows.follower_id', '=', userId)
      .where('users.feed_type', 'in', ['person', 'webfeed']) // excludes vestigial instance follows
      .executeTakeFirst()
    return Number(r?.n ?? 0)
  }
  async countFollowers(userId: string) {
    const r = await this.db.selectFrom('follows').select(({ fn }) => fn.countAll().as('n')).where('followed_id', '=', userId).executeTakeFirst()
    return Number(r?.n ?? 0)
  }
  async getSetting(key: string) {
    const r = await this.db.selectFrom('instance_settings').select('value').where('key', '=', key).executeTakeFirst()
    return r?.value
  }
  async setSetting(key: string, value: string) {
    await this.db.insertInto('instance_settings').values({ key, value }).onConflict((oc) => oc.column('key').doUpdateSet({ value })).execute()
  }
  async addFollow(followerId: string, followedId: string) {
    await this.db
      .insertInto('follows')
      .values({ follower_id: followerId, followed_id: followedId, created_at: new Date().toISOString() })
      // follows has only the PK constraint, so bare doNothing() targets it.
      .onConflict((oc) => oc.doNothing())
      .execute()
  }
  async removeFollow(followerId: string, followedId: string) {
    await this.db.deleteFrom('follows').where('follower_id', '=', followerId).where('followed_id', '=', followedId).execute()
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
  async insertPost(p: Post) {
    const [result] = await this.db
      .insertInto('posts')
      .values({ id: p.id, author_id: p.authorId, source: p.source, guid: p.guid, title: p.title, content: p.content, url: p.url, published_at: p.publishedAt, created_at: p.createdAt, in_reply_to: p.inReplyTo ?? null, in_reply_to_post_id: p.inReplyToPostId ?? null, thread_root_id: p.threadRootId ?? null, source_name: p.sourceName ?? null, source_feed_url: p.sourceFeedUrl ?? null, content_markdown: p.contentMarkdown ?? null, reply_context_author: p.replyContextAuthor ?? null, reply_context_snippet: p.replyContextSnippet ?? null })
      // Relies on posts_author_guid_uq being the ONLY unique constraint on posts;
      // a future second unique constraint would need an explicit conflict target.
      .onConflict((oc) => oc.doNothing())
      .execute()
    return (result?.numInsertedOrUpdatedRows ?? 0n) > 0n
  }
  async hasPostsByAuthor(authorId: string) {
    const r = await this.db.selectFrom('posts').select('id').where('author_id', '=', authorId).executeTakeFirst()
    return r !== undefined
  }
  async getTimeline(limit: number, before?: TimelineCursor, filter?: { followedBy?: string; authorId?: string }): Promise<TimelineEntry[]> {
    let q = this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id'])
      .orderBy('posts.published_at', 'desc')
      .orderBy('posts.id', 'desc')
      .limit(limit)
    if (before) {
      q = q.where((eb) => eb(eb.refTuple('posts.published_at', 'posts.id'), '<', eb.tuple(before.publishedAt, before.id)))
    }
    if (filter?.followedBy) {
      const followerId = filter.followedBy
      q = q.where('posts.author_id', 'in', (eb) => eb.selectFrom('follows').select('followed_id').where('follower_id', '=', followerId))
    }
    if (filter?.authorId) {
      q = q.where('posts.author_id', '=', filter.authorId)
    }
    const rows = await q.execute()
    return rows.map(joinedRowToEntry)
  }

  async getTimelineAfter(sinceCreatedAt: string, limit: number): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id'])
      .where('posts.created_at', '>=', sinceCreatedAt)
      .orderBy('posts.created_at', 'asc')
      .orderBy('posts.id', 'asc')
      .limit(limit)
      .execute()
    return rows.map(joinedRowToEntry)
  }

  async getPost(id: string): Promise<Post | undefined> {
    const r = await this.db.selectFrom('posts').selectAll().where('id', '=', id).executeTakeFirst()
    return r ? rowToPost(r) : undefined
  }

  async deletePost(id: string): Promise<void> {
    // Clear the post's revisions first — post_revisions.post_id is a plain RESTRICT
    // FK to posts(id) (foreign_keys=ON), so deleting an edited post is refused otherwise.
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('post_revisions').where('post_id', '=', id).execute()
      await trx.deleteFrom('posts').where('id', '=', id).execute()
    })
  }

  async getPostsByAuthor(authorId: string, limit: number): Promise<Post[]> {
    const rows = await this.db.selectFrom('posts').selectAll().where('author_id', '=', authorId).orderBy('published_at', 'desc').orderBy('id', 'desc').limit(limit).execute()
    return rows.map(rowToPost)
  }

  async getRecentLocalPosts(limit: number): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id'])
      .where('users.kind', '=', 'local')
      .orderBy('posts.published_at', 'desc')
      .orderBy('posts.id', 'desc')
      .limit(limit)
      .execute()
    return rows.map(joinedRowToEntry)
  }

  async findPostByRef(ref: string): Promise<Post | undefined> {
    // Pinned rule (spec H2 + Hole A): each arm matches ONLY when exactly one
    // row holds the ref — ambiguity resolves to nothing, never to an arbitrary row.
    const byUrl = await this.db.selectFrom('posts').selectAll().where('url', '=', ref).limit(2).execute()
    if (byUrl.length === 1) return rowToPost(byUrl[0])
    if (byUrl.length > 1) return undefined
    const byGuid = await this.db.selectFrom('posts').selectAll().where('guid', '=', ref).limit(2).execute()
    return byGuid.length === 1 ? rowToPost(byGuid[0]) : undefined
  }

  async getThread(rootId: string): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id'])
      .where((eb) => eb.or([eb('posts.id', '=', rootId), eb('posts.thread_root_id', '=', rootId)]))
      .orderBy('posts.published_at', 'asc')
      .orderBy('posts.id', 'asc')
      .execute()
    return orderThread(rows.map(joinedRowToEntry), rootId)
  }

  async adoptOrphans(parent: Post) {
    const newRoot = parent.threadRootId ?? parent.id
    for (const ref of [parent.url, parent.guid]) {
      if (!ref) continue
      // Exactly-one guard (both arms): adopt via this ref only when the parent is its sole holder.
      const urlHolders = await this.db.selectFrom('posts').select('id').where('url', '=', ref).limit(2).execute()
      const guidHolders = await this.db.selectFrom('posts').select('id').where('guid', '=', ref).limit(2).execute()
      const holders = new Set([...urlHolders, ...guidHolders].map((r) => r.id))
      if (holders.size > 1) continue
      const orphans = await this.db
        .selectFrom('posts').select('id')
        .where('in_reply_to', '=', ref)
        .where('in_reply_to_post_id', 'is', null)
        .where('id', '!=', parent.id)
        .execute()
      if (orphans.length === 0) continue
      // ponytail: not transactional — a crash mid-loop can leave a partially
      // re-rooted subtree until the thread is next touched; wrap in a
      // transaction if that residual ever bites.
      await this.db.updateTable('posts')
        .set({ in_reply_to_post_id: parent.id, thread_root_id: newRoot })
        .where('id', 'in', orphans.map((o) => o.id))
        .execute()
      // One re-root UPDATE per adopted orphan — a loop, not a single second UPDATE.
      // Each sweep catches the orphan's WHOLE subtree because thread_root_id always
      // points at the top root, never an intermediate node.
      for (const o of orphans) {
        await this.db.updateTable('posts').set({ thread_root_id: newRoot }).where('thread_root_id', '=', o.id).execute()
      }
    }
  }

  async backfillItemExtras(authorId: string, guid: string, sourceName: string | null, sourceFeedUrl: string | null, contentMarkdown: string | null, url: string | null) {
    // Pre-existing rows never re-insert (dedup), so extras fill in place —
    // PER COLUMN (COR-1): a post attributed at migration 6 must still gain
    // markdown at migration 7 and its permalink-guid url later. COALESCE
    // keeps the first-seen value (no flapping).
    await this.db.updateTable('posts')
      .set((eb) => ({
        source_name: eb.fn.coalesce('source_name', eb.val(sourceName)),
        source_feed_url: eb.fn.coalesce('source_feed_url', eb.val(sourceFeedUrl)),
        content_markdown: eb.fn.coalesce('content_markdown', eb.val(contentMarkdown)),
        url: eb.fn.coalesce('url', eb.val(url)),
      }))
      .where('author_id', '=', authorId)
      .where('guid', '=', guid)
      .execute()
  }
  async getEditableByGuid(authorId: string, guid: string) {
    const r = await this.db.selectFrom('posts').select(['id', 'title', 'content', 'content_markdown'])
      .where('author_id', '=', authorId).where('guid', '=', guid).executeTakeFirst()
    return r ? { id: r.id, title: r.title, content: r.content, contentMarkdown: r.content_markdown } : undefined
  }

  async recordEdit(postId: string, next: { title: string | null; content: string; contentMarkdown: string | null; editedAt: string }) {
    // Atomic: snapshot the CURRENT stored version, then overwrite. seen_at on the
    // snapshot = the moment it was superseded (this edit's time).
    await this.db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('posts').select(['title', 'content', 'content_markdown'])
        .where('id', '=', postId).executeTakeFirst()
      if (!cur) return
      await trx.insertInto('post_revisions').values({
        id: randomUUID(), post_id: postId, title: cur.title, content: cur.content,
        content_markdown: cur.content_markdown, seen_at: next.editedAt,
      }).execute()
      await trx.updateTable('posts').set({
        title: next.title, content: next.content, content_markdown: next.contentMarkdown, edited_at: next.editedAt,
      }).where('id', '=', postId).execute()
    })
  }

  async getRevisions(postId: string) {
    const rows = await this.db.selectFrom('post_revisions').selectAll()
      .where('post_id', '=', postId).orderBy('seen_at', 'asc').orderBy('id', 'asc').execute()
    return rows.map((r) => ({ id: r.id, postId: r.post_id, title: r.title, content: r.content, contentMarkdown: r.content_markdown, seenAt: r.seen_at }))
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
    return new Map(rows.map((r) => [r.in_reply_to_post_id as string, Number(r.n)]))
  }

  async listRepliesByPostId(id: string): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id'])
      .where('in_reply_to_post_id', '=', id)
      .orderBy('posts.published_at', 'asc')
      .orderBy('posts.id', 'asc')
      .execute()
    return rows.map(joinedRowToEntry)
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

  async upsertPushSubscription(s: PushSubscription) {
    await this.db
      .insertInto('push_subscriptions')
      .values({ id: s.id, user_id: s.userId, mode: s.mode, endpoint: s.endpoint, topic: s.topic, callback_token: s.callbackToken, secret: s.secret, state: s.state, expires_at: s.expiresAt, created_at: s.createdAt })
      // H4: token and secret are IDENTITY across renewals — never updated on conflict.
      .onConflict((oc) => oc.columns(['user_id', 'mode']).doUpdateSet({ endpoint: s.endpoint, topic: s.topic, state: s.state, expires_at: s.expiresAt }))
      .execute()
  }
  async findPushSubscription(filter: { token?: string; userId?: string; mode?: PushProtocol; topic?: string }, opts?: { unexpiredAt?: string; state?: 'pending' | 'active' }): Promise<PushSubscription | undefined> {
    let q = this.db.selectFrom('push_subscriptions').selectAll()
    if (filter.token !== undefined) q = q.where('callback_token', '=', filter.token)
    if (filter.userId !== undefined) q = q.where('user_id', '=', filter.userId)
    if (filter.mode !== undefined) q = q.where('mode', '=', filter.mode)
    if (filter.topic !== undefined) q = q.where('topic', '=', filter.topic)
    if (opts?.unexpiredAt !== undefined) q = q.where('expires_at', '>', opts.unexpiredAt)
    if (opts?.state !== undefined) q = q.where('state', '=', opts.state)
    const r = await q.executeTakeFirst()
    return r ? rowToPushSubscription(r) : undefined
  }
  async listRenewablePushSubscriptions(before: string): Promise<PushSubscription[]> {
    const rows = await this.db.selectFrom('push_subscriptions').selectAll().where('state', '=', 'active').where('expires_at', '<', before).execute()
    return rows.map(rowToPushSubscription)
  }
  async deletePushSubscription(id: string) {
    await this.db.deleteFrom('push_subscriptions').where('id', '=', id).execute()
  }

  // Manual cascade for a user (no DB-level ON DELETE CASCADE; FKs are plain
  // REFERENCES). Shared by sweepAnonymousUsers and DELETE /users. post_revisions
  // must go before posts — its post_id FK is RESTRICT and foreign_keys=ON.
  deleteUserCascade(id: string): void {
    const raw = this.raw
    raw.transaction(() => {
      raw.prepare(`DELETE FROM follows WHERE follower_id = ? OR followed_id = ?`).run(id, id)
      raw.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(id)
      raw.prepare(`DELETE FROM post_revisions WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)`).run(id)
      raw.prepare(`DELETE FROM posts WHERE author_id = ?`).run(id)
      raw.prepare(`DELETE FROM users WHERE id = ?`).run(id)
    })()
  }

  deleteAuthRows(authUserId: string): void {
    const raw = this.raw
    raw.transaction(() => {
      raw.prepare(`DELETE FROM session WHERE userId = ?`).run(authUserId)
      raw.prepare(`DELETE FROM account WHERE userId = ?`).run(authUserId)
      raw.prepare(`DELETE FROM user WHERE id = ?`).run(authUserId)
    })()
  }

  instanceStats(): { registeredUsers: number; guests: number; remoteFeeds: number; posts: number } {
    return this.raw.prepare(
      `SELECT (SELECT COUNT(*) FROM user WHERE isAnonymous = 0 OR isAnonymous IS NULL) AS registeredUsers,
              (SELECT COUNT(*) FROM user WHERE isAnonymous = 1) AS guests,
              (SELECT COUNT(*) FROM users WHERE kind = 'remote') AS remoteFeeds,
              (SELECT COUNT(*) FROM posts) AS posts`,
    ).get() as { registeredUsers: number; guests: number; remoteFeeds: number; posts: number }
  }

  listUsers(): Array<{ handle: string; displayName: string; kind: 'local' | 'remote'; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }> {
    const rows = this.raw.prepare(
      `SELECT u.handle AS handle, u.display_name AS displayName, u.kind AS kind,
              u.created_at AS createdAt, u.feed_url AS feedUrl, au.emailVerified AS emailVerified
       FROM users u LEFT JOIN user au ON au.id = u.auth_user_id
       WHERE u.kind = 'remote'
          OR (u.kind = 'local' AND (au.isAnonymous = 0 OR au.isAnonymous IS NULL))
       ORDER BY u.created_at DESC`,
    ).all() as Array<{ handle: string; displayName: string; kind: 'local' | 'remote'; createdAt: string; feedUrl: string | null; emailVerified: number | null }>
    return rows.map((r) => ({ ...r, emailVerified: r.emailVerified === null ? null : r.emailVerified === 1 }))
  }

  close(): void {
    this.raw.pragma('wal_checkpoint(TRUNCATE)')
    this.raw.close()
  }

  // Idle = latest session update, else auth-user createdAt. Anon guests are
  // few; candidate selection in JS dodges better-auth's date-storage format
  // (new Date() parses ISO strings and epoch numbers alike).
  sweepAnonymousUsers(ttlDays: number): { swept: number } {
    const raw = this.raw
    const cutoff = Date.now() - ttlDays * 86400_000
    const anons = raw.prepare(`SELECT id, createdAt FROM user WHERE isAnonymous = 1`).all() as { id: string; createdAt: string | number }[]
    const latest = new Map(
      (raw.prepare(`SELECT userId, MAX(updatedAt) AS ts FROM session GROUP BY userId`).all() as { userId: string; ts: string | number }[]).map((r) => [r.userId, r.ts]),
    )
    const idle = anons.filter((a) => new Date(latest.get(a.id) ?? a.createdAt).getTime() < cutoff)
    const orphans = raw
      .prepare(`SELECT u.id FROM users u LEFT JOIN user au ON au.id = u.auth_user_id WHERE u.auth_user_id IS NOT NULL AND au.id IS NULL AND u.kind = 'local'`)
      .all() as { id: string }[]

    let swept = 0
    raw.transaction(() => {
      for (const a of idle) {
        const core = raw.prepare(`SELECT id FROM users WHERE auth_user_id = ?`).get(a.id) as { id: string } | undefined
        if (core) this.deleteUserCascade(core.id)
        this.deleteAuthRows(a.id)
        swept++
      }
      for (const o of orphans) {
        this.deleteUserCascade(o.id)
        swept++
      }
    })()
    return { swept }
  }
}

// index N-1 holds the statements that bring the schema to version N.
const MIGRATIONS: string[][] = [
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
}

export async function createSqliteRepository(filename: string): Promise<SqliteRepository> {
  const sqlite = new Database(filename)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  migrate(sqlite)
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) })
  return new SqliteRepository(db, sqlite)
}
