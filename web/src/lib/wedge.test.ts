import { test, expect } from 'vitest'
import { childrenOf, subtreeIds, hiddenIds } from './wedge'
import type { TimelineEntry } from './types'

const entry = (id: string, parent: string | null): TimelineEntry => ({
	id,
	title: null,
	content: id,
	url: null,
	publishedAt: '',
	source: 'local',
	inReplyToPostId: parent,
	author: { id: 'a', handle: 'a', displayName: 'A', kind: 'local' }
})

const thread = [entry('root', null), entry('r1', 'root'), entry('r2', 'root'), entry('rr', 'r1')]

test('childrenOf returns direct children only', () => {
	expect(childrenOf(thread, 'root').map((e) => e.id)).toEqual(['r1', 'r2'])
	expect(childrenOf(thread, 'r1').map((e) => e.id)).toEqual(['rr'])
	expect(childrenOf(thread, 'rr')).toEqual([])
})

test('subtreeIds collects all descendants, not the root itself', () => {
	expect(subtreeIds(thread, 'root')).toEqual(new Set(['r1', 'r2', 'rr']))
	expect(subtreeIds(thread, 'r1')).toEqual(new Set(['rr']))
	expect(subtreeIds(thread, 'rr')).toEqual(new Set())
})

test('subtreeIds tolerates a cycle without hanging', () => {
	const cyc = [entry('x', 'y'), entry('y', 'x')]
	expect(subtreeIds(cyc, 'x')).toEqual(new Set(['y', 'x']))
})

test('hiddenIds unions open wedges; folding one returns its subtree', () => {
	const open: Record<string, TimelineEntry[]> = { root: thread }
	expect(hiddenIds(open)).toEqual(new Set(['r1', 'r2', 'rr']))
	expect(hiddenIds({})).toEqual(new Set())
})
