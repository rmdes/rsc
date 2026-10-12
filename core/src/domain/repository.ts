import type { User, Post, NewLocalUser, NewRemoteUser, Subscription, PushProtocol, Page } from './types.ts'
import type { LogicalStore } from '../logical/store.ts'
import type { Cursor } from './source-repository.ts'

// The one store call the auth-user sweeps make (cascading account deletion).
export type AccountDeleter = Pick<LogicalStore, 'deleteLocalAccount'>

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
  upsertSubscription(s: Subscription): Promise<void>
  deleteSubscription(protocol: PushProtocol, topic: string, callback: string): Promise<void>
  listActiveSubscriptions(topic: string, now: string): Promise<Subscription[]>
  countActiveSubscriptions(filter: { callbackHost?: string; topic?: string }, now: string): Promise<number>
  purgeExpiredSubscriptions(now: string): Promise<void>
  sweepUnverifiedUsers(ttlDays: number, logical?: AccountDeleter): { swept: number }
  sweepAnonymousUsers(ttlDays: number, logical?: AccountDeleter): { swept: number }
  sweepDeadSources(): { swept: number }
}
