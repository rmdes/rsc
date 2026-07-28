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

test('a blocked member renders twice (flat + nested) with distinct DOM ids to avoid duplicate ids (N1 fix)', () => {
	// A blocked member appears in both the flat 'blocked' group and nested
	// under its instance's ?expand= expansion, both using the same Manage panel.
	// The N1 fix adds a scope discriminator to ensure the two renders produce
	// different ids.
	const blockedMember = memberRow({
		id: 'blocked-mem',
		url: 'https://inst1.test/blocked/member.xml',
		governance: 'blocked',
		isInstanceMember: true,
		group: 'blocked', // a blocked member renders in 'blocked', not 'member'
		// A blocked source has actions: pause, unblock, attribution-mode
		actions: [
			{ action: 'pause', commandId: 'pause-1' },
			{ action: 'unblock', commandId: 'unblock-1' },
			{ action: 'attribution-mode', commandId: 'attr-1' }
		]
	})
	// Create an instance that the blocked member belongs to.
	const instance = baseRow({
		id: 'inst1',
		url: 'https://inst1.test/feed.xml',
		governance: 'allowed',
		federationStatus: 'approved'
	})

	const data = {
		// Flat render: blocked member in the 'blocked' group, instance in 'federation'.
		groups: [
			{ key: 'federation', title: 'Approved federation', blurb: '', rows: [instance] },
			{ key: 'blocked', title: 'Blocked sources', blurb: '', rows: [blockedMember] }
		],
		expand: 'inst1', // instance expanded so its members show
		// Nested render: same blocked member listed under the instance.
		expandedMembers: [blockedMember],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)

	// Both renders have the same row.id='blocked-mem', but the snippet uses a scope
	// discriminator: flat render (no scope), nested render (scope='m-').
	// They generate different id/for pairs to avoid HTML validity errors.

	// Flat render ids (no scope): id="note-blocked-mem-pause", id="cat-blocked-mem-unblock", etc.
	expect(body).toContain('id="note-blocked-mem-pause"')
	expect(body).toContain('id="cat-blocked-mem-unblock"')
	expect(body).toContain('id="note-blocked-mem-unblock"')
	expect(body).toContain('id="mode-blocked-mem"')
	expect(body).toContain('id="cat-blocked-mem-attribution-mode"')
	expect(body).toContain('id="note-blocked-mem-attribution-mode"')

	// Nested render ids (scope='m-'): id="note-m-blocked-mem-pause", id="cat-m-blocked-mem-unblock", etc.
	expect(body).toContain('id="note-m-blocked-mem-pause"')
	expect(body).toContain('id="cat-m-blocked-mem-unblock"')
	expect(body).toContain('id="note-m-blocked-mem-unblock"')
	expect(body).toContain('id="mode-m-blocked-mem"')
	expect(body).toContain('id="cat-m-blocked-mem-attribution-mode"')
	expect(body).toContain('id="note-m-blocked-mem-attribution-mode"')

	// Verify corresponding <label for=> pairs exist for both flat and nested
	const flatLabelFor = [
		'for="note-blocked-mem-pause"',
		'for="cat-blocked-mem-unblock"',
		'for="note-blocked-mem-unblock"',
		'for="mode-blocked-mem"',
		'for="cat-blocked-mem-attribution-mode"',
		'for="note-blocked-mem-attribution-mode"'
	]
	const nestedLabelFor = flatLabelFor.map(f => f.replace('-blocked-mem', '-m-blocked-mem'))

	flatLabelFor.forEach((label) => expect(body).toContain(label))
	nestedLabelFor.forEach((label) => expect(body).toContain(label))
})

// The source detail page (/admin/sources/[sourceId] — run history, item
// history, purge) had no link reaching it from this list at all; an admin
// had to already know the source's id and type the URL by hand.
test('every row, ordinary and nested member alike, links to its own source detail page', () => {
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

	expect(body).toContain('href="/admin/sources/inst1"')
	expect(body).toContain('href="/admin/sources/mem1"')
})
