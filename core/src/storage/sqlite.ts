import { Kysely, SqliteDialect } from 'kysely'
import Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import type { Repository } from '../domain/repository.ts'
import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry, Subscription, PushProtocol, FeedType } from '../domain/types.ts'
import { HandleTakenError } from '../domain/types.ts'
import { hideResolvedReplyContext } from '../domain/types.ts'
import type { RemoteSource, SourceSubscription, SourceAuditEvent, Page, SourceSummary, SourceDetail, PushSummary, FederationStatus, OwnerSourceFollow, PublicLocalFollow, PublicSourceFollow, PublicFollowingEntry, OwnerFollowingView, CommandEnvelope, AttributionMode, AuditCategory, FederationRelationship, SourceTransitionResult, SourceSubscriptionState, SourceGovernance, SourceOperation } from '../domain/types.ts'
import type { SourceRepository, Cursor, SubscribeResult, ImportSourcesResult, UnsubscribeResult, EstablishFederationResult, SourceTransitionAction, SourceAxes, ReapCommandResult } from '../domain/source-repository.ts'
import { encodeCursor, clampLimit, checkCommand, storeCommand, reapSourceIfOrphaned, reapSource as reapSourceFn, SOURCE_TRANSITIONS, CATEGORY_OPTIONAL_ACTIONS } from '../domain/source-repository.ts'
import { LOGICAL_V2_SCHEMA, LOGICAL_V3_SCHEMA, LOGICAL_V4_SCHEMA, LOGICAL_PERF_INDEXES, LOGICAL_PERF_INDEXES_2, AGGREGATE_PUBLISHER_IDENTITY_FIX, assertHandleUnreserved } from '../logical/schema.ts'
import { appendJournal } from '../logical/journal.ts'
import { scheduleFanout } from '../logical/fanout.ts'
import type { LogicalStore } from '../logical/store.ts'
import { memberRows, memberRowsPage, memberCounts, healMembers } from '../logical/membership.ts'

// --- V2 logical journal integration (Task 9, spec §3.7) ----------------------
// These source-command methods run whenever the source-control plane is wired
// (server.ts builds `sources` unconditionally), so the journal effects below
// always fire in production. Governance/federation/
// attribution-mode changes advance the SOURCE's policy_generation AND append ONE
// ordinary in-generation reset — this is appendJournal, NOT reconstructJournal:
// the journal's own reset_generation gates SSE cursor validity and must not move
// for a per-source policy change. Active subscription create/remove and local
// follow append a Personal-membership reset WITHOUT advancing generation. Exactly
// ONE reset per command; NO source-wide item fan-out (reads recompute from current
// policy). V3 adds a durable fan-out (policy_fanout_v2) that converges the
// materialized hints: advancePolicyGeneration + scheduleFanout co-commit here so a
// fault before commit rolls the fan-out row back with the transition (spec §4.1).
// Replay/no-op/conflict append nothing.
function journalPolicyReset(raw: Database.Database, now: string): void {
  appendJournal(raw, { kind: 'reset', changeMask: 'barrier' }, now)
}
// Advances the source's policy generation and enqueues its fan-out row in the SAME
// transaction. Returns the new generation. Every generation-advancing transition
// MUST route through here so the fan-out row always tracks the current generation.
function advancePolicyGeneration(raw: Database.Database, sourceId: string, now: string): number {
  const r = raw.prepare(`UPDATE remote_sources_v2 SET policy_generation = policy_generation + 1 WHERE id = ? RETURNING policy_generation`).get(sourceId) as { policy_generation: number }
  scheduleFanout(raw, { sourceId, generation: r.policy_generation, now })
  return r.policy_generation
}

// The instance-governed-members cascade (spec 2026-07-25 rev 3): re-run the
// instance's ACTION through SOURCE_TRANSITIONS against each member's own axes
// (action, not value — value→cell has no legal unblock mapping). Members have
// no federation axis. Ordinary actions skip overridden members; block/unblock
// hit ALL (absolute both directions). Returns members MOVED.
function cascadeInstanceAction(raw: Database.Database, instance: { id: string; canonical_url: string }, action: SourceTransitionAction | 'establish', now: string): number {
  const effective = action === 'establish' || action === 'approve' ? 'allow' : action
  if (effective !== 'allow' && effective !== 'quarantine' && effective !== 'block' && effective !== 'unblock') return 0
  const absolute = effective === 'block' || effective === 'unblock'
  let moved = 0
  for (const m of memberRows(raw, instance)) {
    if (!absolute && m.overridden === 1) continue
    const patch = SOURCE_TRANSITIONS[effective]({ operation: m.operation as SourceOperation, governance: m.governance as SourceGovernance, federation: 'none' })
    if (!patch || patch.governance === undefined || patch.governance === m.governance) continue
    raw.prepare(`UPDATE remote_sources_v2 SET governance = ? WHERE id = ?`).run(patch.governance, m.id)
    if (patch.governance === 'allowed') {
      const row = raw.prepare(`SELECT * FROM remote_sources_v2 WHERE id = ?`).get(m.id) as RemoteSourceV2Row
      activatePendingSubscriptions(raw, row)
    }
    advancePolicyGeneration(raw, m.id, now) // members do NOT append their own reset
    moved++
  }
  return moved
}

interface UsersTable { id: string; kind: 'local' | 'remote'; handle: string; display_name: string; feed_url: string | null; created_at: string; auth_user_id: string | null; feed_type: FeedType | null }
interface PostsTable { id: string; author_id: string; source: 'local' | 'remote'; guid: string; title: string | null; content: string; url: string | null; published_at: string; created_at: string; in_reply_to: string | null; in_reply_to_post_id: string | null; thread_root_id: string | null; source_name: string | null; source_feed_url: string | null; content_markdown: string | null; edited_at: string | null; reply_context_author: string | null; reply_context_snippet: string | null }
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

