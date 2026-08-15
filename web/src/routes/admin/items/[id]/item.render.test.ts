import { test, expect, vi } from 'vitest'
import { render } from 'svelte/server'
import type { AdminItemDetail } from '$lib/logical-types'

// use:enhance from $app/forms — same test-only stub pattern as the home/thread
// page render tests (SSR never runs the client action, but the module-level
// import still needs to resolve).
vi.mock('$app/forms', () => ({ enhance: () => ({}) }))

const { default: Page } = await import('./+page.svelte')

const detail = (over: Partial<AdminItemDetail> = {}): AdminItemDetail => ({
	model: 'logical-v2',
	logicalItemId: 'p1',
	origin: 'local',
	state: 'ordinary',
	hiddenAt: null,
	selected: { deliveryId: null, publisherId: null, attributionLevel: null },
	parentLogicalItemId: null,
	threadRootId: null,
	counts: { deliveries: 0, claims: 0, conflicts: 0, audit: 0 },
	deliveries: [],
	claims: [],
	conflicts: [],
	verification: [],
	...over
})

const baseData = (over: Record<string, unknown> = {}) => ({
	id: 'p1',
	detail: detail(),
	audit: [],
	auditNextCursor: null,
	categories: ['spam', 'abuse', 'illegal_content', 'compromised_source', 'operator_policy', 'false_positive', 'remediated', 'other'],
	hideCommandId: 'cmd-hide',
	restoreCommandId: 'cmd-restore',
	...over
})

// Re-review finding 2: nothing asserted the moderation category <select>
// renders on the admin item-review Remove form either — deleting it would
// leave the suite green while every admin removal 400s (core's
// DELETE /admin/posts/:id requires {category, note?}).
test('a local item shows a Remove form with a category select', () => {
	const data = baseData({ detail: detail({ origin: 'local' }) })
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).toContain('id="remove-cat"')
	expect(body).toContain('name="category"')
})

test('a remote item has no Remove form at all (core refuses non-local removal)', () => {
	const data = baseData({ detail: detail({ origin: 'remote' }) })
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).not.toContain('id="remove-cat"')
	expect(body).not.toContain('action="?/remove"')
})
