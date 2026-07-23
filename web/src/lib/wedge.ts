import type { TimelineEntry } from './types'

// Direct children of a post within a flat thread (resolved parent ids only).
export function childrenOf(thread: TimelineEntry[], parentId: string): TimelineEntry[] {
	return thread.filter((e) => e.inReplyToPostId === parentId)
}

export async function fetchThread(id: string): Promise<TimelineEntry[]> {
	const res = await fetch(`/post/${encodeURIComponent(id)}/thread.json`)
	if (!res.ok) throw new Error(`thread ${res.status}`)
	return (await res.json()).thread
}
