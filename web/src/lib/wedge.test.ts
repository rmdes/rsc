import { test, expect } from 'vitest'
import { childrenOf } from './wedge'
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
