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
		addedBy: [],
		subscriberTotal: 0,
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
		addedBy: [],
		subscriberTotal: 0,
		actions: [{ action: 'quarantine', commandId: 'mem-cmd-1' }],
		...over
	}
}

// Every `data` object below stands in for +page.server.ts's load() return —
// Task 4 added four fields (`q`, `orphanRows`, `orphanCursor`,
// `orphanNextCursor`) the template now reads unconditionally, so every
// existing fixture needs the empty-orphan-group defaults or `data.orphanRows.length`
// throws on a plain object that never had the key.
const NO_ORPHANS = { q: null, orphanRows: [], orphanCursor: null, orphanNextCursor: null }

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
		...NO_ORPHANS,
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
		...NO_ORPHANS,
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
		...NO_ORPHANS,
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
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)

	expect(body).toContain('href="/admin/sources/inst1"')
	expect(body).toContain('href="/admin/sources/mem1"')
})

test('a block form with a consequence renders a collapsed <details> disclosure, not an always-visible confirm button', () => {
	const row = baseRow({ actions: [{ action: 'block', commandId: 'block-cmd-1' }] })
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [row] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	// The consequence text and the actual submit button live INSIDE a
	// <details>, collapsed by default — not sitting next to an always-active
	// submit button (the old double-confirm shape).
	const detailsChunk = body.slice(body.indexOf('class="confirm-gate'), body.indexOf('</details>', body.indexOf('class="confirm-gate')) + '</details>'.length)
	expect(detailsChunk).toContain('Blocking stops all acquisition')
	expect(detailsChunk).toContain('Confirm block')
	// The <summary> (always visible, collapsed state) carries the plain action label.
	const summaryChunk = detailsChunk.slice(0, detailsChunk.indexOf('</summary>'))
	expect(summaryChunk).toContain('>Block<')
})

test('an action with no stated consequence (pause) has no confirm-gate at all — direct submit', () => {
	const row = baseRow({ actions: [{ action: 'pause', commandId: 'pause-cmd-1' }] })
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [row] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).not.toContain('class="confirm-gate')
	expect(body).toContain('>Pause acquisition<')
})

test('the tombstone-unblock form renders its own confirm-gate with the distinct tombstone consequence', () => {
	const data = {
		groups: [],
		expand: null,
		expandedMembers: [],
		tombstones: [{ id: 't1', canonicalUrl: 'https://gone.test/t1.xml', action: 'block', category: 'spam', note: '', createdAt: '2026-07-01T00:00:00Z', aliases: [], commandId: 'tomb-cmd-1' }],
		tombstoneConsequence: 'Unblocking this tombstone lifts the URL reservation so the URL can be created again. Nothing is restored.',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	const detailsChunk = body.slice(body.indexOf('class="confirm-gate'), body.indexOf('</details>', body.indexOf('class="confirm-gate')) + '</details>'.length)
	expect(detailsChunk).toContain('lifts the URL reservation')
	expect(detailsChunk).toContain('Confirm unblock')
})

// --- Task 4: search box, addedBy, the orphan group, the two-step reap confirm ---

test('the search box echoes the current q and offers a Clear link only when q is set', () => {
	const dataWithQ = {
		groups: [],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		q: 'example.test',
		orphanRows: [],
		orphanCursor: null,
		orphanNextCursor: null,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data: dataWithQ, form: null } } as never)
	expect(body).toContain('name="q"')
	expect(body).toContain('value="example.test"')
	expect(body).toContain('Clear')

	const { body: bodyNoQ } = render(Page, { props: { data: { ...dataWithQ, q: null }, form: null } } as never)
	expect(bodyNoQ).not.toContain('>Clear<')
})

