// Browser-safe mirror of Core's logical-v2 wire contracts (spec §3.4-3.6, §5).
// PURE — no `$env`, no fetch — so both the server client (logical-api.ts) and the
// client reducer (logical-live.ts) can import it. Every v2 JSON envelope and
// stream event carries `model: 'logical-v2'`; Web VALIDATES each one here and
// FAILS CLOSED on a mismatch (spec §5.6 carve 2) rather than casting to v1.

import type { TimelineEntry } from './types.ts'

// --- Wire DTOs (verbatim from core/src/logical/types.ts) ---------------------

export type SelectedAuthor =
	| { kind: 'local'; id: string; handle: string; displayName: string }
	| {
			kind: 'remote_publisher'
			id: string
			displayName: string
			canonicalFeedUrl: string | null
			profileAvailable: boolean
			attributionLevel: 'bound_single_publisher' | 'aggregate_assertion' | 'source_scoped_fallback'
	  }

export type ReplyContextDto = { kind: 'asserted_external'; authorLabel: string | null; snippet: string | null; url: string | null }

export type EnclosureDto = { url: string; mimeType: string | null; title: string | null; sizeBytes: number | null; durationSeconds: number | null }

export type LogicalItemDto = {
	kind: 'logical_item'
	id: string
	origin: 'local' | 'remote'
	parentResolutionState: 'none' | 'missing' | 'ambiguous' | 'resolved'
	parentLogicalItemId: string | null
	threadRootId: string | null
	selectedAuthor: SelectedAuthor
	title: string | null
	content: string | null
	contentMarkdown: string | null
	permalink: string | null
	sourceLink: string | null
	replyContext: ReplyContextDto | null
	enclosures: EnclosureDto[]
	publishedAt: string
	updatedAt: string | null
	updatedAtProvenance: 'explicit' | 'arrival' | 'legacy_unknown' | null
	directReplyCount: number
	conversationReplyCount: number
	classification: { personal: boolean; federated: boolean }
}

export type PublicLocalAccount = { id: string; handle: string; displayName: string }
export type PublicPublisher = { id: string; displayName: string; canonicalFeedUrl: string; identityLevel: 'feed_anchored' }

export type TimelineLens =
	| { kind: 'public' }
	| { kind: 'local' }
	| { kind: 'personal'; account: PublicLocalAccount }
	| { kind: 'local_author'; account: PublicLocalAccount }
	| { kind: 'publisher'; publisher: PublicPublisher }
	| { kind: 'federated' }

export type LogicalTimelineEnvelope = { model: 'logical-v2'; lens: TimelineLens; timeline: LogicalItemDto[]; nextCursor: string | null; journalCursor: string }
export type LogicalSingleItemEnvelope = { model: 'logical-v2'; item: LogicalItemDto; journalCursor: string }

export type ThreadNode =
	| { kind: 'item'; item: LogicalItemDto }
	| { kind: 'placeholder'; logicalItemId: string; parentLogicalItemId: string | null; timelineSortAt: string; placeholderKind: 'unavailable' }
export type LogicalThreadEnvelope = {
	model: 'logical-v2'
	requestedLogicalItemId: string
	rootId: string | null
	nodes: ThreadNode[]
	truncated: { depth: boolean; nodes: boolean; cycle: boolean }
	journalCursor: string
}

export type LogicalHistoryEntry = {
	sequence: number
	title: string | null
	content: string | null
	markdown: string | null
	permalink: string | null
	enclosures: EnclosureDto[]
	updatedAt: string | null
	updatedAtProvenance: 'explicit' | 'arrival' | 'legacy_unknown' | null
	current: boolean
}
export type LogicalHistoryEnvelope = { model: 'logical-v2'; logicalItemId: string; origin: 'local' | 'remote'; entries: LogicalHistoryEntry[]; currentSequence: number; journalCursor: string }

export type ReplyCountOverlay = { rootLogicalItemId: string; rootConversationReplyCount: number }
export type LogicalV2StreamEvent =
	| { model: 'logical-v2'; kind: 'upsert'; logicalItemId: string; item: LogicalItemDto; replyCounts?: ReplyCountOverlay }
	| { model: 'logical-v2'; kind: 'remove'; logicalItemId: string; replyCounts?: ReplyCountOverlay }
	| { model: 'logical-v2'; kind: 'reset' }

// --- V3 admin review DTOs (verbatim from core/src/logical/types.ts) ----------
// The bounded evidence-review surface behind GET /admin/items/:id and the
// source→items / tombstone reads. Admin-only, same-origin envelopes: the client
// (logical-api.ts) CASTS these — NOT fail-closed-validated like the ordinary read
// envelopes above — because raw evidence is rendered as ESCAPED TEXT (Svelte
// default `{expr}`), never {@html}, never routed through the sanitizer. These
// live here (pure, browser-safe) so the item-review component can `import type`
// them without pulling $env into the browser bundle.

