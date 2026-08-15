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
	// v2 only: set for a navigable remote publisher so bylines link /p/:id instead
	// of /u (which stays local-account only). Undefined on every v1 entry.
	publisherId?: string
	// The server-computed tab membership (spec §3.4) — the live lens (keepEvent)
	// keys off this alone; a followed remote publisher carries no local user id
	// to key off instead. Required in practice (the wire validator rejects any
	// envelope missing it); optional here only because placeholder thread nodes
	// (placeholderToEntry) never render through a lens.
	classification?: { personal: boolean; federated: boolean }
	// v2 thread-read only: an unavailable/tombstoned ancestor, carried through the
	// flat tree as a neutral connective marker (D11) — id + inReplyToPostId let the
	// tree nest its reply subtree; the renderer shows a marker, never a card.
	placeholder?: boolean
	// v2 local items only: true once the post's removal marker is set (Task 3).
	// Always false/undefined for a remote item — a peer's copy of a removed post
	// carries no local marker, and that's correct, not a gap. Same-origin only:
	// never mirrored into the outgoing feed (core's logicalToFeedEntry never sets
	// it). Drives two things: the reply composer is not offered, and EditedMarker
	// degrades its "edited" link to plain text instead of a 404ing one.
	removed?: boolean
}

// v2 source-registry DTOs, mirroring core's `core/src/domain/types.ts`.
// Ordinary core routes never carry governance, operation, provenance or
// retention state — so neither do these.
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
