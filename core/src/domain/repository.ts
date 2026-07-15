import type { User, Post, NewLocalUser, NewRemoteUser, TimelineEntry } from './types.ts'

export interface Repository {
  createLocalUser(u: NewLocalUser): Promise<User>
  createRemoteUser(u: NewRemoteUser): Promise<User>
  getUser(id: string): Promise<User | undefined>
  getUserByHandle(handle: string): Promise<User | undefined>
  listRemoteUsers(): Promise<User[]>
  insertPost(p: Post): Promise<void>
  hasPostGuid(guid: string): Promise<boolean>
  getTimeline(limit: number): Promise<TimelineEntry[]>
}