export type AttributionLevel = 'verified_origin' | 'bound_single_publisher' | 'aggregate_assertion' | 'source_scoped_fallback'

// V3's AuditCategory (core/src/domain/types.ts) — the eight moderation values that
// back the required category <select> on the hide/restore/purge/unblock forms.
export type AuditCategory = 'spam' | 'abuse' | 'illegal_content' | 'compromised_source' | 'operator_policy' | 'false_positive' | 'remediated' | 'other'
export const AUDIT_CATEGORIES: AuditCategory[] = ['spam', 'abuse', 'illegal_content', 'compromised_source', 'operator_policy', 'false_positive', 'remediated', 'other']

export type AdminVersionRow = { observationVersionId: string; arrivalAt: string; wireOrdinal: number; fingerprint: string; rawEvidence: string }
export type AdminDeliveryRow = { deliveryId: string; sourceId: string; eligible: boolean; keyKind: string; key: string; firstSeenAt: string; versions: AdminVersionRow[] }
export type AdminClaimRow = { claimId: string; evidenceLevel: AttributionLevel; publisherId: string; firstSeenAt: string; observationVersionId: string; conflictIds: string[] }
export type AdminConflictRow = { conflictId: string; kind: string; disputed: string; logicalItemId: string | null; observationVersionId: string | null; createdAt: string }
export type AdminItemVerification = { publisherFeedUrl: string; state: 'pending' | 'verified' | 'unverified'; attempts: number; lastCheckedAt: string | null }
export type AdminItemDetail = {
	model: 'logical-v2'
	logicalItemId: string
	origin: 'local' | 'remote'
	state: 'ordinary' | 'hidden' | 'unsupported' | 'structural_tombstone' | 'deleted_local'
	hiddenAt: string | null
	selected: { deliveryId: string | null; publisherId: string | null; attributionLevel: AttributionLevel | null }
	parentLogicalItemId: string | null
	threadRootId: string | null
	counts: { deliveries: number; versions: number; claims: number; conflicts: number; audit: number }
	deliveries: AdminDeliveryRow[]
	claims: AdminClaimRow[]
	conflicts: AdminConflictRow[]
	verification: AdminItemVerification[]
}
export type AdminSourceItemRow = { logicalItemId: string; state: AdminItemDetail['state']; timelineSortAt: string; hiddenAt: string | null }
export type ItemAuditEvent = { id: string; logicalItemId: string; commandId: string; actorId: string | null; actorKind: 'administrator' | 'system'; action: string; category: AuditCategory | null; note: string | null; resultJson: string; createdAt: string }
export type TombstoneView = { id: string; canonicalUrl: string; action: 'block' | 'purge'; category: AuditCategory; note: string | null; createdAt: string; aliases: string[] }

// --- Fail-closed validation --------------------------------------------------

