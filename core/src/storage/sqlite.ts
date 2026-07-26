import { Kysely, SqliteDialect } from 'kysely'
import Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import type { Repository } from '../domain/repository.ts'
import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry, TimelineCursor, TimelineFilter, Subscription, PushProtocol, FeedType } from '../domain/types.ts'
import { HandleTakenError } from '../domain/types.ts'
import { hideResolvedReplyContext } from '../domain/types.ts'
import type { RemoteSource, SourceSubscription, SourceAuditEvent, Page, SourceSummary, SourceDetail, PushSummary, FederationStatus, OwnerSourceFollow, PublicLocalFollow, PublicSourceFollow, PublicFollowingEntry, OwnerFollowingView, CommandEnvelope, AttributionMode, AuditCategory, FederationRelationship, SourceTransitionResult, SourceSubscriptionState } from '../domain/types.ts'
import type { SourceRepository, Cursor, SubscribeResult, ImportSourcesResult, UnsubscribeResult, EstablishFederationResult, SourceTransitionAction, SourceAxes } from '../domain/source-repository.ts'
import { encodeCursor, clampLimit, checkCommand, storeCommand, reapSourceIfOrphaned, SOURCE_TRANSITIONS, CATEGORY_OPTIONAL_ACTIONS } from '../domain/source-repository.ts'
import { LOGICAL_V2_SCHEMA, LOGICAL_V3_SCHEMA, LOGICAL_V4_SCHEMA, LOGICAL_PERF_INDEXES, LOGICAL_PERF_INDEXES_2, assertHandleUnreserved } from '../logical/schema.ts'
import { appendJournal } from '../logical/journal.ts'
import { scheduleFanout } from '../logical/fanout.ts'
import type { LogicalStore } from '../logical/store.ts'

// --- V2 logical journal integration (Task 9, spec §3.7) ----------------------
// These source-command methods run only when the source-control plane is wired
// (RSC_SOURCE_MODEL_V2 on; server.ts builds `sources` only then), so the journal
// effects below never fire in flag-off production. Governance/federation/
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

// v2 source-control plane row shapes (RSC_SOURCE_MODEL_V2, dormant) — read-only
// in this task. Rows carry the WIDER SQL CHECK vocabulary (rev 5, V4 §10 pin);
// mapping to the narrower V1 DTO types below is deliberate, not a bug.
interface RemoteSourceV2Row {
  id: string; canonical_url: string
  attribution_mode: 'single_publisher' | 'aggregate'
  operation: 'enabled' | 'paused'
  governance: 'allowed' | 'quarantined' | 'blocked'
  provenance: 'user_subscription' | 'opml' | 'admin_federation' | 'origin_verification' | 'migration'
  provenance_note: string | null
  admin_retained: 0 | 1
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
    provenanceNote: r.provenance_note, adminRetained: r.admin_retained === 1, createdAt: r.created_at,
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

