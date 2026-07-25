import { test, expect, vi } from 'vitest'
import { render } from 'svelte/server'
import type { TimelineEntry } from '$lib/types'

// SvelteKit virtual modules the page's import graph pulls in (ThemeToggle →
// $app/environment, the reply form → $app/forms). Test-only stubs, not deps.
vi.mock('$app/environment', () => ({ browser: false }))
vi.mock('$app/forms', () => ({ enhance: () => ({}) }))

const { default: Page } = await import('./+page.svelte')

// D11: a thread whose ROOT is an unavailable ancestor (a placeholder) must
// still render its live replies under a neutral marker — NOT fall through to
// "No such conversation." over a conversation that plainly has replies.

const card = (over: Partial<TimelineEntry> & { contentHtml?: string } = {}): TimelineEntry & { contentHtml?: string } => ({
	id: 'r1',
	title: null,
	content: 'reply text',
	contentHtml: '<p>reply text</p>',
	url: null,
	publishedAt: '2026-07-20T00:00:00.000Z',
	source: 'local',
	author: { id: 'u1', handle: 'alice', displayName: 'Alice', kind: 'local' },
	inReplyToPostId: 'gap',
	...over
})

const placeholder = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
	id: 'gap',
	title: null,
	content: '',
	url: null,
	publishedAt: '2026-07-19T00:00:00.000Z',
	source: 'remote',
	author: { id: '', handle: '', displayName: '', kind: 'remote' },
	inReplyToPostId: null,
	placeholder: true,
	...over
})

test('a placeholder ROOT renders the marker + live replies, not "No such conversation."', () => {
	const data = { postId: 'gap', thread: [placeholder(), card()], rootId: 'gap', sourceModelV2: true, coreDown: false }
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).not.toContain('No such conversation.')
	expect(body).toContain('Post unavailable') // the root marker
	expect(body).toContain('reply text') // the live reply under it
})

test('a genuinely empty thread (no nodes) still shows "No such conversation."', () => {
	const data = { postId: 'x', thread: [] as TimelineEntry[], rootId: 'x', sourceModelV2: true, coreDown: false }
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).toContain('No such conversation.')
})
