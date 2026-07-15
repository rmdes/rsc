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
  content: string
  url: string | null
  publishedAt: string
  createdAt: string
}

export interface NewLocalUser { handle: string; displayName: string }
export interface NewRemoteUser { handle: string; displayName: string; feedUrl: string }
export type TimelineEntry = Post & { author: User }
