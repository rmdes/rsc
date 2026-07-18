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
