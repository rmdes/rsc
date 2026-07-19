import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry, TimelineCursor, Subscription, PushSubscription, PushProtocol, PostRevision } from './types.ts'

export interface Repository {
  createLocalUser(u: NewLocalUser): Promise<User>
  createRemoteUser(u: NewRemoteUser): Promise<User>
  updateFeedUrl(userId: string, feedUrl: string): Promise<void>
  getUser(id: string): Promise<User | undefined>
  getUserByHandle(handle: string): Promise<User | undefined>
  getUserByAuthUserId(authUserId: string): Promise<User | undefined>
  setAuthUserId(userId: string, authUserId: string): Promise<void>
  updateUserProfile(userId: string, patch: { handle?: string; displayName?: string }): Promise<User>
  listRemoteUsers(): Promise<User[]>
  listTextcastingPeers(): Promise<User[]>
  getRemoteUserByFeedUrl(url: string): Promise<User | undefined>
  countRemoteSubscriptions(userId: string): Promise<number>
  countFollowers(userId: string): Promise<number>
  getSetting(key: string): Promise<string | undefined>
  setSetting(key: string, value: string): Promise<void>
  deleteUserCascade(id: string): void
  deleteAuthRows(authUserId: string): void
  instanceStats(): { registeredUsers: number; guests: number; remoteFeeds: number; posts: number }
  listUsers(): Array<{ handle: string; displayName: string; kind: 'local' | 'remote'; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }>
  close(): void
  addFollow(followerId: string, followedId: string): Promise<void>
  removeFollow(followerId: string, followedId: string): Promise<void>
  listFollowing(followerId: string): Promise<User[]>
  insertPost(p: Post): Promise<boolean>
  hasPostsByAuthor(authorId: string): Promise<boolean>
  getTimeline(limit: number, before?: TimelineCursor, filter?: { followedBy?: string; authorId?: string; source?: 'local'; feedType?: 'instance' }): Promise<TimelineEntry[]>
  /** Arrival-order replay scan: created_at >= sinceCreatedAt, ASC. Inclusive by
   *  design (same-ms batches re-deliver in full); consumers dedup by id. */
  getTimelineAfter(sinceCreatedAt: string, limit: number): Promise<TimelineEntry[]>
  getPost(id: string): Promise<Post | undefined>
  deletePost(id: string): Promise<void>
  findPostByRef(ref: string): Promise<Post | undefined>
  getThread(rootId: string): Promise<TimelineEntry[]>
  adoptOrphans(parent: Post): Promise<void>
  backfillItemExtras(authorId: string, guid: string, sourceName: string | null, sourceFeedUrl: string | null, contentMarkdown: string | null, url: string | null): Promise<void>
  getEditableByGuid(authorId: string, guid: string): Promise<{ id: string; title: string | null; content: string; contentMarkdown: string | null } | undefined>
  recordEdit(postId: string, next: { title: string | null; content: string; contentMarkdown: string | null; editedAt: string }): Promise<void>
  getRevisions(postId: string): Promise<PostRevision[]>
  countRepliesByPostIds(ids: string[]): Promise<Map<string, number>>
  listRepliesByPostId(id: string): Promise<TimelineEntry[]>
  getPostsByAuthor(authorId: string, limit: number): Promise<Post[]>
  getRecentLocalPosts(limit: number): Promise<TimelineEntry[]>
  upsertSubscription(s: Subscription): Promise<void>
  deleteSubscription(protocol: PushProtocol, topic: string, callback: string): Promise<void>
  listActiveSubscriptions(topic: string, now: string): Promise<Subscription[]>
  countActiveSubscriptions(filter: { callbackHost?: string; topic?: string }, now: string): Promise<number>
  purgeExpiredSubscriptions(now: string): Promise<void>
  upsertPushSubscription(s: PushSubscription): Promise<void>
  findPushSubscription(filter: { token?: string; userId?: string; mode?: PushProtocol; topic?: string }, opts?: { unexpiredAt?: string; state?: 'pending' | 'active' }): Promise<PushSubscription | undefined>
  listRenewablePushSubscriptions(before: string): Promise<PushSubscription[]>
  deletePushSubscription(id: string): Promise<void>
}
