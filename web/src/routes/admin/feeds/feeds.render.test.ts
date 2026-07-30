import { test, expect, vi } from 'vitest'
import { render } from 'svelte/server'

// SvelteKit virtual module the page's <form use:enhance> pulls in — a bare
// stub, not a dep (same pattern as thread.render.test.ts).
vi.mock('$app/forms', () => ({ enhance: () => ({}) }))

const { default: Page } = await import('./+page.svelte')

// C1 (whole-branch review): a nested instance-member row originally rendered
// NO moderation surface at all — only URL + badges + hint — so an admin had
// no way to moderate an overridden/instance-governed member through the UI,
// even though the member row's `actions` were already computed by the same
// toRow() an ordinary row uses. The per-row Manage panel that first closed
// this gap is gone as of this task; the member row now reaches the same
// actions via a checkbox into its group's shared bulk toolbar, plus its own
// small attribution-mode form (see the tests below).
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

test('a member row nested under ?expand= carries a checkbox wired to the federation group\'s shared panel form, with its own action:commandId pair', () => {
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
	// Scoped from the nested member <ul>'s own class, not memberRow().url: the
	// checkbox is the FIRST child of the member <li> (same row-head convention
	// as an ordinary row), so the url's own first occurrence — inside the
	// checkbox's accessibility label ("Select {m.url}") — sits AFTER the
	// checkbox already rendered, and a slice from there would miss it.
	const memberChunk = body.slice(body.indexOf('member-list'))
	expect(memberChunk).toContain('form="bulk-federation"')
	expect(memberChunk).toContain('name="candidate"')
	expect(memberChunk).toContain('value="mem1|quarantine:mem-cmd-1"')
	// No more per-row Manage summary anywhere for this member.
	expect(body).not.toContain(`Manage ${memberRow().url}`)
})

test('a member\'s attribution-mode form carries the expand param forward, so its instance stays expanded after the mutation', () => {
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
	const memberChunk = body.slice(body.indexOf(memberRow().url))
	// SSR HTML-escapes the attribute's literal `&` to `&amp;`.
	expect(memberChunk).toContain('action="?/source&amp;expand=inst1"')
	expect(memberChunk).toContain('name="sourceId" value="mem1"')
	expect(memberChunk).toContain('name="action" value="attribution-mode"')
})

