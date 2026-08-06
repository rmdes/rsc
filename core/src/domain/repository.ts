import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry, Subscription, PushProtocol, Page } from './types.ts'
import type { LogicalStore } from '../logical/store.ts'
import type { Cursor } from './source-repository.ts'

export interface Repository {
  createLocalUser(u: NewLocalUser): Promise<User>
  createRemoteUser(u: NewRemoteUser): Promise<User>
  updateFeedUrl(userId: string, feedUrl: string): Promise<void>
  getUser(id: string): Promise<User | undefined>
  getUserByHandle(handle: string): Promise<User | undefined>
  getUserByAuthUserId(authUserId: string): Promise<User | undefined>
  setAuthUserId(userId: string, authUserId: string): Promise<void>
  countFollowers(userId: string): Promise<number>
  countPostsByAuthor(authorId: string): Promise<number>
  getSetting(key: string): Promise<string | undefined>
  setSetting(key: string, value: string): Promise<void>
  deleteUserCascade(id: string): void
  deleteAuthRows(authUserId: string): void
  instanceStats(v2: boolean): { registeredUsers: number; guests: number; remoteFeeds: number; posts: number }
  listUsers(cursor: Cursor | undefined, limit: number): Page<{ handle: string; displayName: string; kind: 'local' | 'remote'; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }>
  close(): void
  listFollowing(followerId: string): Promise<User[]>
  getPost(id: string): Promise<Post | undefined>
  countRepliesByPostIds(ids: string[]): Promise<Map<string, number>>
  getPostsByAuthor(authorId: string, limit: number): Promise<Post[]>
  getRecentLocalPosts(limit: number): Promise<TimelineEntry[]>
  upsertSubscription(s: Subscription): Promise<void>
  deleteSubscription(protocol: PushProtocol, topic: string, callback: string): Promise<void>
  listActiveSubscriptions(topic: string, now: string): Promise<Subscription[]>
  countActiveSubscriptions(filter: { callbackHost?: string; topic?: string }, now: string): Promise<number>
  purgeExpiredSubscriptions(now: string): Promise<void>
  sweepUnverifiedUsers(ttlDays: number, logical?: LogicalStore): { swept: number }
  sweepAnonymousUsers(ttlDays: number, logical?: LogicalStore): { swept: number }
}
