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

// .visually-hidden is `position: absolute` (app.css) — putting it ON the <th>
// itself takes that header cell out of document flow, so the header row
// contributes one fewer cell than every body row and every column below is
// misaligned. Only the LABEL TEXT may be hidden; the cell stays in flow.
test('the select column header is a real in-flow <th> with only its label visually hidden, so header and body rows have equal cell counts', () => {
	const { body } = render(Page, { props: { data: baseData(), form: null } } as never)
	expect(body).not.toContain('<th class="visually-hidden"')
	const thead = body.slice(body.indexOf('<thead'), body.indexOf('</thead>'))
	expect(thead).toContain('<span class="visually-hidden">Select</span>')
	const bodyStart = body.indexOf('<tbody')
	const firstRow = body.slice(bodyStart, body.indexOf('</tr>', bodyStart))
	// `<th[ >]` so the enclosing `<thead>` isn't counted as a cell.
	expect((thead.match(/<th[ >]/g) ?? []).length).toBe((firstRow.match(/<td[ >]/g) ?? []).length)
})

test('local user rows each have a checkbox and the page renders an always-present bulk-delete form', () => {
	const { body } = render(Page, { props: { data: baseData(), form: null } } as never)
	expect(body).toContain('action="?/bulkDelete')
	expect(body).toContain('type="checkbox"')
})

// bulkDelete answers a submit with nothing checked with an EMPTY array; the
// outcome list gates on `?.length`, so that rendered nothing at all — and with
// JS off there is no live "N selected" count to contradict it either.
test('an empty bulkDeleteResults array reports "Nothing selected." instead of rendering nothing', () => {
	const { body } = render(Page, { props: { data: baseData(), form: { bulkDeleteResults: [] } } } as never)
	expect(body).toContain('Nothing selected.')
})

test('the bulk-delete toolbar (button + confirm-gate) is always in the server output, not gated behind a JS-only selection count', () => {
	const { body } = render(Page, { props: { data: baseData(), form: null } } as never)
	const bulkFormChunk = body.slice(body.indexOf('action="?/bulkDelete'), body.indexOf('</form>', body.indexOf('action="?/bulkDelete')))
	expect(bulkFormChunk).toContain('class="confirm-gate')
	expect(bulkFormChunk).toContain('Delete selected')
	expect(bulkFormChunk).not.toContain('has-selection')
})
