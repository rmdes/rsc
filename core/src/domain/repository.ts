import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry, TimelineCursor, Subscription, PushSubscription, PushProtocol } from './types.ts'

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
  addFollow(followerId: string, followedId: string): Promise<void>
  removeFollow(followerId: string, followedId: string): Promise<void>
  listFollowing(followerId: string): Promise<User[]>
  insertPost(p: Post): Promise<boolean>
  hasPostsByAuthor(authorId: string): Promise<boolean>
  getTimeline(limit: number, before?: TimelineCursor, filter?: { followedBy?: string; authorId?: string }): Promise<TimelineEntry[]>
  /** Arrival-order replay scan: created_at >= sinceCreatedAt, ASC. Inclusive by
   *  design (same-ms batches re-deliver in full); consumers dedup by id. */
  getTimelineAfter(sinceCreatedAt: string, limit: number): Promise<TimelineEntry[]>
  getPost(id: string): Promise<Post | undefined>
  findPostByRef(ref: string): Promise<Post | undefined>
  getThread(rootId: string): Promise<TimelineEntry[]>
  adoptOrphans(parent: Post): Promise<void>
  backfillItemExtras(authorId: string, guid: string, sourceName: string | null, sourceFeedUrl: string | null, contentMarkdown: string | null): Promise<void>
  countRepliesByPostIds(ids: string[]): Promise<Map<string, number>>
  listRepliesByPostId(id: string): Promise<Post[]>
  getPostsByAuthor(authorId: string, limit: number): Promise<Post[]>
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