test("a row with subscribers renders 'Added by @handle (+N)' — first 3 handles, N = remaining subscribers", () => {
	const row = baseRow({
		group: 'user',
		federationStatus: 'none',
		memberCounts: undefined,
		addedBy: [
			{ handle: 'alice', displayName: 'Alice' },
			{ handle: 'bob', displayName: 'Bob' },
			{ handle: 'carol', displayName: 'Carol' }
		],
		subscriberTotal: 5
	})
	const data = {
		groups: [{ key: 'user', title: 'Allowed user sources', blurb: '', rows: [row] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).toContain('Added by @alice, @bob, @carol (+2)')
})

test('a row with 3 or fewer subscribers renders addedBy with no (+N) tail', () => {
	const row = baseRow({
		group: 'user',
		federationStatus: 'none',
		memberCounts: undefined,
		addedBy: [{ handle: 'alice', displayName: 'Alice' }],
		subscriberTotal: 1
	})
	const data = {
		groups: [{ key: 'user', title: 'Allowed user sources', blurb: '', rows: [row] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).toContain('Added by @alice')
	expect(body).not.toContain('(+')
})

function orphanRow(over: Record<string, unknown> = {}) {
	return {
		id: 'orph1',
		url: 'https://orph.test/feed.xml',
		retention: 'reapable',
		commandId: 'orph-cmd-1',
		...over
	}
}

function orphanData(over: Record<string, unknown> = {}) {
	return {
		groups: [],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		q: null,
		orphanCursor: null,
		orphanNextCursor: null,
		establishCommandId: 'establish-1',
		orphanRows: [orphanRow()],
		...over
	}
}

test('the orphan group is shown even when the ordinary groups are all empty, with the retention reason as a label and a Reap form', () => {
	const { body } = render(Page, { props: { data: orphanData(), form: null } } as never)
	expect(body).toContain('Orphaned sources')
	expect(body).toContain('https://orph.test/feed.xml')
	expect(body).toContain('action="?/reap')
	expect(body).toContain('name="sourceId" value="orph1"')
	expect(body).toContain('name="commandId" value="orph-cmd-1"')
	// No force-confirm form absent a prior 409 — only the plain reap form.
	expect(body).not.toContain('name="force"')
})

test('the orphan group renders a distinct retention label per reason', () => {
	const labels: Record<string, string> = {
		verified_origin: 'Verified-origin',
		admin_retained: 'Admin-retained',
		audit_history: 'audit history',
		reapable: 'reapable'
	}
	for (const [retention, needle] of Object.entries(labels)) {
		const { body } = render(Page, { props: { data: orphanData({ orphanRows: [orphanRow({ retention })] }), form: null } } as never)
		expect(body.toLowerCase()).toContain(needle.toLowerCase())
	}
})

test('the orphan group paginates independently: its next link carries orphanCursor, and the ordinary "More sources" link carries cursor — never crossed', () => {
	const { body } = render(
		Page,
		{ props: { data: orphanData({ cursor: 'page2', nextCursor: 'page3', orphanNextCursor: 'orph-page2' }), form: null } } as never
	)
	const orphanLink = body.slice(body.indexOf('<a class="older" href="/admin/feeds?orphanCursor'), body.indexOf('More orphaned sources'))
	expect(orphanLink).toContain('orphanCursor=orph-page2')
	expect(orphanLink).not.toContain('&cursor=page3') // the ordinary list's OWN next cursor, not this link's axis

	const ordinaryLink = body.slice(body.indexOf('<a class="older" href="/admin/feeds?cursor'), body.indexOf('More sources'))
	expect(ordinaryLink).toContain('cursor=page3')
	expect(ordinaryLink).not.toContain('orphanCursor=')
})

const REASON_COPY_NEEDLE: Record<string, string> = {
	verified_origin_evidence: 'verified-origin evidence',
	admin_retained: 'marked retained by an admin',
	audit_history: 'audit history'
}
// Retention-driven: the button/consequence choice comes from row.retention
// ALONE, at first render — no `form` prop, no prior refusal. reapable gets
// the plain form; each force-liftable reason gets the force form directly.
test('a reapable orphan row renders exactly one plain Reap form, no force variant', () => {
	const { body } = render(Page, { props: { data: orphanData({ orphanRows: [orphanRow({ retention: 'reapable' })] }), form: null } } as never)
	expect(body).toContain('action="?/reap')
	expect(body).toContain('name="sourceId" value="orph1"')
	expect(body).toContain('name="commandId" value="orph-cmd-1"')
	expect(body).not.toContain('name="force"')
	const detailsChunk = body.slice(body.indexOf('class="confirm-gate'), body.indexOf('</details>', body.indexOf('class="confirm-gate')) + '</details>'.length)
	expect(detailsChunk).toContain('Confirm reap')
})

for (const reason of ['verified_origin_evidence', 'admin_retained', 'audit_history']) {
	test(`a retention=${reason} orphan row renders exactly one "Reap anyway" form with force:true and the reason-specific consequence, from first render`, () => {
		// orphanRow's `retention` param uses the display-oriented value
		// (verified_origin/admin_retained/audit_history/reapable); the
		// FORCE_REAP_CONSEQUENCE lookup in +page.svelte keys on that same
		// value, so pass it straight through here — no separate "refusal
		// reason" string is involved anywhere in this flow anymore.
		const retention = reason === 'verified_origin_evidence' ? 'verified_origin' : reason
		const { body } = render(Page, { props: { data: orphanData({ orphanRows: [orphanRow({ id: 'orph1', url: 'https://orph1.test/feed.xml', retention })] }), form: null } } as never)
		expect(body).toContain('name="force" value="true"')
		expect(body).toContain('name="commandId" value="orph-cmd-1"') // the row's ONE commandId, reused, not a second one
		const detailsChunk = body.slice(body.indexOf('class="confirm-gate'), body.indexOf('</details>', body.indexOf('class="confirm-gate')) + '</details>'.length)
		expect(detailsChunk).toContain(REASON_COPY_NEEDLE[reason])
		expect(detailsChunk).toContain('Confirm reap anyway')
		for (const [otherReason, needle] of Object.entries(REASON_COPY_NEEDLE)) {
			if (otherReason !== reason) expect(detailsChunk).not.toContain(needle)
		}
	})
}

// --- Task 5: bulk checkboxes + the per-group bulk toolbar ---

function bulkData(over: Record<string, unknown> = {}) {
	return {
		groups: [{ key: 'user', title: 'Allowed user sources', blurb: 'blurb text', rows: [baseRow({ id: 'r1', group: 'user', federationStatus: 'none', memberCounts: undefined })] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1',
		...over
	}
}

test('each row in an ordinary group has a checkbox, and the group renders one always-present bulk toolbar (no-JS baseline)', () => {
	const { body } = render(Page, { props: { data: bulkData(), form: null } } as never)
	expect(body).toContain('name="sourceId" value="r1"')
	expect(body).toContain('type="checkbox"')
	// The bulk form posts to ?/bulkSource and is present even with nothing
	// checked — a no-JS submit with zero boxes checked is a defined no-op
	// (Task 4), not a missing affordance.
	expect(body).toContain('action="?/bulkSource')
})

// The bug the plan's Step 4→5 correction exists to prevent: candidates
// rendered by iterating group.rows would submit EVERY row's candidate on any
// bulk click, checked or not. Nothing is checked in an SSR render, so a
// correct implementation emits no candidate at all here.
test('an unchecked row contributes NO candidate input — the hidden candidates iterate the selection, not the rows', () => {
	const { body } = render(Page, { props: { data: bulkData(), form: null } } as never)
	expect(body).not.toContain('name="candidate"')
})

test('the bulk toolbar offers a button per action present on EVERY checked row\'s availableActions (server renders the full set; the intersection narrowing is a client-JS enhancement, not required for no-JS baseline)', () => {
	const row = baseRow({ id: 'r1', group: 'user', federationStatus: 'none', memberCounts: undefined, actions: [{ action: 'quarantine', commandId: 'c1' }, { action: 'block', commandId: 'c2' }] })
	const data = bulkData({ groups: [{ key: 'user', title: 'Allowed user sources', blurb: 'blurb text', rows: [row] }] })
	const { body } = render(Page, { props: { data, form: null } } as never)
	const bulkFormChunk = body.slice(body.indexOf('action="?/bulkSource'), body.indexOf('</form>', body.indexOf('action="?/bulkSource')))
	expect(bulkFormChunk).toContain('value="quarantine"')
	expect(bulkFormChunk).toContain('value="block"')
	// attribution-mode is never bulk-eligible (plan Global Constraints).
	expect(bulkFormChunk).not.toContain('value="attribution-mode"')
})

test('bulk outcome reporting: form.bulkResults renders a per-row outcome line naming each failure', () => {
	const form = { bulkResults: [{ sourceId: 'r1', ok: false, error: 'invalid transition' }, { sourceId: 'r2', ok: true }], bulkAction: 'quarantine' }
	const { body } = render(Page, { props: { data: bulkData(), form } } as never)
	expect(body).toContain('r1')
	expect(body).toContain('invalid transition')
})

test('a mixed batch of orphan rows renders each with its OWN correct variant, independent of the others', () => {
	const data = orphanData({
		orphanRows: [
			orphanRow({ id: 'orph1', url: 'https://orph1.test/feed.xml', retention: 'audit_history' }),
			orphanRow({ id: 'orph2', url: 'https://orph2.test/feed.xml', retention: 'reapable' })
		]
	})
	const { body } = render(Page, { props: { data, form: null } } as never)
	const orph1Chunk = body.slice(body.indexOf('https://orph1.test'), body.indexOf('https://orph2.test'))
	const orph2Chunk = body.slice(body.indexOf('https://orph2.test'))
	expect(orph1Chunk).toContain('name="force" value="true"')
	expect(orph2Chunk.slice(0, orph2Chunk.indexOf('More orphaned') === -1 ? orph2Chunk.length : orph2Chunk.indexOf('More orphaned'))).not.toContain('name="force" value="true"')
})