// A v2 payload arrived that Core said would be logical-v2 but does not match the
// frozen shape. Distinct from a network/degrade error: callers translate this
// into a fail-closed page/stream close, NEVER a v1 fallback (spec §5.6 carve 2).
export class LogicalContractError extends Error {
	constructor(what: string) {
		super(`logical-v2 contract violation: ${what}`)
		this.name = 'LogicalContractError'
	}
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const isV2 = (x: unknown): x is Record<string, unknown> => isObj(x) && x.model === 'logical-v2'

function isLogicalItem(x: unknown): x is LogicalItemDto {
	if (!isObj(x)) return false
	return (
		x.kind === 'logical_item' &&
		typeof x.id === 'string' &&
		(x.origin === 'local' || x.origin === 'remote') &&
		isObj(x.selectedAuthor) &&
		typeof x.publishedAt === 'string' &&
		typeof x.conversationReplyCount === 'number' &&
		isObj(x.classification)
	)
}

export function asLogicalTimeline(x: unknown): LogicalTimelineEnvelope {
	if (!isV2(x)) throw new LogicalContractError('timeline model')
	if (!Array.isArray(x.timeline) || typeof x.journalCursor !== 'string' || !isObj(x.lens)) throw new LogicalContractError('timeline shape')
	if (!x.timeline.every(isLogicalItem)) throw new LogicalContractError('timeline item')
	return x as unknown as LogicalTimelineEnvelope
}

export function asLogicalSingleItem(x: unknown): LogicalSingleItemEnvelope {
	if (!isV2(x)) throw new LogicalContractError('single-item model')
	if (!isLogicalItem(x.item) || typeof x.journalCursor !== 'string') throw new LogicalContractError('single-item shape')
	return x as unknown as LogicalSingleItemEnvelope
}

export function asLogicalThread(x: unknown): LogicalThreadEnvelope {
	if (!isV2(x)) throw new LogicalContractError('thread model')
	if (!Array.isArray(x.nodes)) throw new LogicalContractError('thread shape')
	for (const n of x.nodes) {
		if (!isObj(n)) throw new LogicalContractError('thread node')
		if (n.kind === 'item' && !isLogicalItem(n.item)) throw new LogicalContractError('thread item node')
		if (n.kind !== 'item' && n.kind !== 'placeholder') throw new LogicalContractError('thread node kind')
	}
	return x as unknown as LogicalThreadEnvelope
}

export function asLogicalHistory(x: unknown): LogicalHistoryEnvelope {
	if (!isV2(x)) throw new LogicalContractError('history model')
	if (!Array.isArray(x.entries) || typeof x.logicalItemId !== 'string') throw new LogicalContractError('history shape')
	return x as unknown as LogicalHistoryEnvelope
}

export function asStreamEvent(x: unknown): LogicalV2StreamEvent {
	if (!isV2(x)) throw new LogicalContractError('stream model')
	if (x.kind !== 'upsert' && x.kind !== 'remove' && x.kind !== 'reset') throw new LogicalContractError('stream kind')
	if (x.kind === 'upsert' && !isLogicalItem(x.item)) throw new LogicalContractError('stream upsert item')
	return x as unknown as LogicalV2StreamEvent
}

// --- Adapter: LogicalItemDto → the existing render shape ----------------------
// One adapter so every existing TimelineEntry component renders v2 items
// unchanged (the reuse rung). `publisherId` (an optional field on TimelineEntry)
// is set only for a navigable remote publisher, so a byline can link /p/:id
// instead of /u.

// v2 entries carry the bounded enclosure list (audio/video/image attachments,
// MASTER.md "text first, enclosures second"); v1 entries never had it, so the
// field is optional and the attachment block simply doesn't render for them.
export type RenderEntry = TimelineEntry & { enclosures?: EnclosureDto[] }

export function logicalToEntry(dto: LogicalItemDto): RenderEntry {
	const a = dto.selectedAuthor
	const resolved = dto.parentResolutionState === 'resolved'
	const author: TimelineEntry['author'] =
		a.kind === 'local'
			? { id: a.id, handle: a.handle, displayName: a.displayName, kind: 'local' }
			: { id: a.id, handle: '', displayName: a.displayName, kind: 'remote', feedUrl: a.canonicalFeedUrl, feedType: null }
	return {
		id: dto.id,
		title: dto.title,
		// render.ts derives HTML: markdown → local content → remote content, then
		// ALWAYS sanitizes. No second sanitizer path is introduced.
		content: dto.content ?? dto.contentMarkdown ?? '',
		contentMarkdown: dto.contentMarkdown,
		url: dto.sourceLink,
		publishedAt: dto.publishedAt,
		source: dto.origin,
		author,
		inReplyTo: dto.replyContext?.url ?? null,
		inReplyToPostId: resolved ? dto.parentLogicalItemId : null,
		replyContextAuthor: dto.replyContext?.authorLabel ?? null,
		replyContextSnippet: dto.replyContext?.snippet ?? null,
		threadRootId: dto.threadRootId,
		replyCount: dto.conversationReplyCount,
		sourceName: null,
		sourceFeedUrl: a.kind === 'remote_publisher' ? a.canonicalFeedUrl : null,
		editedAt: dto.updatedAt,
		publisherId: a.kind === 'remote_publisher' && a.profileAvailable ? a.id : undefined,
		// Carried through for the live lens (D2/D3): the federated/personal tabs
		// filter on this, since a v2 upsert never sets the v1 fields they keyed off.
		classification: dto.classification,
		enclosures: dto.enclosures
	}
}

// A placeholder thread node (an unavailable/tombstoned ancestor, spec §3.6) →
// a neutral marker entry (D11). It carries only what the flat tree needs: its
// own id, its parent id (so it nests under its parent / is found as the root),
// and the sort key. `placeholder: true` tells ReplyTree / the thread page to
// render a connective marker, never a card — so there is no author, content,
// or {@html} on it. Dropping these (the old bug) made every reply below an
// unavailable ancestor unreachable, and a placeholder ROOT falsely empty.
export function placeholderToEntry(node: Extract<ThreadNode, { kind: 'placeholder' }>): RenderEntry {
	return {
		id: node.logicalItemId,
		title: null,
		content: '',
		url: null,
		publishedAt: node.timelineSortAt,
		source: 'remote',
		author: { id: '', handle: '', displayName: '', kind: 'remote' },
		inReplyToPostId: node.parentLogicalItemId,
		threadRootId: null,
		placeholder: true
	}
}
