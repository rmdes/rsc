export class DomainError extends Error {}

export class HandleTakenError extends DomainError {}

export type UserKind = 'local' | 'remote'
export type PostSource = 'local' | 'remote'

export interface User {
  id: string
  kind: UserKind
  handle: string
  displayName: string
  feedUrl: string | null
  createdAt: string
}

export interface Post {
  id: string
  authorId: string
  source: PostSource
  guid: string
  title: string | null
  content: string
  url: string | null
  publishedAt: string
  createdAt: string
}

export interface NewLocalUser { handle: string; displayName: string }
export interface NewRemoteUser { handle: string; displayName: string; feedUrl: string }
export type TimelineEntry = Post & { author: User }
export interface TimelineCursor { publishedAt: string; id: string }

export type PushProtocol = 'websub' | 'rsscloud'

export interface Subscription {
  id: string
  protocol: PushProtocol
  topic: string
  callback: string
  callbackHost: string
  secret: string | null
  expiresAt: string
  createdAt: string
}

export interface PushSubscription {
  id: string
  userId: string
  mode: PushProtocol
  endpoint: string
  topic: string
  callbackToken: string
  secret: string | null
  state: 'pending' | 'active'
  expiresAt: string
  createdAt: string
}