test('the union baseline includes an expanded federation-member\'s verbs for the federation group only, not for other groups', () => {
	// memberRow()'s only action is `quarantine`; baseRow()'s is also `quarantine`
	// by default, which wouldn't distinguish "member-aware narrowing" from
	// "ordinary narrowing" — give the ordinary row an action the member
	// DOESN'T have, so a union/narrowing bug (member's actions ignored, or
	// members folded in for every group) is actually observable.
	const ordinary = baseRow({ actions: [{ action: 'revoke', commandId: 'inst-cmd-1' }] })
	const member = memberRow({ actions: [{ action: 'quarantine', commandId: 'mem-cmd-1' }] })
	// A SECOND group, with no member of its own: a bulkActions that dropped
	// the `group.key === 'federation'` guard (folding data.expandedMembers
	// into every group instead) would still pass a fixture with only ONE
	// group unnoticed — this one catches that regression too.
	const otherGroupRow = baseRow({ id: 'u1', group: 'user', federationStatus: 'none', memberCounts: undefined, actions: [{ action: 'pause', commandId: 'u1-cmd' }] })
	const data = {
		groups: [
			{ key: 'federation', title: 'Approved federation', blurb: '', rows: [ordinary] },
			{ key: 'user', title: 'Allowed user sources', blurb: '', rows: [otherGroupRow] }
		],
		expand: 'inst1',
		expandedMembers: [member],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	// Nothing checked in either group: the union baseline must include the
	// member's own verb too (a no-JS admin who expands the instance needs to
	// see it without checking anything first) — 'quarantine' from the member
	// AND 'revoke' from the ordinary row, in the FEDERATION group's toolbar
	// only.
	const { body } = render(Page, { props: { data, form: null } } as never)
	const fedStart = body.indexOf('id="bulk-federation"')
	const fedChunk = body.slice(fedStart, body.indexOf('</form>', fedStart))
	expect(fedChunk).toContain('value="quarantine"')
	expect(fedChunk).toContain('value="revoke"')

	// The 'user' group's own toolbar must NOT see the federation member's
	// verb — proving the fold-in is scoped to group.key === 'federation'
	// only, not applied to every group's bulkActions() call.
	const userStart = body.indexOf('id="bulk-user"')
	const userChunk = body.slice(userStart, body.indexOf('</form>', userStart))
	expect(userChunk).toContain('value="pause"')
	expect(userChunk).not.toContain('value="quarantine"')
})

// The source detail page (/admin/sources/[sourceId] — run history, item
// history, purge) had no link reaching it from this list at all; an admin
// had to already know the source's id and type the URL by hand.
// Task 9 (route consolidation): an ordinary row's own Details link now toggles
// the inline ?detail= panel instead of navigating to the standalone page, and
// gets its own "Run history" link to the /runs sub-route; a nested member row
// is untouched (no inline panel plumbed for it) and still links to the
// standalone page as before.
test('every row, ordinary and nested member alike, links to its own source-detail surface', () => {
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

	expect(body).toContain('href="/admin/feeds?detail=inst1&amp;expand=inst1"')
	expect(body).toContain('href="/admin/sources/inst1/runs"')
	expect(body).toContain('href="/admin/sources/mem1"')
})

// Once the Manage panel is gone, this assertion holds for a different
// structural reason than its title suggests: the bulk toolbar only renders a
// `.confirm-gate` for a verb present in CONSEQUENCE (block/unblock) — pause
// has no CONSEQUENCE entry, so a group whose only offered action is pause
// renders no gate at all. Same absence, different mechanism.
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
	// Task 7 added an always-present bulk-unblock confirm-gate ABOVE the
	// per-row list, so with one tombstone there are now two `.confirm-gate`s
	// in the document — the row's own is the LAST one.
	const gateStart = body.lastIndexOf('class="confirm-gate')
	const detailsChunk = body.slice(gateStart, body.indexOf('</details>', gateStart) + '</details>'.length)
	expect(detailsChunk).toContain('lifts the URL reservation')
	expect(detailsChunk).toContain('Confirm unblock')
})

// --- Task 9: the inline ?detail= panel -----------------------------------------

function detailData(over: Record<string, unknown> = {}) {
	return {
		sourceId: 'inst1',
		source: { canonicalUrl: 'https://inst1.test/feed.xml', governance: 'blocked', operation: 'paused', attributionMode: 'single_publisher' },
		push: null,
		latestRun: { runId: 'r1', status: 'terminal' },
		nonterminalCount: 0,
		conflictCount: 0,
		items: [{ logicalItemId: 'li1' }],
		itemsNextCursor: null,
		purgeEligible: true,
		purgeConsequence: 'Purging permanently deletes all stored versions and evidence — this cannot be undone.',
		categories: ['spam'],
		refreshCommandId: 'refresh-1',
		purgeCommandId: 'purge-1',
		...over
	}
}

test('?detail=<id> renders the row\'s inline detail panel (refresh, status, items, purge) right where the row is, with the Details link now reading "Hide details"', () => {
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [baseRow()] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1',
		detail: detailData()
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).toContain('>Hide details<')
	const panelChunk = body.slice(body.indexOf('class="detail-panel'))
	expect(panelChunk).toContain('Source acquisition')
	expect(panelChunk).toContain('action="?/refresh')
	expect(panelChunk).toContain('name="sourceId" value="inst1"')
	expect(panelChunk).toContain('name="commandId" value="refresh-1"')
	expect(panelChunk).toContain('li1')
	// the purge form's confirm-gate reuses the established .confirm-gate shape
	expect(panelChunk).toContain('action="?/purge')
	const gateStart = panelChunk.indexOf('class="confirm-gate')
	const detailsChunk = panelChunk.slice(gateStart, panelChunk.indexOf('</details>', gateStart) + '</details>'.length)
	expect(detailsChunk).toContain('Purging permanently deletes')
	expect(detailsChunk).toContain('Confirm purge')
})

