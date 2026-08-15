import { test, expect, vi } from 'vitest'
import { render } from 'svelte/server'
import type { TimelineEntry } from '$lib/types'

// SvelteKit virtual modules the home page's import graph pulls in ($effect's
// SSE stream never runs during SSR, but the module-level imports still need
// to resolve). Test-only stubs, not deps — same pattern as thread.render.test.ts.
vi.mock('$app/environment', () => ({ browser: false }))
vi.mock('$app/forms', () => ({ enhance: () => ({}) }))
vi.mock('$app/navigation', () => ({ invalidateAll: () => {} }))

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
	timeline: [post()],
	nextCursor: null,
	isFirstPage: true,
	peers: [],
	tab: 'local',
	tabLabels: { local: 'Local' },
	tabSubtitles: { local: 'local posts' },
	coreDown: false,
	...over
})

// Finding 3: Edit loads the composer prefilled with the removal notice, then
// 403s on submit (editLocalPost's PostRemovedError guard) — a dead end that
// should never be offered in the first place.
test('Edit is absent on a removed post owned by the viewer', () => {
	const removed = post({ removed: true })
	const data = baseData({ timeline: [removed], me: { user: removed.author, isAnonymous: false } })
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).not.toContain('/post/p1/edit')
})

test('Edit is present for an ordinary (not removed) post owned by the viewer', () => {
	const ordinary = post()
	const data = baseData({ timeline: [ordinary], me: { user: ordinary.author, isAnonymous: false } })
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).toContain('/post/p1/edit')
})
