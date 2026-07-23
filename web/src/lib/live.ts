import type { TimelineEntry } from './types.ts'

// One rule for both new posts and edits arriving over SSE: if we already show
// this id (live-prepended OR server-rendered on the page), overlay the fresh
// copy (an edit → swap in place). Otherwise it's new → prepend.
export function mergeIncoming(
	live: TimelineEntry[],
	edited: Record<string, TimelineEntry>,
	entry: TimelineEntry,
	pageIds: Set<string>
): { live: TimelineEntry[]; edited: Record<string, TimelineEntry> } {
	if (pageIds.has(entry.id) || live.some((p) => p.id === entry.id)) {
		return { live, edited: { ...edited, [entry.id]: entry } }
	}
	// Unknown id + editedAt set: an edit to a post off this page — drop it
	// rather than bumping a stale post to the top of the live feed.
	if (entry.editedAt) return { live, edited }
	return { live: [entry, ...live], edited }
}

// Replace a VISIBLE root's reply count with the server's total. The count is
// authoritative — never incremented, never decremented, so replaying the same
// frame lands on the same number. A root that isn't a loaded card is left
// alone: an off-page parent is never materialized out of a reply frame.
export function overlayVisibleRootCount(
	edited: Record<string, TimelineEntry>,
	posts: TimelineEntry[],
	rootId: string,
	count: number
): Record<string, TimelineEntry> {
	const root = posts.find((p) => p.id === rootId)
	return root ? { ...edited, [rootId]: { ...root, replyCount: count } } : edited
}

export type RiverState = { live: TimelineEntry[]; edited: Record<string, TimelineEntry> }

// One SSE frame → new river state, for the root-only rivers (home, following).
// A resolved reply is never a card here: it only ever refreshes a visible
// root's count, and only when the server sent BOTH the total and the root id.
// `rootReplyCount !== undefined` rather than a truthy test on purpose —
// threadRootId rides along on every resolved reply including ones whose count
// enrichment failed, and 0 is a legitimate total. The reply branch runs BEFORE
// the lens so a dropped-by-lens frame can still correct a visible count, and
// nothing on that branch reaches mergeIncoming or an expanded thread
// (expanded threads are snapshot-only; reload repairs).
export function applyRiverEvent(
	state: RiverState,
	entry: TimelineEntry,
	ctx: { posts: TimelineEntry[]; pageIds: Set<string>; keep: boolean }
): RiverState {
	if (entry.inReplyToPostId) {
		const { rootReplyCount, threadRootId } = entry
		if (rootReplyCount === undefined || !threadRootId) return state
		return { live: state.live, edited: overlayVisibleRootCount(state.edited, ctx.posts, threadRootId, rootReplyCount) }
	}
	if (!ctx.keep) return state
	return mergeIncoming(state.live, state.edited, entry, ctx.pageIds)
}