test('the inline panel\'s refresh and purge forms forward ?detail= so the panel stays open (no-JS) instead of vanishing after the very action that updates it', () => {
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [baseRow()] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1',
		detail: detailData()
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	const panelChunk = body.slice(body.indexOf('class="detail-panel'))
	expect(panelChunk).toContain('action="?/refresh&amp;detail=inst1"')
	expect(panelChunk).toContain('action="?/purge&amp;detail=inst1"')
})

// Design §11 (idempotent commandId), the same pinning the standalone
// /admin/sources/[sourceId] route does with its own `$derived` commandId /
// purgeCommandId: loadSourceDetail mints a FRESH uuid on every load, so a
// re-render after a 202/refusal/blip must pin the id that was actually
// SUBMITTED — otherwise the retry mints a new command instead of replaying the
// original, risking a duplicate acquisition run or a second audited purge.
function detailPanelOf(body: string): string {
	return body.slice(body.indexOf('class="detail-panel'))
}

function inlineDetailData(over: Record<string, unknown> = {}) {
	return {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [baseRow()] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1',
		detail: detailData(),
		...over
	}
}

test('a still-processing (202) refresh from the inline panel pins the SUBMITTED commandId, so the "check again" resubmit replays the original run', () => {
	const form = { sourceId: 'inst1', commandId: 'submitted-refresh', polling: true }
	const panel = detailPanelOf(render(Page, { props: { data: inlineDetailData(), form } } as never).body)
	expect(panel).toContain('name="commandId" value="submitted-refresh"')
	expect(panel).not.toContain('value="refresh-1"') // never the freshly-minted one
})

test('a refused purge from the inline panel pins the purge form\'s submitted commandId and leaves refresh\'s own id untouched', () => {
	const form = { commandId: 'submitted-purge', purge: true, error: 'source not blocked' }
	const panel = detailPanelOf(render(Page, { props: { data: inlineDetailData(), form } } as never).body)
	const purgeStart = panel.indexOf('action="?/purge')
	expect(panel.slice(purgeStart)).toContain('name="commandId" value="submitted-purge"')
	// the refresh form above keeps its OWN id — a purge result must not poison it
	expect(panel.slice(0, purgeStart)).toContain('name="commandId" value="refresh-1"')
})

test('an attribution-mode failure does not poison the inline panel\'s refresh commandId', () => {
	// A different source's ('inst2') attribution-mode failure — not this
	// panel's own row ('inst1') — so its commandId has no legitimate home
	// anywhere in this panel and must not leak into the refresh form.
	const form = { sourceId: 'inst2', action: 'attribution-mode', commandId: 'block-cmd-1', error: 'invalid transition' }
	const panel = detailPanelOf(render(Page, { props: { data: inlineDetailData(), form } } as never).body)
	expect(panel).toContain('name="commandId" value="refresh-1"')
	expect(panel).not.toContain('value="block-cmd-1"')
})

