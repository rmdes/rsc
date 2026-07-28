import { test, expect, vi } from 'vitest'
import { render } from 'svelte/server'

// SvelteKit virtual module the page's <form use:enhance> pulls in — a bare
// stub, not a dep (same pattern as thread.render.test.ts).
vi.mock('$app/forms', () => ({ enhance: () => ({}) }))

const { default: Page } = await import('./+page.svelte')

// C1 (whole-branch review): a nested instance-member row rendered NO Manage
// panel at all — only URL + badges + hint — so an admin had no way to
// moderate an overridden/instance-governed member through the UI, even
// though the member row's `actions` were already computed by the same
// toRow() an ordinary row uses. This proves the member <li> now renders the
// SAME Manage panel/forms, posting to the SAME `?/source` action with the
// member's own id — not a read-only view.
function baseRow(over: Record<string, unknown> = {}) {
	return {
		id: 'inst1',
		url: 'https://inst1.test/feed.xml',
		governance: 'allowed',
		operation: 'enabled',
		attributionMode: 'aggregate',
		federationStatus: 'approved',
		overridden: false,
		isInstanceMember: false,
		viaVerification: false,
		memberCounts: { members: 1, overridden: 0, instanceGoverned: 1 },
		group: 'federation',
		actions: [{ action: 'quarantine', commandId: 'inst-cmd-1' }],
		...over
	}
}

function memberRow(over: Record<string, unknown> = {}) {
	return {
		id: 'mem1',
		url: 'https://inst1.test/origin/alice.xml',
		governance: 'allowed',
		operation: 'enabled',
		attributionMode: 'single_publisher',
		federationStatus: 'none',
		overridden: false,
		isInstanceMember: true,
		viaVerification: true,
		memberCounts: undefined,
		group: 'member',
		actions: [{ action: 'quarantine', commandId: 'mem-cmd-1' }],
		...over
	}
}

test('a member row nested under ?expand= renders a Manage panel whose quarantine form posts to ?/source with the MEMBER\'s own id', () => {
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [baseRow()] }],
		expand: 'inst1',
		expandedMembers: [memberRow()],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam', 'abuse', 'illegal_content', 'compromised_source', 'operator_policy', 'other'],
		cursor: null,
		nextCursor: null,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)

	// The member got its OWN Manage summary — the exact gap C1 found.
	expect(body).toContain(`Manage ${memberRow().url}`)

	// Its quarantine form posts sourceId=mem1 (the member's id, not the
	// instance's) to the shared ?/source action.
	const memberFormChunk = body.slice(body.indexOf(`Manage ${memberRow().url}`))
	expect(memberFormChunk).toContain('action="?/source')
	expect(memberFormChunk).toContain('name="sourceId" value="mem1"')
	expect(memberFormChunk).toContain('name="action" value="quarantine"')
	expect(memberFormChunk).toContain('name="commandId" value="mem-cmd-1"')
})

test('acting on a member (?/source) carries the expand param forward so its instance stays expanded after the mutation', () => {
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [baseRow()] }],
		expand: 'inst1',
		expandedMembers: [memberRow()],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	const memberFormChunk = body.slice(body.indexOf(`Manage ${memberRow().url}`))
	// SSR HTML-escapes the attribute's literal `&` to `&amp;`.
	expect(memberFormChunk).toContain('action="?/source&amp;expand=inst1"')
})
