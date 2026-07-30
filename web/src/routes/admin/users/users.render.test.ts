import { test, expect, vi } from 'vitest'
import { render } from 'svelte/server'

vi.mock('$app/forms', () => ({ enhance: () => ({}) }))

const { default: Page } = await import('./+page.svelte')

function baseData(over: Record<string, unknown> = {}) {
	return {
		users: [{ handle: 'alice', kind: 'local', displayName: 'Alice', emailVerified: true, createdAt: '2026-01-01T00:00:00Z', feedUrl: null }],
		cursor: null,
		nextCursor: null,
		...over
	}
}

test('a local user delete form renders a collapsed confirm-gate with the destructive consequence', () => {
	const { body } = render(Page, { props: { data: baseData(), form: null } } as never)
	const detailsChunk = body.slice(body.indexOf('class="confirm-gate'), body.indexOf('</details>', body.indexOf('class="confirm-gate')) + '</details>'.length)
	expect(detailsChunk).toContain('Delete @alice and all their posts')
	expect(detailsChunk).toContain('Confirm delete')
})

test('a remote user renders no delete affordance at all', () => {
	const { body } = render(Page, { props: { data: baseData({ users: [{ handle: 'bob', kind: 'remote', displayName: 'Bob', emailVerified: null, createdAt: '2026-01-01T00:00:00Z', feedUrl: 'https://bob.example/feed.xml' }] }), form: null } } as never)
	expect(body).not.toContain('confirm-gate')
	expect(body).toContain('—') // the em-dash placeholder for a non-local row's Action cell
})
