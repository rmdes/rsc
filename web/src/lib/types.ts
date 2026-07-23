export interface TimelineEntry {
	id: string
	title: string | null
	content: string
	contentMarkdown?: string | null
	contentHtml?: string
	url: string | null
	publishedAt: string
	source: 'local' | 'remote'
	author: { id: string; handle: string; displayName: string; kind: 'local' | 'remote'; feedUrl?: string | null; feedType?: 'person' | 'webfeed' | 'instance' | null }
	inReplyTo?: string | null
	inReplyToPostId?: string | null
	replyContextAuthor?: string | null
	replyContextSnippet?: string | null
	threadRootId?: string | null
	replyCount?: number
	sourceName?: string | null
	sourceFeedUrl?: string | null
	editedAt?: string | null
	rootReplyCount?: number
}

// v2 source-registry DTOs (RSC_SOURCE_MODEL_V2), mirroring core's
// `core/src/domain/types.ts`. Ordinary core routes never carry governance,
// operation, provenance or retention state — so neither do these.
export interface OwnerSourceFollow {
	sourceId: string
	url: string
	attributionMode: 'single_publisher' | 'aggregate'
	subscriptionState: 'active' | 'pending' | 'pending_review'
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

// One row shape for the v2 following list. `pending` is the only status that
// reaches the page, and only the owner's own projection can carry it — the
// public projection core serves visitors is active-only.
export type FollowRow =
	| { kind: 'local'; id: string; handle: string; displayName: string }
	| { kind: 'source'; sourceId: string; url: string; label: string; pending: boolean; commandId: string }
