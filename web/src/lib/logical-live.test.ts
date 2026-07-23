import { describe, it, expect } from 'vitest'
import { applyLiveEvent, insertSorted, type LiveState } from './logical-live.ts'
import type { TimelineEntry } from './types.ts'

// Minimal render entry with a sort key (publishedAt drives immutable order).
const e = (id: string, publishedAt: string, over: Partial<TimelineEntry> = {}): TimelineEntry =>
	({ id, content: 'c', publishedAt, source: 'local', author: { id: 'u', handle: 'u', displayName: 'U', kind: 'local' } , ...over }) as TimelineEntry

const upsert = (entry: TimelineEntry, over = {}) => ({ kind: 'upsert' as const, entry, ...over })
const remove = (id: string, over = {}) => ({ kind: 'remove' as const, id, ...over })
const empty = (): LiveState => ({ live: [], edited: {}, removed: new Set<string>() })
const ctx = (posts: TimelineEntry[], keep = true) => ({ posts, pageIds: new Set(posts.map((p) => p.id)), keep })

describe('insertSorted keeps immutable (publishedAt DESC, id DESC) order — never blindly prepends', () => {
	it('places a middle item in its chronological slot, not at the top', () => {
		const list = [e('a', '2026-07-20T03:00:00Z'), e('c', '2026-07-20T01:00:00Z')]
		const out = insertSorted(list, e('b', '2026-07-20T02:00:00Z'))
		expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c'])
	})
	it('ties break by id DESC', () => {
		const out = insertSorted([e('a', 't')], e('b', 't'))
		expect(out.map((p) => p.id)).toEqual(['b', 'a'])
	})
})

describe('applyLiveEvent — upsert on a river lens', () => {
	it('a new root that the lens keeps is inserted at immutable order', () => {
		const state: LiveState = { live: [e('new', '2026-07-20T05:00:00Z')], edited: {}, removed: new Set() }
		const r = applyLiveEvent(state, upsert(e('mid', '2026-07-20T04:00:00Z')), ctx([], true))
		expect(r.live.map((p) => p.id)).toEqual(['new', 'mid'])
	})
	it('a root the lens drops is not inserted', () => {
		const r = applyLiveEvent(empty(), upsert(e('n', 't')), ctx([], false))
		expect(r.live).toEqual([])
	})
	it('an upsert for an already-loaded id replaces in place (edited), never a second card', () => {
		const r = applyLiveEvent(empty(), upsert(e('root', 't', { title: 'new' })), ctx([e('root', 't')], true))
		expect(r.live).toEqual([])
		expect(r.edited.root.title).toBe('new')
	})
})

describe('applyLiveEvent — river reply exclusion + the replyCounts overlay', () => {
	const roots = [e('root', 't', { replyCount: 1 })]
	const reply = (over = {}) => e('rep', 't2', { inReplyToPostId: 'root', threadRootId: 'root', ...over })

	it('a resolved-reply upsert never inserts a card and never materializes an off-page parent', () => {
		const r = applyLiveEvent(empty(), upsert(reply(), { rootReplyCount: 3, threadRootId: 'root' }), ctx(roots))
		expect(r.live).toEqual([])
		expect(r.edited.rep).toBeUndefined()
		expect(r.edited.root.replyCount).toBe(3)
	})
	it('replaces the loaded root count authoritatively — applying twice is idempotent', () => {
		const ev = upsert(reply(), { rootReplyCount: 3, threadRootId: 'root' })
		const once = applyLiveEvent(empty(), ev, ctx(roots))
		const twice = applyLiveEvent(once, ev, ctx(roots.map((p) => once.edited[p.id] ?? p)))
		expect(twice.edited.root.replyCount).toBe(3)
		expect(twice.live).toEqual([])
	})
	it('rootReplyCount 0 is a legitimate total', () => {
		const r = applyLiveEvent(empty(), upsert(reply(), { rootReplyCount: 0, threadRootId: 'root' }), ctx(roots))
		expect(r.edited.root.replyCount).toBe(0)
	})
	it('a resolved reply whose root is off-page does nothing (never materializes the root)', () => {
		const r = applyLiveEvent(empty(), upsert(reply(), { rootReplyCount: 3, threadRootId: 'elsewhere' }), ctx(roots))
		expect(r.edited).toEqual({})
		expect(r.live).toEqual([])
	})
	it('a resolved-reply upsert with no overlay does nothing at all (no card, no count change)', () => {
		const r = applyLiveEvent(empty(), upsert(reply()), ctx(roots))
		expect(r.live).toEqual([])
		expect(r.edited).toEqual({})
	})
})

describe('applyLiveEvent — remove passthrough', () => {
	it('remove deletes a live-prepended card', () => {
		const state: LiveState = { live: [e('x', 't')], edited: { x: e('x', 't', { title: 'z' }) }, removed: new Set() }
		const r = applyLiveEvent(state, remove('x'), ctx([]))
		expect(r.live.map((p) => p.id)).toEqual([])
		expect(r.edited.x).toBeUndefined()
		expect(r.removed.has('x')).toBe(true)
	})
	it('remove of a server-rendered (page) id is recorded so the view can hide it', () => {
		const r = applyLiveEvent(empty(), remove('page1'), ctx([e('page1', 't')]))
		expect(r.removed.has('page1')).toBe(true)
	})
	it('remove carrying a replyCounts overlay updates a loaded root and does not itself add a card', () => {
		const roots = [e('root', 't', { replyCount: 5 })]
		const r = applyLiveEvent({ live: [], edited: {}, removed: new Set() }, remove('rep', { rootReplyCount: 4, threadRootId: 'root' }), ctx(roots))
		expect(r.edited.root.replyCount).toBe(4)
		expect(r.removed.has('rep')).toBe(true)
	})
})