  async updateDisplayNameIfUnset(userId: string, name: string) {
    // Only while display_name still equals feed_url (the subscribe-seeded value) — never clobber a chosen name.
    await this.db.updateTable('users').set({ display_name: name }).where('id', '=', userId).whereRef('display_name', '=', 'feed_url').execute()
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
    if (patch.handle !== undefined) assertHandleUnreserved(this.sqlite, patch.handle)
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
  async getTimeline(limit: number, before?: TimelineCursor, filter?: TimelineFilter): Promise<TimelineEntry[]> {
    let q = this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id', 'users.feed_type as u_feed_type'])
      .orderBy('posts.published_at', 'desc')
      .orderBy('posts.id', 'desc')
      .limit(limit)
    if (before) {
      q = q.where((eb) => eb(eb.refTuple('posts.published_at', 'posts.id'), '<', eb.tuple(before.publishedAt, before.id)))
    }
    if (filter?.source) q = q.where('posts.source', '=', filter.source)
    if (filter?.feedType) q = q.where('users.feed_type', '=', filter.feedType)
    if (filter?.followedBy) {
      const followerId = filter.followedBy
      // Personal river includes its owner — no self-follow edge exists (SP2 rev 1).
      q = q.where((eb) =>
        eb.or([
          eb('posts.author_id', '=', followerId),
          eb('posts.author_id', 'in', eb.selectFrom('follows').select('followed_id').where('follower_id', '=', followerId)),
        ])
      )
      q = q.where((eb) => eb.or([eb('users.feed_type', 'is', null), eb('users.feed_type', '!=', 'instance')])) // Decision B: personal river never shows instances
    }
    if (filter?.authorId) {
      q = q.where('posts.author_id', '=', filter.authorId)
    }
    if (filter?.topLevel) q = q.where('posts.in_reply_to_post_id', 'is', null)
    const rows = await q.execute()
    return rows.map(joinedRowToEntry)
  }

  async getTimelineAfter(sinceCreatedAt: string, limit: number): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id', 'users.feed_type as u_feed_type'])
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
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id', 'users.feed_type as u_feed_type'])
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
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id', 'users.feed_type as u_feed_type'])
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

  async countThreadRepliesByRootIds(rootIds: string[]): Promise<Map<string, number>> {
    if (rootIds.length === 0) return new Map()
    const rows = await this.db
      .selectFrom('posts')
      .select('thread_root_id')
      .select(({ fn }) => fn.countAll().as('n'))
      .where('thread_root_id', 'in', rootIds)
      .groupBy('thread_root_id')
      .execute()
    return new Map(rows.map((r) => [r.thread_root_id as string, Number(r.n)]))
  }

  async listRepliesByPostId(id: string): Promise<TimelineEntry[]> {
    const rows = await this.db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .selectAll('posts')
      .select(['users.id as u_id', 'users.kind as u_kind', 'users.handle as u_handle', 'users.display_name as u_display_name', 'users.feed_url as u_feed_url', 'users.created_at as u_created_at', 'users.auth_user_id as u_auth_user_id', 'users.feed_type as u_feed_type'])
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

  // Manual cascade for a user: the LEGACY tables' FKs are plain REFERENCES with
  // no DB-level ON DELETE CASCADE. (The v2 tables DO declare ON DELETE CASCADE,
  // which is why the v2 reap below runs explicitly — the cascade removes the
  // subscription rows but cannot evaluate whether the source itself is retained.)
  // Shared by DELETE /users, removeFollow's orphaned-feed reap, removeRemoteFeed,
  // deleteLocalAccount's flag-off branch, and sweepAnonymousUsers' fallback
  // (only when no `logical` is passed). post_revisions must go before posts —
  // its post_id FK is RESTRICT and foreign_keys=ON.
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
  // hold that bridge row; deleteLocalAccount's own call here is the explicit
  // flag-off (`logical` absent) branch, the one case this cascade is meant for.
  deleteUserCascade(id: string): void {
    const raw = this.raw
    raw.transaction(() => {
      // v2 subscriptions go with the user via their own ON DELETE CASCADE, so
      // read the source ids first and re-evaluate retention after — otherwise
      // an account deletion leaves subscriber-less sources behind that no
      // unsubscribe will ever reach. Empty (a no-op) while RSC_SOURCE_MODEL_V2
      // is off, since nothing writes the v2 tables then.
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

  // Under RSC_SOURCE_MODEL_V2, remote feeds and remote items live in the v2
  // tables (remote_sources_v2, logical_items_v2), not users/posts — a plain
  // union would double-count a converted DB that still has rows in both. So
  // this branches on the flag rather than unioning; the v1 query stays the
  // untouched original.
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

  // --- v2 source-control plane administrative reads (RSC_SOURCE_MODEL_V2,
  // dormant) — no HTTP route calls these yet; nothing here touches legacy
  // tables. Flag-off isolation is by construction: these methods only ever
  // read the five v2 tables, which stay empty until a later vertical writes.

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

  async listSourceSummaries(cursor: Cursor | undefined, limit: number, filter?: 'governance'): Promise<Page<SourceSummary>> {
    const lim = clampLimit(limit)
    // 'governance' narrows to the administratively load-bearing rows — any
    // federation relationship (approved OR pending) or a quarantined source —
    // so the admin page's federation/review sections can be built independent
    // of where bulk subscriptions push them in the created_at pagination.
    const where = filter === 'governance'
      ? `(EXISTS(SELECT 1 FROM federation_relationships_v2 f WHERE f.source_id = remote_sources_v2.id) OR governance = 'quarantined')`
      : '1=1'
    const rows = (cursor
      ? this.raw.prepare(
          `SELECT * FROM remote_sources_v2 WHERE ${where} AND ((created_at < ?) OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(cursor.createdAt, cursor.createdAt, cursor.id, lim + 1)
      : this.raw.prepare(`SELECT * FROM remote_sources_v2 WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(lim + 1)
    ) as RemoteSourceV2Row[]
    const { page, nextCursor } = this.splitPage(rows, lim)
    const items: SourceSummary[] = page.map((r) => {
      const source = rowToRemoteSourceV2(r)
      return { source, federationStatus: this.federationStatusFor(source.id), subscriptionCounts: this.subscriptionCountsFor(source.id), push: this.pushFor(source.id).push }
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
    const auditRow = this.raw.prepare(
      `SELECT * FROM source_audit_v2 WHERE source_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(id) as SourceAuditV2Row | undefined
    return {
      source: rowToRemoteSourceV2(row),
      federationStatus: this.federationStatusFor(id),
      subscriptionCounts: this.subscriptionCountsFor(id),
      latestAudit: auditRow ? rowToSourceAuditV2(auditRow) : null,
      ...this.pushFor(id),
    }
  }

  // The administrative push projection (V4 spec §1.5). A source holds at most one
  // row per mode, so the ONE lease the admin sees is chosen deterministically: a
  // live lease over a pending one, then websub over its rsscloud fallback. The
  // endpoint is NEVER shipped — only a stable non-secret digest of it — and the
  // callback token and secret are not read at all, so they cannot reach any body.
  // ponytail: one small indexed lookup per listed source (the page is clamped to
  // ≤50); fold into the list query only if a page read ever shows up in a profile.
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

  // --- v2 source-control plane mutations (RSC_SOURCE_MODEL_V2, dormant) —
  // Task 3. Each method is a single ledger-backed BEGIN IMMEDIATE
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
          source = { id, canonical_url: input.canonicalUrl, attribution_mode: 'single_publisher', operation: 'enabled', governance: 'allowed', provenance: 'user_subscription', provenance_note: null, admin_retained: 0, created_at: input.now }
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
          source = { id, canonical_url: canonicalUrl, attribution_mode: 'single_publisher', operation: 'enabled', governance: 'allowed', provenance: 'opml', provenance_note: null, admin_retained: 0, created_at: input.now }
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
        row = { id, canonical_url: input.canonicalUrl, attribution_mode: input.attributionMode, operation: 'enabled', governance: 'allowed', provenance: 'admin_federation', provenance_note: null, admin_retained: 0, created_at: input.now }
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
      if (patch.federation === 'none') raw.prepare(`DELETE FROM federation_relationships_v2 WHERE source_id = ?`).run(row.id)
      else if (patch.federation) raw.prepare(`UPDATE federation_relationships_v2 SET status = ?, updated_at = ? WHERE source_id = ?`).run(patch.federation, input.now, row.id)

      const updated: RemoteSourceV2Row = { ...row, operation, governance, attribution_mode: attributionMode }
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
  // production since Task 6; kept for callers that still run flag-off).
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
  [
    // v2 source-control plane (RSC_SOURCE_MODEL_V2, dormant): nothing reads
    // or writes these tables yet. The SQL CHECKs are deliberately WIDER than
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
  // Logical-v2 additive schema (RSC_SOURCE_MODEL_V2, dormant). Appended at the
  // TAIL — mid-array insertion corrupts user_version on live databases. Pure
  // additive CREATE/ALTER/INSERT; creates only the inactive activation row.
  // Defined in logical/schema.ts; see plan Appendix A.
  LOGICAL_V2_SCHEMA,
  // Logical-v3 additive schema (moderation/events/verification, RSC_SOURCE_MODEL_V2,
  // dormant). Appended at the TAIL, AFTER LOGICAL_V2_SCHEMA — mid-array insertion
  // corrupts user_version on live databases. Pure additive ALTER/CREATE. Defined
  // in logical/schema.ts; see the V3 plan Appendix A.
  LOGICAL_V3_SCHEMA,
  // Logical-v4 additive schema (migration & cutover, RSC_SOURCE_MODEL_V2,
  // dormant). Appended at the TAIL, AFTER LOGICAL_V3_SCHEMA — mid-array
  // insertion corrupts user_version on live databases. Pure additive
  // CREATE/ALTER. Defined in logical/schema.ts; see the V4 plan Appendix A.
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
