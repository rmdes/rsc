export class DomainError extends Error {}

export class HandleTakenError extends DomainError {}

export type UserKind = 'local' | 'remote'
export type PostSource = 'local' | 'remote'
export type FeedType = 'person' | 'webfeed' | 'instance'

export interface User {
  id: string
  kind: UserKind
  handle: string
  displayName: string
  feedUrl: string | null
  createdAt: string
  authUserId: string | null
  feedType?: FeedType | null
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
export interface NewRemoteUser { handle: string; displayName: string; feedUrl: string; feedType?: FeedType }
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

// --- v2 source-control plane (RSC_SOURCE_MODEL_V2, dormant) ---

export type AttributionMode = 'single_publisher' | 'aggregate'
export type SourceOperation = 'enabled' | 'paused'
export type SourceGovernance = 'allowed' | 'quarantined' | 'blocked'
export type FederationStatus = 'pending' | 'approved'
export type SourceSubscriptionState = 'active' | 'pending' | 'pending_review'
// TS enum narrowed to V1's emitters; the SQL CHECK keeps all nine foundation
// values (rev 5, V4 §10 pin). V3/V4 re-add the deferred members.
export type AuditCategory =
  | 'spam' | 'abuse' | 'illegal_content' | 'compromised_source'
  | 'operator_policy' | 'other'

export interface RemoteSource {
  id: string
  canonicalUrl: string
  attributionMode: AttributionMode
  operation: SourceOperation
  governance: SourceGovernance
  provenance: 'user_subscription' | 'opml' | 'admin_federation' | 'origin_verification' | 'migration'
  provenanceNote: string | null
  adminRetained: boolean
  createdAt: string
}
export interface FederationRelationship {
  sourceId: string
  status: FederationStatus
  provenanceNote: string | null
  createdAt: string
  updatedAt: string
}
export interface SourceSubscription {
  id: string
  ownerId: string
  sourceId: string
  state: SourceSubscriptionState
  createdAt: string
}
export interface CommandEnvelope {
  // TS narrowed for V1; the SQL CHECK keeps 'ops' (rev 5, V4 §10 pin)
  actorScope: 'owner' | 'administrator' | 'system'
  actorId: string
  commandId: string
  requestFingerprint: string
}
export interface SourceAuditEvent {
  id: string
  sourceId: string
  commandId: string
  actorId: string | null
  // TS narrowed for V1; the SQL CHECK keeps 'operator_token' (rev 5, V4 §10 pin)
  actorKind: 'administrator' | 'system'
  action: string
  category: AuditCategory | null
  note: string | null
  resultJson: string
  createdAt: string
}
export interface OwnerSourceFollow {
  sourceId: string
  url: string
  attributionMode: AttributionMode
  subscriptionState: SourceSubscriptionState
  availability: 'available' | 'awaiting_review' | 'unavailable'
}
export interface PublicLocalFollow {
  kind: 'local'
  id: string
  handle: string
  displayName: string
}
export interface PublicSourceFollow {
  kind: 'source'
  sourceId: string
  url: string
  displayName: string
}
export type PublicFollowingEntry = PublicLocalFollow | PublicSourceFollow
export interface OwnerFollowingView {
  localFollows: PublicLocalFollow[]
  sourceSubscriptions: OwnerSourceFollow[]
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface SourceSummary {
  source: RemoteSource
  federationStatus: 'none' | FederationStatus
  subscriptionCounts: { active: number; pending: number; pendingReview: number }
}
export interface SourceDetail extends SourceSummary {
  latestAudit: SourceAuditEvent | null
}
export type SourceTransitionResult =
  | {kind:'applied'; source:RemoteSource; audit:SourceAuditEvent}
  | {kind:'unknown'|'conflict'}
