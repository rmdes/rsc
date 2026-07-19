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
  authUserId: string | null
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
  inReplyTo?: string | null
  inReplyToPostId?: string | null
  threadRootId?: string | null
  sourceName?: string | null      // per-item attribution from aggregate feeds (RSS <source url>name</source>)
  sourceFeedUrl?: string | null
  contentMarkdown?: string | null // incoming source:markdown, verbatim (remote); null otherwise
  editedAt?: string | null
  replyContextAuthor?: string | null
  replyContextSnippet?: string | null
}

// A resolved reply's reply-context is the replier's unverified claim about a
// parent we now have for real — it must never leave core. Generic so it wraps
// both a TimelineEntry (joinedRowToEntry, emitNewPost) and a bare Post (the
// revisions route). Applied at every client-facing serialization site.
export function hideResolvedReplyContext<T extends { inReplyToPostId?: string | null; replyContextAuthor?: string | null; replyContextSnippet?: string | null }>(e: T): T {
  return e.inReplyToPostId ? { ...e, replyContextAuthor: null, replyContextSnippet: null } : e
}

export interface PostRevision {
  id: string
  postId: string
  title: string | null
  content: string
  contentMarkdown: string | null
  seenAt: string
}

export interface NewLocalUser { handle: string; displayName: string; authUserId?: string }
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
