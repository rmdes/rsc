import type { TimelineEntry } from './types'

// Direct children of a post within a flat thread (resolved parent ids only).
export function childrenOf(thread: TimelineEntry[], parentId: string): TimelineEntry[] {
	return thread.filter((e) => e.inReplyToPostId === parentId)
}

// Every descendant of rootId in the thread (the ids an open wedge reveals).
export function subtreeIds(thread: TimelineEntry[], rootId: string): Set<string> {
	const out = new Set<string>()
	const walk = (id: string) => {
		for (const c of childrenOf(thread, id)) {
			if (!out.has(c.id)) {
				out.add(c.id)
				walk(c.id)
			}
		}
	}
	walk(rootId)
	return out
}

// A post never shows twice: while a wedge is open, its revealed subtree is
// hidden from the top-level timeline (and returns when the wedge folds).
export function hiddenIds(expanded: Record<string, TimelineEntry[]>): Set<string> {
	const out = new Set<string>()
	for (const [wedgeId, thread] of Object.entries(expanded)) {
		for (const id of subtreeIds(thread, wedgeId)) out.add(id)
	}
	return out
}

export async function fetchThread(id: string): Promise<TimelineEntry[]> {
	const res = await fetch(`/post/${encodeURIComponent(id)}/thread.json`)
	if (!res.ok) throw new Error(`thread ${res.status}`)
	return (await res.json()).thread
}