test('no ?detail= (data.detail null) renders no inline detail panel for any row', () => {
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: '', rows: [baseRow()] }],
		expand: null,
		expandedMembers: [],
		tombstones: [],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1',
		detail: null
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).not.toContain('class="detail-panel')
	expect(body).toContain('Details (run history, items, purge)')
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
	// Task 7 added an always-present bulk-reap confirm-gate ABOVE the
	// per-row list, so with one orphan row there are now two
	// `.confirm-gate`s in the document — the row's own is the LAST one.
	const gateStart = body.lastIndexOf('class="confirm-gate')
	const detailsChunk = body.slice(gateStart, body.indexOf('</details>', gateStart) + '</details>'.length)
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
		// Task 7 added an always-present bulk-reap confirm-gate ABOVE the
		// per-row list, so with one orphan row there are now two
		// `.confirm-gate`s in the document — the row's own is the LAST one.
		const gateStart = body.lastIndexOf('class="confirm-gate')
		const detailsChunk = body.slice(gateStart, body.indexOf('</details>', gateStart) + '</details>'.length)
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

// The no-JS contract (plan's mid-execution correction): the checkbox is
// self-describing — its value names the row AND every action:commandId pair
// the row offers — so a checked box alone carries everything bulkSource needs.
// Only checked boxes land in the submitted FormData, so the batch is the
// selection without any client state involved.
test('each row in an ordinary group has a self-describing candidate checkbox, and the group renders one always-present bulk toolbar (no-JS baseline)', () => {
	const { body } = render(Page, { props: { data: bulkData(), form: null } } as never)
	expect(body).toContain('type="checkbox"')
	expect(body).toContain('name="candidate"')
	expect(body).toContain('value="r1|quarantine:inst-cmd-1"')
	// No separate hidden-input loop feeds this form: the checkboxes ARE the
	// candidates, so nothing depends on JS having run.
	expect(body).not.toContain('type="hidden" name="candidate"')
	expect(body).toContain('action="?/bulkSource')
})

test('a multi-action row packs every action:commandId pair into its one checkbox value', () => {
	const row = baseRow({ id: 'r1', group: 'user', federationStatus: 'none', memberCounts: undefined, actions: [{ action: 'pause', commandId: 'c-pause' }, { action: 'quarantine', commandId: 'c-quar' }] })
	const { body } = render(Page, { props: { data: bulkData({ groups: [{ key: 'user', title: 'Allowed user sources', blurb: 'blurb text', rows: [row] }] }), form: null } } as never)
	expect(body).toContain('value="r1|pause:c-pause|quarantine:c-quar"')
})

test('the bulk toolbar offers a button per action present on EVERY checked row\'s availableActions (server renders the full set; the intersection narrowing is a client-JS enhancement, not required for no-JS baseline)', () => {
	const row = baseRow({ id: 'r1', group: 'user', federationStatus: 'none', memberCounts: undefined, actions: [{ action: 'quarantine', commandId: 'c1' }, { action: 'block', commandId: 'c2' }] })
	const data = bulkData({ groups: [{ key: 'user', title: 'Allowed user sources', blurb: 'blurb text', rows: [row] }] })
	const { body } = render(Page, { props: { data, form: null } } as never)
	const bulkFormChunk = body.slice(body.indexOf('action="?/bulkSource'), body.indexOf('</form>', body.indexOf('action="?/bulkSource')))
	expect(bulkFormChunk).toContain('value="quarantine"')
	expect(bulkFormChunk).toContain('value="block"')
	// Visible by default, not hidden behind the JS-only selection class: with
	// nothing checked the bar carries no `has-selection`, and the buttons are
	// still in the server output.
	expect(bulkFormChunk).toContain('class="subnav bulk-blurb')
	expect(bulkFormChunk).not.toContain('has-selection')
	// attribution-mode is never bulk-eligible (plan Global Constraints).
	expect(bulkFormChunk).not.toContain('value="attribution-mode"')
})

test('the shared action panel is collapsed by default (no `open` attribute) and its buttons still render inside it', () => {
	const row = baseRow({ actions: [{ action: 'quarantine', commandId: 'inst-cmd-1' }] })
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
	const panelStart = body.indexOf('class="panel"', body.indexOf('action="?/bulkSource'))
	const panelChunk = body.slice(panelStart, body.indexOf('</details>', panelStart) + '</details>'.length)
	expect(panelChunk).not.toContain('open')
	expect(panelChunk).toContain('>Actions<')
	expect(panelChunk).toContain('value="quarantine"')
})

