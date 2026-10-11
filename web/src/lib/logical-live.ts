// Client reconciliation for the logical-v2 durable stream (spec §5.7). PURE — the
// component owns the EventSource and the reset refetch; this file only reduces an
// event onto river state. Its root-only overlay helper keeps a resolved reply
// from ever becoming a card: it
// only ever replaces a LOADED root's authoritative conversation count.

import type { TimelineEntry } from './types.ts'

export type LiveState = { live: TimelineEntry[]; edited: Record<string, TimelineEntry>; removed: Set<string> }

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

// A stream frame translated by the proxy into render shape. `rootReplyCount` +
// `threadRootId` ride an upsert/remove whose subject is a resolved reply (the
// authoritative TOTAL); guarded with `rootReplyCount !== undefined && threadRootId`
// exactly as the root-only companion — 0 is a legitimate total, and threadRootId
// tags every resolved reply even when the count enrichment failed.
export type LiveEvent =
	| { kind: 'upsert'; entry: TimelineEntry; rootReplyCount?: number; threadRootId?: string }
	| { kind: 'remove'; id: string; rootReplyCount?: number; threadRootId?: string }

export interface LiveCtx {
	posts: TimelineEntry[] // the currently rendered pool (page ∪ live, edits applied)
	pageIds: Set<string>
	keep: boolean // does the active lens keep this subject?
}

// Immutable timeline order: (publishedAt DESC, id DESC). An upsert is placed in
// its chronological slot, never blindly prepended (spec §5.7).
export function insertSorted(list: TimelineEntry[], entry: TimelineEntry): TimelineEntry[] {
	const before = (a: TimelineEntry, b: TimelineEntry) => (a.publishedAt === b.publishedAt ? a.id > b.id : a.publishedAt > b.publishedAt)
	const out = list.filter((p) => p.id !== entry.id)
	const at = out.findIndex((p) => before(entry, p))
	if (at === -1) out.push(entry)
	else out.splice(at, 0, entry)
	return out
}

function overlay(state: LiveState, ev: { rootReplyCount?: number; threadRootId?: string }, posts: TimelineEntry[]): Record<string, TimelineEntry> {
	if (ev.rootReplyCount === undefined || !ev.threadRootId) return state.edited
	return overlayVisibleRootCount(state.edited, posts, ev.threadRootId, ev.rootReplyCount)
}

export function applyLiveEvent(state: LiveState, ev: LiveEvent, ctx: LiveCtx): LiveState {
	if (ev.kind === 'remove') {
		const edited = overlay(state, ev, ctx.posts)
		const { [ev.id]: _gone, ...rest } = edited
		return { live: state.live.filter((p) => p.id !== ev.id), edited: rest, removed: new Set(state.removed).add(ev.id) }
	}
	// upsert. A resolved reply is never a card in a river: it only refreshes a
	// loaded root's count, and only when the total + root id both arrived. This
	// branch runs BEFORE the lens so a lens-dropped frame can still correct a
	// visible count, and it never reaches insertSorted or an expanded thread.
	if (ev.entry.inReplyToPostId) {
		return { ...state, edited: overlay(state, ev, ctx.posts) }
	}
	// A root/unresolved reply the lens keeps. Already loaded → replace in place;
	// otherwise insert at immutable order.
	if (ctx.pageIds.has(ev.entry.id) || state.live.some((p) => p.id === ev.entry.id)) {
		return { ...state, edited: { ...state.edited, [ev.entry.id]: ev.entry } }
	}
	if (!ctx.keep) return state
	return { ...state, live: insertSorted(state.live, ev.entry) }
}