// v2 source-control plane row shapes — read-only in this task. Rows carry the
// WIDER SQL CHECK vocabulary (rev 5, V4 §10 pin); mapping to the narrower V1
// DTO types below is deliberate, not a bug.
export interface RemoteSourceV2Row {
  id: string; canonical_url: string
  attribution_mode: 'single_publisher' | 'aggregate'
  operation: 'enabled' | 'paused'
  governance: 'allowed' | 'quarantined' | 'blocked'
  provenance: 'user_subscription' | 'opml' | 'admin_federation' | 'origin_verification' | 'migration'
  provenance_note: string | null
  admin_retained: 0 | 1
  overridden: 0 | 1
  created_at: string
}
interface SourceSubscriptionV2Row { id: string; owner_id: string; source_id: string; state: 'active' | 'pending' | 'pending_review'; created_at: string }
interface SourceAuditV2Row {
  id: string; source_id: string; command_id: string; actor_id: string | null
  actor_kind: 'administrator' | 'operator_token' | 'system'
  action: string
  category: 'spam' | 'abuse' | 'illegal_content' | 'compromised_source' | 'migration_review' | 'operator_policy' | 'false_positive' | 'remediated' | 'other' | null
  note: string | null; result_json: string; created_at: string
}

function rowToRemoteSourceV2(r: RemoteSourceV2Row): RemoteSource {
  return {
    id: r.id, canonicalUrl: r.canonical_url, attributionMode: r.attribution_mode,
    operation: r.operation, governance: r.governance, provenance: r.provenance,
    provenanceNote: r.provenance_note, adminRetained: r.admin_retained === 1, overridden: r.overridden === 0 ? false : true, createdAt: r.created_at,
  }
}

function rowToSourceSubscriptionV2(r: SourceSubscriptionV2Row): SourceSubscription {
  return { id: r.id, ownerId: r.owner_id, sourceId: r.source_id, state: r.state, createdAt: r.created_at }
}

// PublicSourceFollow.displayName is deterministic presentation data, not
// stored identity (Task 5 brief / design §4): the hostname of the canonical
// URL, falling back to the complete URL if it doesn't parse.
function sourceDisplayName(canonicalUrl: string): string {
  try {
    return new URL(canonicalUrl).hostname
  } catch {
    return canonicalUrl
  }
}

// The all-null projection for a source with no lease. The field is always present
// — an absent lease is nulls, never a missing key.
const NO_PUSH: PushSummary = { mode: null, state: null, endpointFingerprint: null }

interface PushRowV2Read { mode: PushProtocol; state: 'pending' | 'active'; endpoint: string; expires_at: string }

// actor_kind/category are cast to the TS unions the row is known to carry.
// Both are now the full SQL vocabulary (V4 re-added 'operator_token' and
// 'migration_review'), so the cast is a pure row-typing no-op.
function rowToSourceAuditV2(r: SourceAuditV2Row): SourceAuditEvent {
  return {
    id: r.id, sourceId: r.source_id, commandId: r.command_id, actorId: r.actor_id,
    actorKind: r.actor_kind as SourceAuditEvent['actorKind'],
    action: r.action, category: r.category as SourceAuditEvent['category'],
    note: r.note, resultJson: r.result_json, createdAt: r.created_at,
  }
}

type Db = InstanceType<typeof Database>