test('the group blurb stays visible outside the collapsed panel, with the selected count appended to it (not inside the panel)', () => {
	const row = baseRow({ actions: [{ action: 'quarantine', commandId: 'inst-cmd-1' }] })
	const data = {
		groups: [{ key: 'federation', title: 'Approved federation', blurb: 'Federated with this instance.', rows: [row] }],
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
	const formStart = body.indexOf('action="?/bulkSource')
	const panelStart = body.indexOf('class="panel"', formStart)
	const blurbChunk = body.slice(formStart, panelStart)
	expect(blurbChunk).toContain('Federated with this instance.')
})

// The bulk toolbar gates block/unblock behind reveal-to-confirm, keyed on
// CONSEQUENCE[action] — it's the only path that can act on either verb now,
// so blocking N sources in one click can't be a destructive action with no
// stated consequence (spec §10's invariant).
test('the bulk toolbar gates block behind a confirm-gate stating its consequence, while the other verbs stay direct submits', () => {
	const row = baseRow({
		id: 'r1',
		group: 'user',
		federationStatus: 'none',
		memberCounts: undefined,
		actions: [
			{ action: 'quarantine', commandId: 'c1' },
			{ action: 'block', commandId: 'c2' }
		]
	})
	const data = bulkData({ groups: [{ key: 'user', title: 'Allowed user sources', blurb: 'blurb text', rows: [row] }] })
	const { body } = render(Page, { props: { data, form: null } } as never)
	const formStart = body.indexOf('action="?/bulkSource')
	const bulkFormChunk = body.slice(formStart, body.indexOf('</form>', formStart))
	const gateStart = bulkFormChunk.indexOf('class="confirm-gate')
	expect(gateStart).toBeGreaterThan(-1)
	const gate = bulkFormChunk.slice(gateStart, bulkFormChunk.indexOf('</details>', gateStart))
	// block's own distinct consequence, and the submit that carries the verb,
	// both live INSIDE the gate.
	expect(gate).toContain('Blocking stops all acquisition')
	expect(gate).toContain('value="block"')
	expect(gate).toContain('Confirm block')
	// quarantine has no stated consequence (it's not a CONSEQUENCE key), so it
	// stays a bare button outside any gate; block, which IS a CONSEQUENCE key,
	// is the only one gated.
	expect(bulkFormChunk.slice(0, gateStart)).toContain('value="quarantine"')
	expect(gate).not.toContain('value="quarantine"')
})

test('the bulk toolbar gates unblock behind its own confirm-gate, with unblock\'s distinct consequence — not block\'s', () => {
	const row = baseRow({
		id: 'b1',
		group: 'blocked',
		governance: 'blocked',
		federationStatus: 'none',
		memberCounts: undefined,
		actions: [
			{ action: 'pause', commandId: 'c1' },
			{ action: 'unblock', commandId: 'c2' }
		]
	})
	const data = bulkData({ groups: [{ key: 'blocked', title: 'Blocked sources', blurb: 'blurb text', rows: [row] }] })
	const { body } = render(Page, { props: { data, form: null } } as never)
	const formStart = body.indexOf('action="?/bulkSource')
	const bulkFormChunk = body.slice(formStart, body.indexOf('</form>', formStart))
	const gateStart = bulkFormChunk.indexOf('class="confirm-gate')
	const gate = bulkFormChunk.slice(gateStart, bulkFormChunk.indexOf('</details>', gateStart))
	expect(gate).toContain('Unblocking returns this source to quarantine')
	expect(gate).not.toContain('Blocking stops all acquisition')
	expect(gate).toContain('value="unblock"')
	expect(gate).toContain('Confirm unblock')
	expect(bulkFormChunk.slice(0, gateStart)).toContain('value="pause"')
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

// --- Task 7: bulk checkboxes + always-present toolbars for orphans + tombstones ---

test('orphan rows each have a checkbox and the section renders an always-present bulk-reap form', () => {
	const { body } = render(Page, { props: { data: orphanData(), form: null } } as never)
	const orphanSection = body.slice(body.indexOf('Orphaned sources'))
	expect(orphanSection).toContain('type="checkbox"')
	expect(orphanSection).toContain('action="?/bulkReap')
})

test('bulk reap consequence text is pluralized and mixes plain/force wording when the selection mixes retentions', () => {
	const data = orphanData({
		orphanRows: [orphanRow({ id: 'orph1', retention: 'reapable' }), orphanRow({ id: 'orph2', retention: 'audit_history' })]
	})
	// Selection state is client-only ($state); render with both boxes
	// pre-checked isn't reachable through the data prop alone in an SSR
	// test — instead assert the STATIC per-row force encoding the bulk form
	// depends on is present for both rows regardless of selection, since
	// that's what the client-side toggle reads at click time.
	const { body } = render(Page, { props: { data, form: null } } as never)
	const orphanSection = body.slice(body.indexOf('Orphaned sources'))
	expect(orphanSection).toContain('orph1:orph-cmd-1:false')
	expect(orphanSection).toContain('orph2:orph-cmd-1:true')
})

// The stronger "some sources override retained evidence" sentence used to be
// keyed on `selected.orphans`, which is empty with JS off — so a no-JS bulk
// reap of force-needed orphans saw only the generic wording and was
// under-warned about permanent evidence deletion. With no selection tracked,
// the predicate falls back to the whole page: over-warn, never under-warn, for
// an irreversible action.
test('the bulk-reap confirm text warns about overridden retained evidence from the SERVER render, with no selection state involved', () => {
	const data = orphanData({ orphanRows: [orphanRow({ id: 'orph1', retention: 'audit_history' })] })
	const { body } = render(Page, { props: { data, form: null } } as never)
	const formStart = body.indexOf('action="?/bulkReap')
	const bulkFormChunk = body.slice(formStart, body.indexOf('</form>', formStart))
	expect(bulkFormChunk).toContain('override retained evidence')
	expect(bulkFormChunk).toContain('This cannot be undone.')
})

test('the bulk-reap confirm text omits the retained-evidence warning when no orphan on the page needs force', () => {
	const data = orphanData({ orphanRows: [orphanRow({ id: 'orph1', retention: 'reapable' })] })
	const { body } = render(Page, { props: { data, form: null } } as never)
	const formStart = body.indexOf('action="?/bulkReap')
	const bulkFormChunk = body.slice(formStart, body.indexOf('</form>', formStart))
	expect(bulkFormChunk).not.toContain('override retained evidence')
})

test('the orphan bulk-reap toolbar (button + confirm-gate) is always in the server output, not gated behind a JS-only selection count', () => {
	const { body } = render(Page, { props: { data: orphanData(), form: null } } as never)
	const bulkFormChunk = body.slice(body.indexOf('action="?/bulkReap'), body.indexOf('</form>', body.indexOf('action="?/bulkReap')))
	expect(bulkFormChunk).toContain('class="confirm-gate')
	expect(bulkFormChunk).toContain('Reap selected')
	expect(bulkFormChunk).not.toContain('has-selection')
})

test('tombstone rows each have a checkbox and the section renders an always-present bulk-unblock form', () => {
	const data = {
		groups: [],
		expand: null,
		expandedMembers: [],
		tombstones: [{ id: 't1', canonicalUrl: 'https://gone.test/t1.xml', action: 'block', category: 'spam', note: '', createdAt: '2026-07-01T00:00:00Z', aliases: [], commandId: 'tomb-cmd-1' }],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	const tombstoneSection = body.slice(body.indexOf('Blocked and tombstoned URLs'))
	expect(tombstoneSection).toContain('type="checkbox"')
	expect(tombstoneSection).toContain('action="?/bulkTombstone')
	expect(tombstoneSection).toContain('t1:tomb-cmd-1')
})

// Every other mutating form on this page appends otherParams() so a no-JS
// submit lands back on the same view; the bulk-tombstone form was the one that
// dropped it, losing cursor/q/orphanCursor/expand/detail on its reload.
test('the bulk-tombstone form carries the other view params forward, same as its sibling bulk forms and the per-row unblock form', () => {
	const data = {
		groups: [],
		expand: 'inst1',
		expandedMembers: [],
		tombstones: [{ id: 't1', canonicalUrl: 'https://gone.test/t1.xml', action: 'block', category: 'spam', note: '', createdAt: '2026-07-01T00:00:00Z', aliases: [], commandId: 'tomb-cmd-1' }],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: 'page2',
		nextCursor: null,
		...NO_ORPHANS,
		q: 'example.test',
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	expect(body).toContain('action="?/bulkTombstone&amp;cursor=page2&amp;q=example.test&amp;expand=inst1"')
})

test('the tombstone bulk-unblock toolbar (category select + confirm-gate) is always in the server output, not gated behind a JS-only selection count', () => {
	const data = {
		groups: [],
		expand: null,
		expandedMembers: [],
		tombstones: [{ id: 't1', canonicalUrl: 'https://gone.test/t1.xml', action: 'block', category: 'spam', note: '', createdAt: '2026-07-01T00:00:00Z', aliases: [], commandId: 'tomb-cmd-1' }],
		tombstoneConsequence: 'nothing restored',
		categories: ['spam'],
		cursor: null,
		nextCursor: null,
		...NO_ORPHANS,
		establishCommandId: 'establish-1'
	}
	const { body } = render(Page, { props: { data, form: null } } as never)
	const bulkFormChunk = body.slice(body.indexOf('action="?/bulkTombstone'), body.indexOf('</form>', body.indexOf('action="?/bulkTombstone')))
	expect(bulkFormChunk).toContain('<select')
	expect(bulkFormChunk).toContain('class="confirm-gate')
	expect(bulkFormChunk).toContain('Unblock selected')
	expect(bulkFormChunk).not.toContain('has-selection')
})

// All four bulk actions answer an ineffective submit with an EMPTY results
// array (nothing checked, or nothing checked offered the clicked verb). The
// outcome blocks gate on `?.length`, so that used to render nothing at all —
// with JS off there is no live "N selected" count either, so the page came back
// looking identical and silent. An empty array is a distinct outcome and says so.
test('an empty bulkResults array (nothing effectively selected) reports "Nothing selected." instead of rendering nothing', () => {
	const { body } = render(Page, { props: { data: bulkData(), form: { bulkResults: [], bulkAction: 'quarantine' } } } as never)
	expect(body).toContain('Nothing selected.')
})

test('an empty bulkReapResults / bulkTombstoneResults array reports it too', () => {
	const reap = render(Page, { props: { data: orphanData(), form: { bulkReapResults: [] } } } as never).body
	expect(reap).toContain('Nothing selected.')
	const tomb = render(Page, { props: { data: orphanData(), form: { bulkTombstoneResults: [] } } } as never).body
	expect(tomb).toContain('Nothing selected.')
})

test('bulkReapResults/bulkTombstoneResults each render a per-row outcome line naming failures', () => {
	const form = {
		bulkReapResults: [{ sourceId: 'orph1', ok: false, error: 'has_subscribers' }, { sourceId: 'orph2', ok: true }],
		bulkTombstoneResults: [{ tombstoneId: 't1', ok: false, error: 'unavailable' }, { tombstoneId: 't2', ok: true }]
	}
	const { body } = render(Page, { props: { data: orphanData(), form } } as never)
	expect(body).toContain('orph1')
	expect(body).toContain('has_subscribers')
	expect(body).toContain('t1')
	expect(body).toContain('unavailable')
})
