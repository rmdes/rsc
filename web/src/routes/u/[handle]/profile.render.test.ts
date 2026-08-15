import { test, expect } from 'vitest'
import { render } from 'svelte/server'
import type { TimelineEntry } from '$lib/types'

const { default: Page } = await import('./+page.svelte')

const post = (over: Partial<TimelineEntry> & { contentHtml?: string } = {}): TimelineEntry & { contentHtml?: string } => ({
	id: 'p1',
	title: null,
	content: 'hello',
	contentHtml: '<p>hello</p>',
	url: null,
	publishedAt: '2026-07-20T00:00:00.000Z',
	source: 'local',
	author: { id: 'u1', handle: 'alice', displayName: 'Alice', kind: 'local' },
	...over
})

const baseData = (over: Record<string, unknown> = {}) => ({
	handle: 'alice',
	timeline: [post()],
	nextCursor: null,
	isFirstPage: true,
	...over
})

// Re-review finding: this page gated Edit on ownership alone, with no
// !post.removed check (unlike the home and thread pages) — a viewer looking
// at their own removed post on their profile was offered Edit, which loads a
// page prefilled with the removal notice and then 403s on submit.
test('Edit is absent on a removed post owned by the viewer, on the profile page', () => {
	const removed = post({ removed: true })
	const data = baseData({ timeline: [removed], me: { user: removed.author, isAnonymous: false } })
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).not.toContain('/post/p1/edit')
})

test('Edit is present for an ordinary (not removed) post owned by the viewer, on the profile page', () => {
	const ordinary = post()
	const data = baseData({ timeline: [ordinary], me: { user: ordinary.author, isAnonymous: false } })
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).toContain('/post/p1/edit')
})
