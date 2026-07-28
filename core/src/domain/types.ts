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

export interface NewLocalUser { handle: string; displayName: string; authUserId?: string }
export interface NewRemoteUser { handle: string; displayName: string; feedUrl: string; feedType?: FeedType }
// rootReplyCount is transient SSE timeline metadata (spec §Live updates): the
// authoritative whole-conversation total for a newly-serialized resolved
// reply, added only by the SSE route. It is never stored and never present on
// roots, unresolved replies, or edits.
export type TimelineEntry = Post & { author: User; rootReplyCount?: number }

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

// --- v2 source-control plane ---

export type AttributionMode = 'single_publisher' | 'aggregate'
export type SourceOperation = 'enabled' | 'paused'
export type SourceGovernance = 'allowed' | 'quarantined' | 'blocked'
export type FederationStatus = 'pending' | 'approved'
export type SourceSubscriptionState = 'active' | 'pending' | 'pending_review'
// TS enum narrowed to each vertical's actual emitters; the SQL CHECKs keep all
// nine foundation values (rev 5, V4 §10 pin). V3 re-adds 'false_positive'
// (restore's first emitter) and 'remediated' (tombstone unblock's first
// emitter). V4 re-adds the last one, 'migration_review' — first emitted by the
// legacy conversion.
export type AuditCategory =
  | 'spam' | 'abuse' | 'illegal_content' | 'compromised_source'
  | 'migration_review' | 'operator_policy' | 'false_positive' | 'remediated' | 'other'

export interface RemoteSource {
  id: string
  canonicalUrl: string
  attributionMode: AttributionMode
  operation: SourceOperation
  governance: SourceGovernance
  provenance: 'user_subscription' | 'opml' | 'admin_federation' | 'origin_verification' | 'migration'
  provenanceNote: string | null
  adminRetained: boolean
  overridden: boolean
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
  // V4 re-adds 'ops' (the operator-token federation route), matching the CHECK
  actorScope: 'owner' | 'administrator' | 'ops' | 'system'
  actorId: string
  commandId: string
  requestFingerprint: string
}
export interface SourceAuditEvent {
  id: string
  sourceId: string
  commandId: string
  actorId: string | null
  // V4 re-adds 'operator_token', matching the CHECK
  actorKind: 'administrator' | 'operator_token' | 'system'
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
  // V1-deferred, first written here. Null throughout while the v2 push tables
  // are empty; the lease itself lands in V4 Task 2/3.
  push: PushSummary
  retention: 'verified_origin' | 'audit_history' | 'admin_retained' | 'reapable' | null
  addedBy: { handle: string; displayName: string }[]
}
export interface PushSummary {
  mode: PushProtocol | null
  state: 'pending' | 'active' | null // two-state union (spec 1.2/1.5)
  endpointFingerprint: string | null // sha256(endpoint) first 16 hex — non-secret
}
export interface SourceDetail extends SourceSummary {
  latestAudit: SourceAuditEvent | null
  pushExpiresAt: string | null
}
export type SourceTransitionResult =
  | {kind:'applied'; source:RemoteSource; audit:SourceAuditEvent}
  | {kind:'unknown'|'conflict'}
