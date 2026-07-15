import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry, TimelineCursor, Subscription, PushProtocol } from './types.ts'

export interface Repository {
  createLocalUser(u: NewLocalUser): Promise<User>
  createRemoteUser(u: NewRemoteUser): Promise<User>
  getUser(id: string): Promise<User | undefined>
  getUserByHandle(handle: string): Promise<User | undefined>
  listRemoteUsers(): Promise<User[]>
  insertPost(p: Post): Promise<boolean>
  hasPostsByAuthor(authorId: string): Promise<boolean>
  getTimeline(limit: number, before?: TimelineCursor): Promise<TimelineEntry[]>
  /** Arrival-order replay scan: created_at >= sinceCreatedAt, ASC. Inclusive by
   *  design (same-ms batches re-deliver in full); consumers dedup by id. */
  getTimelineAfter(sinceCreatedAt: string, limit: number): Promise<TimelineEntry[]>
  getPost(id: string): Promise<Post | undefined>
  upsertSubscription(s: Subscription): Promise<void>
  deleteSubscription(protocol: PushProtocol, topic: string, callback: string): Promise<void>
  listActiveSubscriptions(topic: string, now: string): Promise<Subscription[]>
  countActiveSubscriptions(filter: { callbackHost?: string; topic?: string }, now: string): Promise<number>
  purgeExpiredSubscriptions(now: string): Promise<void>
}