// Every audited mutation (Task 6) writes exactly one of these, inside the same
// transaction as its effect. result_json is the outcome of THIS command, never
// the envelope that carries the audit event itself.
// `command` is structurally the two fields actually read, not the full
// CommandEnvelope: the V4 legacy conversion (migration/convert.ts) audits under
// a synthetic command id with NO actor — every existing CommandEnvelope caller
// still satisfies this shape unchanged.
export function insertAudit(tx: Db, a: {
  sourceId: string; command: { commandId: string; actorId: string | null }; actorKind: SourceAuditEvent['actorKind']
  action: string; category: AuditCategory | null; note: string | null; result: unknown; now: string
}): SourceAuditEvent {
  const row: SourceAuditV2Row = {
    id: randomUUID(), source_id: a.sourceId, command_id: a.command.commandId, actor_id: a.command.actorId,
    actor_kind: a.actorKind, action: a.action, category: a.category, note: a.note,
    result_json: JSON.stringify(a.result), created_at: a.now,
  }
  tx.prepare(
    `INSERT INTO source_audit_v2 (id, source_id, command_id, actor_id, actor_kind, action, category, note, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.source_id, row.command_id, row.actor_id, row.actor_kind, row.action, row.category, row.note, row.result_json, row.created_at)
  return rowToSourceAuditV2(row)
}

// The permanent legacy-handle reservation guard (V4 §3.5) is defined ONCE in
// logical/schema.ts, next to the table it protects, because the v2 logical store
// must call the same function on its own rename path. Here it covers insertUser
// (which backs createLocalUser/createRemoteUser, and through them service
// ensureLocalUser and auth's guest allocation) and the v1 rename.

// Ordinary pending subscriptions become active only once the source is BOTH
// allowed and single_publisher. pending_review never activates automatically
// under any transition, and already-active subscriptions are left alone.
function activatePendingSubscriptions(tx: Db, source: RemoteSourceV2Row): void {
  if (source.governance !== 'allowed' || source.attribution_mode !== 'single_publisher') return
  tx.prepare(`UPDATE source_subscriptions_v2 SET state = 'active' WHERE source_id = ? AND state = 'pending'`).run(source.id)
}

type JoinedRow = PostsTable & { u_id: string; u_kind: 'local' | 'remote'; u_handle: string; u_display_name: string; u_feed_url: string | null; u_created_at: string; u_auth_user_id: string | null; u_feed_type: FeedType | null }

function joinedRowToEntry(r: JoinedRow): TimelineEntry {
  return hideResolvedReplyContext({
    ...rowToPost(r),
    author: { id: r.u_id, kind: r.u_kind, handle: r.u_handle, displayName: r.u_display_name, feedUrl: r.u_feed_url, createdAt: r.u_created_at, authUserId: r.u_auth_user_id, feedType: r.u_feed_type },
  })
}

export class SqliteRepository implements Repository, SourceRepository {
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

  async getPostsByAuthor(authorId: string, limit: number): Promise<Post[]> {
    const rows = await this.db.selectFrom('posts').selectAll().where('author_id', '=', authorId).orderBy('published_at', 'desc').orderBy('id', 'desc').limit(limit).execute()
    return rows.map(rowToPost)
  }

  async getRecentLocalPosts(limit: number): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id', 'users.feed_type as u_feed_type'])
      .where('users.kind', '=', 'local')
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

  listUsers(cursor: Cursor | undefined, limit: number): Page<{ id: string; handle: string; displayName: string; kind: 'local' | 'remote'; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }> {
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
    const { page, nextCursor } = this.splitPage(rows, lim)
    return {
      items: page.map((r) => ({
        id: r.id,
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

  // --- v2 source-control plane administrative reads (served by the
  // /admin/sources routes) — nothing here touches legacy tables; these methods
  // only ever read the five v2 tables.

  // Shared tail of every v2 cursor-paginated read: rows arrived limit+1 deep;
  // split off the displayed page and, if the extra row is present, encode a
  // nextCursor off the last displayed row's (created_at, id).
  private splitPage<R extends { created_at: string; id: string }>(rows: R[], lim: number): { page: R[]; nextCursor: string | null } {
    const page = rows.slice(0, lim)
    const last = page[page.length - 1]
    return { page, nextCursor: rows.length > lim && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null }
  }

  private federationStatusFor(sourceId: string): 'none' | FederationStatus {
    const row = this.raw.prepare(`SELECT status FROM federation_relationships_v2 WHERE source_id = ?`).get(sourceId) as { status: FederationStatus } | undefined
    return row ? row.status : 'none'
  }

  private subscriptionCountsFor(sourceId: string): { active: number; pending: number; pendingReview: number } {
    const rows = this.raw.prepare(
      `SELECT state, COUNT(*) AS n FROM source_subscriptions_v2 WHERE source_id = ? GROUP BY state`,
    ).all(sourceId) as { state: 'active' | 'pending' | 'pending_review'; n: number }[]
    const counts = { active: 0, pending: 0, pendingReview: 0 }
    for (const r of rows) {
      if (r.state === 'active') counts.active = r.n
      else if (r.state === 'pending') counts.pending = r.n
      else counts.pendingReview = r.n
    }
    return counts
  }

  async getSource(id: string): Promise<RemoteSource | undefined> {
    const row = this.raw.prepare(`SELECT * FROM remote_sources_v2 WHERE id = ?`).get(id) as RemoteSourceV2Row | undefined
    return row ? rowToRemoteSourceV2(row) : undefined
  }

  async listSourceSummaries(cursor: Cursor | undefined, limit: number, filter?: 'governance' | 'orphan', q?: string): Promise<Page<SourceSummary>> {
    const lim = clampLimit(limit)
    // 'governance' narrows to the administratively load-bearing rows — any
    // federation relationship (approved OR pending) or a quarantined source —
    // so the admin page's federation/review sections can be built independent
    // of where bulk subscriptions push them in the created_at pagination.
    // 'orphan' mirrors reapSourceIfOrphaned's own predicate verbatim: allowed,
    // no federation relationship, zero subscriptions of any state (including
    // pending_review — a source under review is never an orphan).
    const where = filter === 'governance'
      ? `(EXISTS(SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = remote_sources_v2.id) OR governance = 'quarantined')`
      : filter === 'orphan'
        ? `(governance = 'allowed'
            AND NOT EXISTS(SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = remote_sources_v2.id)
            AND NOT EXISTS(SELECT 1 FROM source_subscriptions_v2 s WHERE s.source_id = remote_sources_v2.id))`
        : '1=1'
    const qClause = q ? ` AND canonical_url LIKE '%'||?||'%'` : ''
    const qParams = q ? [q] : []
    const rows = (cursor
      ? this.raw.prepare(
          `SELECT * FROM remote_sources_v2 WHERE ${where}${qClause} AND ((created_at < ?) OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(...qParams, cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
      : this.raw.prepare(`SELECT * FROM remote_sources_v2 WHERE ${where}${qClause} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...qParams, lim + 1)
    ) as RemoteSourceV2Row[]
    const { page, nextCursor } = this.splitPage(rows, lim)
    const items: SourceSummary[] = page.map((r) => {
      const source = rowToRemoteSourceV2(r)
      const isOrphan = filter === 'orphan'
      return {
        source,
        federationStatus: this.federationStatusFor(source.id),
        subscriptionCounts: this.subscriptionCountsFor(source.id),
        push: this.pushFor(source.id).push,
        retention: isOrphan ? this.retentionFor(source.id) : null,
        addedBy: this.addedByFor(source.id),
      }
    })
    return { items, nextCursor }
  }

  // The v2 "Connected instances" read: approved federation instances only —
  // legacy markdown-webfeed authorship (the retired listTextcastingPeers)
  // neither includes nor excludes correctly post-cutover. See app.ts's /peers.
  async listApprovedFederationSources(): Promise<{ canonicalUrl: string }[]> {
    const rows = this.raw.prepare(
      `SELECT canonical_url FROM remote_sources_v2 s
       WHERE s.governance = 'allowed'
         AND EXISTS (SELECT 1 FROM federation_relationships_v2 f
                     WHERE f.source_id = s.id AND f.status = 'approved')
       ORDER BY canonical_url`,
    ).all() as { canonical_url: string }[]
    return rows.map((r) => ({ canonicalUrl: r.canonical_url }))
  }

  async getSourceDetail(id: string): Promise<SourceDetail | undefined> {
    const row = this.raw.prepare(`SELECT * FROM remote_sources_v2 WHERE id = ?`).get(id) as RemoteSourceV2Row | undefined
    if (!row) return undefined
    // m2 (whole-branch review): a cascading transition can insert TWO audit
    // rows for the same source_id with the SAME created_at (the direct
    // action's own audit, plus its instance_cascade summary) — id DESC broke
    // that tie on a random UUID, so which one "latestAudit" picked varied
    // unpredictably run to run. rowid reflects real insertion order, so the
    // most-recently-inserted row deterministically wins. Single LIMIT-1 read,
    // no cursor involved — unlike listSourceAudit below, changing this
    // tie-break doesn't touch any keyset-pagination invariant.
    const auditRow = this.raw.prepare(
      `SELECT * FROM source_audit_v2 WHERE source_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(id) as SourceAuditV2Row | undefined
    return {
      source: rowToRemoteSourceV2(row),
      federationStatus: this.federationStatusFor(id),
      subscriptionCounts: this.subscriptionCountsFor(id),
      latestAudit: auditRow ? rowToSourceAuditV2(auditRow) : null,
      retention: this.retentionFor(id),
      addedBy: this.addedByFor(id),
      ...this.pushFor(id),
    }
  }

  // The administrative push projection (V4 spec §1.5). A source holds at most one
  // row per mode, so the ONE lease the admin sees is chosen deterministically: a
  // live lease over a pending one, then websub over its rsscloud fallback. The
  // endpoint is NEVER shipped — only a stable non-secret digest of it — and the
  // callback token and secret are not read at all, so they cannot reach any body.
  // ponytail: one small indexed lookup per listed source (the page is clamped to
  // ≤100, via clampLimit); fold into the list query only if a page read ever shows up in a profile.
  private pushFor(sourceId: string): { push: PushSummary; pushExpiresAt: string | null } {
    const row = this.raw.prepare(
      `SELECT mode, state, endpoint, expires_at FROM push_subscriptions_v2 WHERE source_id = ?
       ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, CASE mode WHEN 'websub' THEN 0 ELSE 1 END LIMIT 1`,
    ).get(sourceId) as PushRowV2Read | undefined
    if (!row) return { push: NO_PUSH, pushExpiresAt: null }
    return {
      push: { mode: row.mode, state: row.state, endpointFingerprint: createHash('sha256').update(row.endpoint).digest('hex').slice(0, 16) },
      pushExpiresAt: row.expires_at,
    }
  }

  // A display-only retention-reason label for ANY source (getSourceDetail and
  // listSourceMembers call this unconditionally, not just for orphans) — first
  // match wins, in priority order: verified_origin > admin_retained >
  // audit_history > reapable. This checks only those 3 signals, NOT the full
  // reapSourceIfOrphaned guard chain (which also checks subscribers/governance/
  // federation first). Trap: 'reapable' means "nothing here is retaining it,"
  // NOT "safe to reap" — a source with active subscriptions still shows
  // 'reapable' when rendered via getSourceDetail/listSourceMembers, since
  // neither pre-filters to orphans the way listSourceSummaries's orphan
  // filter does.
  private retentionFor(sourceId: string): 'verified_origin' | 'audit_history' | 'admin_retained' | 'reapable' {
    if (this.raw.prepare(`SELECT 1 FROM publisher_claims_v2 WHERE source_id = ? AND evidence_level = 'verified_origin' LIMIT 1`).get(sourceId)) return 'verified_origin'
    const source = this.raw.prepare(`SELECT admin_retained FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { admin_retained: 0 | 1 } | undefined
    if (source?.admin_retained === 1) return 'admin_retained'
    if (this.raw.prepare(`SELECT 1 FROM source_audit_v2 WHERE source_id = ? LIMIT 1`).get(sourceId)) return 'audit_history'
    return 'reapable'
  }

  // ponytail: one small indexed lookup per listed source (the page is clamped
  // to ≤100, matching pushFor's own accepted shape); fold into the list query
  // only if a page read ever shows up in a profile.
  private addedByFor(sourceId: string): { handle: string; displayName: string }[] {
    const rows = this.raw.prepare(
      `SELECT u.handle AS handle, u.display_name AS displayName
       FROM source_subscriptions_v2 s JOIN users u ON u.id = s.owner_id
       WHERE s.source_id = ? ORDER BY s.created_at ASC LIMIT 3`,
    ).all(sourceId) as { handle: string; displayName: string }[]
    return rows
  }

  async listSourceSubscriptions(sourceId: string, cursor: Cursor | undefined, limit: number): Promise<Page<SourceSubscription>> {
    const lim = clampLimit(limit)
    const rows = (cursor
      ? this.raw.prepare(
          `SELECT * FROM source_subscriptions_v2 WHERE source_id = ? AND ((created_at < ?) OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(sourceId, cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
      : this.raw.prepare(
          `SELECT * FROM source_subscriptions_v2 WHERE source_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(sourceId, lim + 1)
    ) as SourceSubscriptionV2Row[]
    const { page, nextCursor } = this.splitPage(rows, lim)
    return { items: page.map(rowToSourceSubscriptionV2), nextCursor }
  }

  // m2 (whole-branch review): this listing's ORDER BY tie-break stays `id`,
  // NOT `rowid` like getSourceDetail's single-row read above — its keyset
  // pagination WHERE-seeks on `id` (cursor.id), so the ORDER BY and the seek
  // predicate must use the same column or a same-created_at row can be
  // skipped or repeated across a page boundary. A full listing showing two
  // equal-timestamp rows in either relative order loses no data (unlike
  // picking a single "latest"), so id's arbitrary-but-stable tie-break is
  // left alone here. ponytail: fold rowid into the cursor if this listing
  // ever needs a "most recent wins" reading too.
  async listSourceAudit(sourceId: string, cursor: Cursor | undefined, limit: number): Promise<Page<SourceAuditEvent>> {
    const lim = clampLimit(limit)
    const rows = (cursor
      ? this.raw.prepare(
          `SELECT * FROM source_audit_v2 WHERE source_id = ? AND ((created_at < ?) OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(sourceId, cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
      : this.raw.prepare(
          `SELECT * FROM source_audit_v2 WHERE source_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(sourceId, lim + 1)
    ) as SourceAuditV2Row[]
    const { page, nextCursor } = this.splitPage(rows, lim)
    return { items: page.map(rowToSourceAuditV2), nextCursor }
  }

  // Task 5 (instance-governed-members): the admin member list/count reads —
  // delegates the F2 approved-federation gate and the range query wholly to
  // membership.ts, then reuses this class's own per-row summary projection
  // (same shape listSourceSummaries/getSourceDetail already build).
  async listSourceMembers(sourceId: string, cursor: Cursor | undefined, limit: number): Promise<Page<SourceSummary>> {
    const instRow = this.raw.prepare(`SELECT id, canonical_url FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { id: string; canonical_url: string } | undefined
    if (!instRow) return { items: [], nextCursor: null }
    const { rows, nextCursor } = memberRowsPage(this.raw, instRow, cursor, limit)
    const items: SourceSummary[] = rows.map((r) => {
      const source = rowToRemoteSourceV2(r)
      return {
        source,
        federationStatus: this.federationStatusFor(source.id),
        subscriptionCounts: this.subscriptionCountsFor(source.id),
        push: this.pushFor(source.id).push,
        retention: this.retentionFor(source.id),
        addedBy: this.addedByFor(source.id),
      }
    })
    return { items, nextCursor }
  }

  async sourceMemberCounts(sourceId: string): Promise<{ members: number; overridden: number }> {
    const instRow = this.raw.prepare(`SELECT id, canonical_url FROM remote_sources_v2 WHERE id = ?`).get(sourceId) as { id: string; canonical_url: string } | undefined
    if (!instRow) return { members: 0, overridden: 0 }
    return memberCounts(this.raw, instRow)
  }

  // --- v2 source-control plane mutations (Task 3). Each method is a single
  // ledger-backed BEGIN IMMEDIATE
  // transaction: checkCommand, resolve, cap-check where applicable, write,
  // storeCommand, commit. No await inside the transaction() callback —
  // better-sqlite3's transactions are synchronous only (Task 2 report).
  // Every INSERT uses an explicit column list (frozen cross-vertical contract).

  async followLocalAccount(input: { command: CommandEnvelope; ownerId: string; targetId: string; now: string }): Promise<SubscribeResult> {
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<SubscribeResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' } as SubscribeResult

      const existing = raw.prepare(`SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?`).get(input.ownerId, input.targetId)
      const created = !existing
      if (created) {
        raw.prepare(`INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)`).run(input.ownerId, input.targetId, input.now)
      }
      const target = raw.prepare(`SELECT id, handle, display_name FROM users WHERE id = ?`).get(input.targetId) as { id: string; handle: string; display_name: string }
      const result: SubscribeResult = { kind: 'local', created, follow: { kind: 'local', id: target.id, handle: target.handle, displayName: target.display_name } }
      if (created) journalPolicyReset(raw, input.now) // new Personal-membership edge
      storeCommand(raw, input.command, result, input.now)
      return result
    }).immediate()
  }

  async resolveAndSubscribeSource(input: { command: CommandEnvelope; ownerId: string; canonicalUrl: string; cap: number; now: string }): Promise<SubscribeResult> {
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<SubscribeResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' } as SubscribeResult

      let source = raw.prepare(`SELECT * FROM remote_sources_v2 WHERE canonical_url = ?`).get(input.canonicalUrl) as RemoteSourceV2Row | undefined

      // Blocked (and, once tombstones land, tombstoned) sources return the
      // same generic result as a URL that never existed — design §4.
      if (source && source.governance === 'blocked') {
        const result: SubscribeResult = { kind: 'unavailable' }
        storeCommand(raw, input.command, result, input.now)
        return result
      }

      // Only a single_publisher source with no federation relationship
      // accepts a new user subscription — design §4 "User subscription boundary".
      if (source) {
        const federated = raw.prepare(`SELECT 1 FROM federation_relationships_v2 WHERE source_id = ?`).get(source.id)
        if (source.attribution_mode === 'aggregate' || federated) {
          const result: SubscribeResult = { kind: 'not_subscribable' }
          storeCommand(raw, input.command, result, input.now)
          return result
        }
      }

      const existingSub = source
        ? (raw.prepare(`SELECT * FROM source_subscriptions_v2 WHERE owner_id = ? AND source_id = ?`).get(input.ownerId, source.id) as SourceSubscriptionV2Row | undefined)
        : undefined

      let state: SourceSubscriptionState
      let created: boolean
      if (existingSub) {
        // Report the state that is STORED — re-subscribing writes nothing, so
        // claiming 'active' over a pending_review row would contradict
        // ownerFollowing. pending_review is terminal in V1; V2 owns its exit.
        state = existingSub.state
        created = false
      } else {
        // Cap gates every NEW subscription (and the source it may create) —
        // one check, inside this transaction, serializes concurrent final-slot
        // subscribers to exactly one success (design §4).
        const { n } = raw.prepare(`SELECT COUNT(*) AS n FROM source_subscriptions_v2 WHERE owner_id = ?`).get(input.ownerId) as { n: number }
        if (n >= input.cap) {
          const result: SubscribeResult = { kind: 'cap' }
          storeCommand(raw, input.command, result, input.now)
          return result
        }
        if (!source) {
          const id = randomUUID()
          raw.prepare(
            `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
             VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'user_subscription', NULL, 0, ?)`,
          ).run(id, input.canonicalUrl, input.now)
          source = { id, canonical_url: input.canonicalUrl, attribution_mode: 'single_publisher', operation: 'enabled', governance: 'allowed', provenance: 'user_subscription', provenance_note: null, admin_retained: 0, overridden: 1, created_at: input.now }
        }
        state = source.governance === 'quarantined' ? 'pending' : 'active'
        raw.prepare(
          `INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(randomUUID(), input.ownerId, source.id, state, input.now)
        created = true
      }
      // Invariant: reachable only with a resolved source (existingSub implies
      // it via the ternary above; the !source branch above always sets one).
      if (!source) throw new Error('source resolution invariant violated')

      const subscription: OwnerSourceFollow = {
        sourceId: source.id,
        url: source.canonical_url,
        attributionMode: source.attribution_mode,
        subscriptionState: state,
        // Same rule as ownerFollowing: only 'active' is available; pending and
        // pending_review are awaiting_review regardless of governance (rev 5).
        availability: state === 'active' ? 'available' : 'awaiting_review',
      }
      const result: SubscribeResult = { kind: 'source', created, subscription }
      // A newly created ACTIVE subscription changes Personal membership; a new
      // pending one is inactive-to-inactive and a re-subscribe writes nothing.
      if (created && state === 'active') journalPolicyReset(raw, input.now)
      storeCommand(raw, input.command, result, input.now)
      return result
    }).immediate()
  }

  // Task 4: the mixed local/remote OPML import command. One transaction —
  // ledger check, insert local follows, resolve/create sources, enforce the
  // cap, store, commit — as explicit sequential substeps. All partitioning
  // (parsing, local-feed resolution, normalization, SSRF checks) already
  // happened in source-service.ts; this method never awaits or touches the
  // network.
  async importSourceSubscriptions(input: {
    command: CommandEnvelope
    ownerId: string
    localTargetIds: string[]
    canonicalUrls: string[]
    unavailableCount: number
    cap: number
    now: string
  }): Promise<ImportSourcesResult | { kind: 'conflict' }> {
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<ImportSourcesResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' } as ImportSourcesResult | { kind: 'conflict' }

      // Substep: insert local follows (unlimited, mirrors legacy Case 2 — no cap applies).
      let localFollowed = 0
      for (const targetId of input.localTargetIds) {
        const existing = raw.prepare(`SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?`).get(input.ownerId, targetId)
        if (!existing) {
          raw.prepare(`INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)`).run(input.ownerId, targetId, input.now)
          localFollowed++
        }
      }

      // Substep: resolve/create sources, enforce the cap. active+pending+
      // pending_review all count toward it (same query as resolveAndSubscribeSource).
      let active = 0, pending = 0, notSubscribable = 0, capSkipped = 0
      let unavailable = input.unavailableCount
      let subCount = (raw.prepare(`SELECT COUNT(*) AS n FROM source_subscriptions_v2 WHERE owner_id = ?`).get(input.ownerId) as { n: number }).n

      for (const canonicalUrl of input.canonicalUrls) {
        let source = raw.prepare(`SELECT * FROM remote_sources_v2 WHERE canonical_url = ?`).get(canonicalUrl) as RemoteSourceV2Row | undefined

        // Blocked reveals nothing beyond generic unavailable (design §4) —
        // same bucket the pre-write SSRF/invalid-URL rejects landed in.
        if (source && source.governance === 'blocked') { unavailable++; continue }

        if (source) {
          const federated = raw.prepare(`SELECT 1 FROM federation_relationships_v2 WHERE source_id = ?`).get(source.id)
          if (source.attribution_mode === 'aggregate' || federated) { notSubscribable++; continue }
        }

        const existingSub = source
          ? (raw.prepare(`SELECT * FROM source_subscriptions_v2 WHERE owner_id = ? AND source_id = ?`).get(input.ownerId, source.id) as SourceSubscriptionV2Row | undefined)
          : undefined

        if (existingSub) {
          if (existingSub.state === 'active') active++
          else pending++ // pending and pending_review are both pending-ish (matches resolveAndSubscribeSource)
          continue
        }

        if (subCount >= input.cap) { capSkipped++; continue }

        if (!source) {
          const id = randomUUID()
          raw.prepare(
            `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
             VALUES (?, ?, 'single_publisher', 'enabled', 'allowed', 'opml', NULL, 0, ?)`,
          ).run(id, canonicalUrl, input.now)
          source = { id, canonical_url: canonicalUrl, attribution_mode: 'single_publisher', operation: 'enabled', governance: 'allowed', provenance: 'opml', provenance_note: null, admin_retained: 0, overridden: 1, created_at: input.now }
        }
        const state: 'active' | 'pending' = source.governance === 'quarantined' ? 'pending' : 'active'
        raw.prepare(
          `INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(randomUUID(), input.ownerId, source.id, state, input.now)
        subCount++
        if (state === 'pending') pending++
        else active++
      }

      const result: ImportSourcesResult = { localFollowed, active, pending, unavailable, notSubscribable, capSkipped }
      storeCommand(raw, input.command, result, input.now)
      return result
    }).immediate()
  }

  // Shared by ownerFollowing and publicFollowing: local-account follows are
  // never governance-gated, so both projections show the identical set.
  private localFollowsFor(ownerId: string): PublicLocalFollow[] {
    const rows = this.raw.prepare(
      `SELECT u.id AS id, u.handle AS handle, u.display_name AS display_name
       FROM follows f JOIN users u ON u.id = f.followed_id
       WHERE f.follower_id = ? AND u.kind = 'local'
       ORDER BY f.created_at ASC, u.handle ASC`,
    ).all(ownerId) as { id: string; handle: string; display_name: string }[]
    return rows.map((r) => ({ kind: 'local', id: r.id, handle: r.handle, displayName: r.display_name }))
  }

  // Task 5: ordinary projections — plain queries, not commands. Every SELECT
  // lists its columns explicitly; never spread a row, since that is how
  // administrative fields (governance/operation/provenance/adminRetained/
  // audit/counts) would leak into an ordinary response (frozen contract).
  async ownerFollowing(ownerId: string): Promise<OwnerFollowingView> {
    const localFollows = this.localFollowsFor(ownerId)

    const subRows = this.raw.prepare(
      `SELECT s.source_id AS source_id, s.state AS state, r.canonical_url AS canonical_url, r.attribution_mode AS attribution_mode
       FROM source_subscriptions_v2 s JOIN remote_sources_v2 r ON r.id = s.source_id
       WHERE s.owner_id = ?
       ORDER BY s.created_at ASC`,
    ).all(ownerId) as { source_id: string; state: 'active' | 'pending' | 'pending_review'; canonical_url: string; attribution_mode: 'single_publisher' | 'aggregate' }[]
    // active -> available; pending/pending_review -> awaiting_review, no matter
    // the source's governance (pending only ever arises on a quarantined source
    // today, and pending_review is pinned to awaiting_review regardless — rev 5).
    const sourceSubscriptions: OwnerSourceFollow[] = subRows.map((r) => ({
      sourceId: r.source_id,
      url: r.canonical_url,
      attributionMode: r.attribution_mode,
      subscriptionState: r.state,
      availability: r.state === 'active' ? 'available' : 'awaiting_review',
    }))
    return { localFollows, sourceSubscriptions }
  }

  async publicFollowing(ownerId: string): Promise<PublicFollowingEntry[]> {
    const localFollows: PublicFollowingEntry[] = this.localFollowsFor(ownerId)

    // Public exposes active subscriptions on allowed sources ONLY (design §4) —
    // pending/pending_review and any non-allowed governance are excluded here,
    // not filtered later, so a quarantined/blocked source's id never reaches JSON.
    const sourceRows = this.raw.prepare(
      `SELECT s.source_id AS source_id, r.canonical_url AS canonical_url
       FROM source_subscriptions_v2 s JOIN remote_sources_v2 r ON r.id = s.source_id
       WHERE s.owner_id = ? AND s.state = 'active' AND r.governance = 'allowed'
       ORDER BY s.created_at ASC`,
    ).all(ownerId) as { source_id: string; canonical_url: string }[]
    const sourceEntries: PublicFollowingEntry[] = sourceRows.map((r): PublicSourceFollow => ({
      kind: 'source', sourceId: r.source_id, url: r.canonical_url, displayName: sourceDisplayName(r.canonical_url),
    }))
    return [...localFollows, ...sourceEntries]
  }

  // One ledger-backed BEGIN IMMEDIATE transaction (Task 5): ledger check,
  // delete the subscription, evaluate last-subscription retention
  // (reapSourceIfOrphaned — shared with deleteUserCascade), store, commit.
  async unsubscribe(input: { command: CommandEnvelope; ownerId: string; sourceId: string; now: string }): Promise<UnsubscribeResult> {
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<UnsubscribeResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' } as UnsubscribeResult

      const sub = raw.prepare(`SELECT id, state FROM source_subscriptions_v2 WHERE owner_id = ? AND source_id = ?`).get(input.ownerId, input.sourceId) as { id: string; state: SourceSubscriptionState } | undefined
      if (!sub) {
        const result: UnsubscribeResult = { kind: 'unknown' }
        storeCommand(raw, input.command, result, input.now)
        return result
      }
      raw.prepare(`DELETE FROM source_subscriptions_v2 WHERE id = ?`).run(sub.id)

      const result: UnsubscribeResult = { kind: 'removed', sourceRemoved: reapSourceIfOrphaned(raw, input.sourceId) }
      if (sub.state === 'active') journalPolicyReset(raw, input.now) // active removal changes Personal membership
      storeCommand(raw, input.command, result, input.now)
      return result
    }).immediate()
  }

  // Task 2 (admin-governance-visibility): the operator override of
  // reapSourceIfOrphaned. Same ledger-backed BEGIN IMMEDIATE shape as every
  // other command here; the guard chain itself lives in reapSource (shared
  // domain function) — this method only wraps it with the command ledger and
  // the unknown-source 404 case.
  async reapSource(input: { command: CommandEnvelope; sourceId: string; force: boolean; now: string }): Promise<ReapCommandResult> {
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<ReapCommandResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' as const }
      if (!raw.prepare(`SELECT 1 FROM remote_sources_v2 WHERE id = ?`).get(input.sourceId)) {
        const result = { kind: 'unknown' as const }
        storeCommand(raw, input.command, result, input.now)
        return result
      }
      const outcome = reapSourceFn(raw, input.sourceId, { force: input.force }, input.now)
      // Only a 'reaped' outcome is ledgered — like every sibling admin command,
      // a refusal writes nothing so a retry with the same commandId
      // re-evaluates against live state instead of replaying a stale refusal.
      if (outcome.kind === 'reaped') storeCommand(raw, input.command, outcome, input.now)
      return outcome
    }).immediate()
  }

  // Task 6, audited administrator commands. Both follow the same shape as every
  // mutation above — one BEGIN IMMEDIATE transaction: ledger check, resolve,
  // apply, write the audit row, store the result, commit — with one addition:
  // a conflict NEVER writes, not even a ledger row, so a corrected retry is
  // re-evaluated against live state instead of replaying a stale refusal.

  // actorKind widens with the audit vocabulary: the ops-token federation route
  // (V4 Task 9) establishes as 'operator_token'. The SourceRepository /
  // SourceService declarations widen with their own tasks.
  async establishFederation(input: {
    command: CommandEnvelope; canonicalUrl: string; attributionMode: AttributionMode
    category: AuditCategory; note: string | null; actorKind: 'administrator' | 'operator_token'; now: string
  }): Promise<EstablishFederationResult> {
    if (!input.category) return { kind: 'conflict' } // every establishment is audited under a category
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<EstablishFederationResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' } as EstablishFederationResult

      let row = raw.prepare(`SELECT * FROM remote_sources_v2 WHERE canonical_url = ?`).get(input.canonicalUrl) as RemoteSourceV2Row | undefined

      // Blocked: unblock or purge first (design §5). Reveals nothing further.
      if (row && row.governance === 'blocked') {
        const result: EstablishFederationResult = { kind: 'unavailable' }
        storeCommand(raw, input.command, result, input.now)
        return result
      }
      // The relationship's PK is source_id, so concurrent different commands
      // converge on the one row: the loser reports it already exists.
      if (row && raw.prepare(`SELECT 1 FROM federation_relationships_v2 WHERE source_id = ?`).get(row.id)) {
        const result: EstablishFederationResult = { kind: 'exists' }
        storeCommand(raw, input.command, result, input.now)
        return result
      }

      if (!row) {
        // New URL: the administrator picks the mode; a federated source starts
        // enabled and allowed.
        const id = randomUUID()
        raw.prepare(
          `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
           VALUES (?, ?, ?, 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
        ).run(id, input.canonicalUrl, input.attributionMode, input.now)
        row = { id, canonical_url: input.canonicalUrl, attribution_mode: input.attributionMode, operation: 'enabled', governance: 'allowed', provenance: 'admin_federation', provenance_note: null, admin_retained: 0, overridden: 1, created_at: input.now }
      } else if (row.governance === 'quarantined') {
        // A retained source keeps its own mode and operation; approval only
        // lifts a quarantined candidate to allowed (design §5).
        raw.prepare(`UPDATE remote_sources_v2 SET governance = 'allowed' WHERE id = ?`).run(row.id)
        row = { ...row, governance: 'allowed' }
      }

      raw.prepare(
        `INSERT INTO federation_relationships_v2 (source_id, status, provenance_note, created_at, updated_at) VALUES (?, 'approved', ?, ?, ?)`,
      ).run(row.id, input.note, input.now, input.now)
      activatePendingSubscriptions(raw, row)

      const source = rowToRemoteSourceV2(row)
      const federation: FederationRelationship = { sourceId: row.id, status: 'approved', provenanceNote: input.note, createdAt: input.now, updatedAt: input.now }
      const result: EstablishFederationResult = { kind: 'established', source, federation }
      advancePolicyGeneration(raw, row.id, input.now) // federation is a source-policy change
      journalPolicyReset(raw, input.now)
      const moved = cascadeInstanceAction(raw, { id: row.id, canonical_url: row.canonical_url }, 'establish', input.now)
      if (moved > 0) insertAudit(raw, { sourceId: row.id, command: input.command, actorKind: 'system', action: 'instance_cascade', category: input.category, note: null, result: { moved }, now: input.now })
      insertAudit(raw, { sourceId: row.id, command: input.command, actorKind: input.actorKind, action: 'establish_federation', category: input.category, note: input.note, result, now: input.now })
      storeCommand(raw, input.command, result, input.now)
      return result
    }).immediate()
  }

  async transition(input: {
    command: CommandEnvelope; sourceId: string; action: SourceTransitionAction
    category: AuditCategory | null; note: string | null; attributionMode?: AttributionMode
    actorKind: 'administrator' | 'system'; now: string
  }): Promise<SourceTransitionResult> {
    // Malformed requests are refused before the ledger is touched.
    if (!input.category && !CATEGORY_OPTIONAL_ACTIONS.has(input.action)) return { kind: 'conflict' }
    if (input.action === 'set_attribution_mode' && !input.attributionMode) return { kind: 'conflict' }
    const raw = this.raw
    return raw.transaction(() => {
      const check = checkCommand<SourceTransitionResult>(raw, input.command)
      if (check.kind === 'replay') return check.result
      if (check.kind === 'conflict') return { kind: 'conflict' } as SourceTransitionResult

      const row = raw.prepare(`SELECT * FROM remote_sources_v2 WHERE id = ?`).get(input.sourceId) as RemoteSourceV2Row | undefined
      if (!row) {
        const result: SourceTransitionResult = { kind: 'unknown' }
        storeCommand(raw, input.command, result, input.now)
        return result
      }
      const fed = raw.prepare(`SELECT status FROM federation_relationships_v2 WHERE source_id = ?`).get(row.id) as { status: FederationStatus } | undefined
      const axes: SourceAxes = { operation: row.operation, governance: row.governance, federation: fed ? fed.status : 'none' }

      const patch = SOURCE_TRANSITIONS[input.action](axes)
      if (!patch) return { kind: 'conflict' } as SourceTransitionResult // invalid cell: refused, writes nothing

      const operation = patch.operation ?? row.operation
      const governance = patch.governance ?? row.governance
      const attributionMode = input.action === 'set_attribution_mode' && input.attributionMode ? input.attributionMode : row.attribution_mode
      if (operation !== row.operation || governance !== row.governance || attributionMode !== row.attribution_mode) {
        raw.prepare(`UPDATE remote_sources_v2 SET operation = ?, governance = ?, attribution_mode = ? WHERE id = ?`).run(operation, governance, attributionMode, row.id)
      }
      // A direct administrator GOVERNANCE change on a member is a sticky
      // override; pause/resume/set_attribution_mode are not judgments.
      const overriddenFlip = input.actorKind === 'administrator' && governance !== row.governance && row.provenance === 'origin_verification'
      if (overriddenFlip) {
        raw.prepare(`UPDATE remote_sources_v2 SET overridden = 1 WHERE id = ?`).run(row.id)
      }
      if (patch.federation === 'none') raw.prepare(`DELETE FROM federation_relationships_v2 WHERE source_id = ?`).run(row.id)
      else if (patch.federation) raw.prepare(`UPDATE federation_relationships_v2 SET status = ?, updated_at = ? WHERE source_id = ?`).run(patch.federation, input.now, row.id)

      // m1 (whole-branch review): `updated` is spread from the PRE-flip row —
      // when overriddenFlip just fired, the DB row is already 1 but `row` still
      // says 0. Reflect the flip in the same response, not just the database.
      const updated: RemoteSourceV2Row = { ...row, operation, governance, attribution_mode: attributionMode, overridden: overriddenFlip ? 1 : row.overridden }
      if (input.action === 'allow' || input.action === 'approve') activatePendingSubscriptions(raw, updated)
      // Converting to aggregate withdraws every ordinary subscription for review
      // — active and pending alike — in the same transaction as the mode change.
      if (attributionMode === 'aggregate' && row.attribution_mode !== 'aggregate') {
        raw.prepare(`UPDATE source_subscriptions_v2 SET state = 'pending_review' WHERE source_id = ? AND state IN ('active', 'pending')`).run(row.id)
      }

      // Governance, federation, or attribution-mode changes advance this source's
      // policy generation and append ONE reset (even when several subscriptions
      // change with it — no fan-out). pause/resume touch only the operation axis:
      // no reset, generation retained (spec §3.7). patch.federation is set only by
      // approve/reject/revoke, the genuine federation transitions.
      if (governance !== row.governance || patch.federation !== undefined || attributionMode !== row.attribution_mode) {
        advancePolicyGeneration(raw, row.id, input.now)
        journalPolicyReset(raw, input.now)
      }

      // The instance-governed-members cascade (spec 2026-07-25 rev 3): an
      // instance's governance transition, or its federation being newly
      // approved, re-runs the same action against every member underneath it.
      if (governance !== row.governance || input.action === 'approve') {
        const fedNow = patch.federation === 'approved' || (fed?.status === 'approved' && patch.federation === undefined)
        if (fedNow) {
          const moved = cascadeInstanceAction(raw, { id: row.id, canonical_url: row.canonical_url }, input.action, input.now)
          if (moved > 0) insertAudit(raw, { sourceId: row.id, command: input.command, actorKind: 'system', action: 'instance_cascade', category: input.category, note: null, result: { moved }, now: input.now })
        }
      }

      const source = rowToRemoteSourceV2(updated)
      const audit = insertAudit(raw, { sourceId: row.id, command: input.command, actorKind: input.actorKind, action: input.action, category: input.category, note: input.note, result: { kind: 'applied', source }, now: input.now })
      const result: SourceTransitionResult = { kind: 'applied', source, audit }
      storeCommand(raw, input.command, result, input.now)
      return result
    }).immediate()
  }

  close(): void {
    this.raw.pragma('wal_checkpoint(TRUNCATE)')
    this.raw.close()
  }

  // Idle = latest session update, else auth-user createdAt. Anon guests are
  // few; candidate selection in JS dodges better-auth's date-storage format
  // (new Date() parses ISO strings and epoch numbers alike).
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
  sweepAnonymousUsers(ttlDays: number, logical?: LogicalStore): { swept: number } {
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
}

// index N-1 holds the statements that bring the schema to version N.
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
