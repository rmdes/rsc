import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

const cookies = { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }

function formEvent(action: string, fields: Record<string, string>, fetch: ReturnType<typeof vi.fn>) {
	return {
		request: new Request(`http://x/admin/feeds?/${action}`, { method: 'POST', body: new URLSearchParams(fields) }),
		fetch,
		url: new URL('http://x/admin/feeds'),
		cookies
	}
}

const loadEvent = (fetch: ReturnType<typeof vi.fn>, search = '') => ({
	fetch,
	url: new URL(`http://x/admin/feeds${search}`),
	cookies
})

const urlsOf = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map((c) => String(c[0]))

const summary = (
	id: string,
	governance: string,
	federationStatus: string,
	operation = 'enabled',
	attributionMode = 'single_publisher'
) => ({
	source: { id, canonicalUrl: `https://ex.test/${id}.xml`, attributionMode, operation, governance, provenance: 'user_subscription', adminRetained: false },
	federationStatus,
	subscriptionCounts: { active: 1, pending: 0, pendingReview: 0 }
})

type Row = {
	id: string
	url: string
	governance: string
	operation: string
	federationStatus: string
	overridden: boolean
	isInstanceMember: boolean
	viaVerification: boolean
	memberCounts?: { members: number; overridden: number; instanceGoverned: number }
	actions: Array<{ action: string; commandId: string }>
}
type Group = { key: string; title: string; blurb: string; rows: Row[] }
type LoadResult = {
	groups?: Group[]
	cursor?: string | null
	nextCursor?: string | null
	establishCommandId?: string
	expand?: string | null
	expandedMembers?: Row[]
}

// Every load case takes a FRESH +page.server.ts import (vi.resetModules) purely
// for isolation between cases — the load itself has no memoized state.
async function loadAdminWith(fetch: ReturnType<typeof vi.fn>, search = ''): Promise<LoadResult> {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	return (await load(loadEvent(fetch, search) as never)) as LoadResult
}

// --- the source console --------------------------------------------------------

test('the admin load reads /admin/sources and groups the four buckets', async () => {
	const fetch = vi.fn(async (..._url: unknown[]) =>
		new Response(
			JSON.stringify({
				items: [
					summary('fed', 'allowed', 'approved'),
					summary('cand', 'allowed', 'pending'),
					summary('quar', 'quarantined', 'none'),
					summary('user', 'allowed', 'none', 'paused'),
					summary('bad', 'blocked', 'pending')
				],
				nextCursor: 'c2'
			}),
			{ status: 200 }
		)
	)
	const result = await loadAdminWith(fetch)
	expect(urlsOf(fetch).some((u) => u.includes('/admin/sources'))).toBe(true)
	expect(urlsOf(fetch).some((u) => u.includes('/admin/feeds'))).toBe(false)
	expect(result.groups?.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
		['federation', ['fed']],
		['review', ['cand', 'quar']],
		['user', ['user']],
		['blocked', ['bad']]
	])
	expect(result.nextCursor).toBe('c2')
	expect(result.cursor).toBeNull() // no ?cursor= on this request — this is page one
	expect(result.establishCommandId).toMatch(/^[0-9a-f]{8}-/)

	// Design §10: the blocked group's blurb is the reachable half of the
	// block/unblock consequence copy (the per-action confirm strings live
	// only in +page.svelte, which has no component test harness here) —
	// pinned so a rewrite to something like "Are you sure?" fails this test.
	const blockedBlurb = result.groups?.find((g) => g.key === 'blocked')?.blurb ?? ''
	expect(blockedBlurb).toContain('No acquisition, no eligible deliveries')
	expect(blockedBlurb).toContain('still fully inspectable')
	expect(blockedBlurb).toContain('Unblocking returns a source to quarantine')
	expect(blockedBlurb).toContain('never straight to visibility')

	const rows = result.groups?.flatMap((g) => g.rows) ?? []
	// Only safe SourceSummary fields reach the page — no provenance, no
	// retention flag, and no item/delivery evidence (a later vertical).
	for (const r of rows) expect(Object.keys(r).some((k) => /provenance|adminRetained|item|deliver/i.test(k))).toBe(false)
	// One command id per rendered form: distinct per action, stable per render.
	const ids = rows.flatMap((r) => r.actions.map((a) => a.commandId))
	expect(new Set(ids).size).toBe(ids.length)
	expect(ids.every((id) => /^[0-9a-f]{8}-/.test(id))).toBe(true)
	// The offered actions are exactly the legal transitions for each row's axes.
	const offered = Object.fromEntries(rows.map((r) => [r.id, r.actions.map((a) => a.action)]))
	expect(offered.fed).toEqual(['pause', 'quarantine', 'revoke', 'block', 'attribution-mode'])
	expect(offered.cand).toEqual(['pause', 'quarantine', 'approve', 'reject', 'block', 'attribution-mode'])
	expect(offered.quar).toEqual(['pause', 'allow', 'block', 'attribution-mode'])
	expect(offered.user).toEqual(['resume', 'quarantine', 'block', 'attribution-mode'])
	expect(offered.bad).toEqual(['pause', 'reject', 'unblock', 'attribution-mode'])
})

test('the v2 load echoes back the inbound cursor so a mutating form can carry pagination forward on retry', async () => {
	const fetch = vi.fn(async (..._url: unknown[]) =>
		new Response(JSON.stringify({ items: [summary('fed', 'allowed', 'approved')], nextCursor: null }), { status: 200 })
	)
	const result = await loadAdminWith(fetch, '?cursor=page2cursor')
	// This is the current page's cursor (what put us on page 2), not nextCursor
	// (the page after) — the no-JS pagination bug loses exactly this value.
	expect(result.cursor).toBe('page2cursor')
	expect(urlsOf(fetch).some((u) => u.includes('cursor=page2cursor'))).toBe(true)
})

test('the source action posts the stable id, category, note and command id to the hyphenated segment', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ source: {}, audit: {} }), { status: 200 }))
	const res = await actions.source(formEvent('source', { sourceId: 's1', action: 'block', category: 'abuse', note: 'repeat spam', commandId: 'cmd-1' }, fetch) as never)
	expect(res).toEqual({ done: 'block' })
	expect(fetch).toHaveBeenCalledTimes(1) // no capability probe: this markup only exists under v2
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/admin/sources/s1/block')
	expect(init.method).toBe('POST')
	expect(JSON.parse(String(init.body))).toEqual({ commandId: 'cmd-1', category: 'abuse', note: 'repeat spam' })
	expect(new Headers(init.headers).get('cookie')).toBe('rsc.session_token=s1')

	await actions.source(formEvent('source', { sourceId: 's1', action: 'attribution-mode', category: 'other', attributionMode: 'aggregate', commandId: 'cmd-2' }, fetch) as never)
	const [modeUrl, modeInit] = fetch.mock.calls[1] as [string, RequestInit]
	expect(modeUrl).toContain('/admin/sources/s1/attribution-mode')
	expect(JSON.parse(String(modeInit.body))).toEqual({ commandId: 'cmd-2', category: 'other', attributionMode: 'aggregate' })

	// pause/resume are operational, not moderation — they alone carry no category.
	await actions.source(formEvent('source', { sourceId: 's1', action: 'pause', commandId: 'cmd-3' }, fetch) as never)
	expect(JSON.parse(String((fetch.mock.calls[2] as [string, RequestInit])[1].body))).toEqual({ commandId: 'cmd-3' })
})

test('the source action refuses an unknown segment and a missing category without calling core', async () => {
	const fetch = vi.fn()
	expect(await actions.source(formEvent('source', { sourceId: 's1', action: 'constructor', category: 'other', commandId: 'c' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(await actions.source(formEvent('source', { sourceId: 's1', action: 'purge', category: 'other', commandId: 'c' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(await actions.source(formEvent('source', { sourceId: '', action: 'block', category: 'other', commandId: 'c' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(await actions.source(formEvent('source', { sourceId: 's1', action: 'block', category: '', commandId: 'c' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('the source action refuses a missing commandId without calling core, and never mints one in its place', async () => {
	const fetch = vi.fn()
	expect(await actions.source(formEvent('source', { sourceId: 's1', action: 'block', category: 'other' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(await actions.source(formEvent('source', { sourceId: 's1', action: 'block', category: 'other', commandId: '' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('a failed source action echoes back the exact submitted commandId/sourceId/action so a retry replays the original command', async () => {
	// core's response is "lost" from the admin's point of view (409 or a thrown
	// network error) — the fix under test is that the re-render never hands the
	// retry a FRESH command id, which would make core see a different command.
	const conflictFetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ error: 'invalid transition' }), { status: 409 }))
	const conflictRes = await actions.source(formEvent('source', { sourceId: 's9', action: 'block', category: 'abuse', commandId: 'retry-me' }, conflictFetch) as never)
	expect((conflictRes as { data: { error: string; sourceId: string; action: string; commandId: string } }).data).toEqual({
		error: 'invalid transition',
		sourceId: 's9',
		action: 'block',
		commandId: 'retry-me'
	})

	const throwingFetch = vi.fn(async () => {
		throw new Error('response lost')
	})
	const throwRes = await actions.source(formEvent('source', { sourceId: 's9', action: 'block', category: 'abuse', commandId: 'retry-me-2' }, throwingFetch) as never)
	expect((throwRes as { data: { sourceId: string; action: string; commandId: string } }).data).toMatchObject({
		sourceId: 's9',
		action: 'block',
		commandId: 'retry-me-2'
	})
})

test("core's two distinct conflicts reach the admin verbatim", async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ error: 'invalid transition' }), { status: 409 }))
	const res = await actions.source(formEvent('source', { sourceId: 's1', action: 'allow', category: 'spam', commandId: 'cmd-4' }, fetch) as never)
	expect(res).toMatchObject({ status: 400 })
	expect((res as { data: { error: string } }).data.error).toBe('invalid transition')
})

test('establish federation posts fixed aggregate/operator_policy with the url, note and command id', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ source: {}, federation: {} }), { status: 201 }))
	const res = await actions.establish(
		formEvent('establish', { url: 'https://peer.test/feed.xml', note: 'peer', commandId: 'cmd-5' }, fetch) as never
	)
	expect(res).toEqual({ established: true })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toMatch(/\/admin\/sources$/)
	expect(init.method).toBe('POST')
	expect(JSON.parse(String(init.body))).toEqual({
		url: 'https://peer.test/feed.xml',
		attributionMode: 'aggregate',
		category: 'operator_policy',
		note: 'peer',
		commandId: 'cmd-5'
	})
})

test('establish refuses a missing commandId without calling core, and never mints one in its place', async () => {
	const fetch = vi.fn()
	expect(await actions.establish(formEvent('establish', { url: 'https://peer.test/feed.xml' }, fetch) as never)).toMatchObject({
		status: 400
	})
	expect(fetch).not.toHaveBeenCalled()
})

test('a failed establish echoes back the exact submitted commandId so a retry replays the original command', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ error: 'idempotency conflict' }), { status: 409 }))
	const res = await actions.establish(
		formEvent('establish', { url: 'https://peer.test/feed.xml', commandId: 'retry-establish' }, fetch) as never
	)
	expect((res as { data: { error: string; commandId: string } }).data).toEqual({ error: 'idempotency conflict', commandId: 'retry-establish' })
})

// --- V3: the reserved blocked/tombstoned group + tombstone unblock ------------

const tombstone = (id: string, action = 'purge') => ({
	id,
	canonicalUrl: `https://gone.test/${id}.xml`,
	action,
	category: 'illegal_content',
	note: 'court order',
	createdAt: '2026-07-20T00:00:00Z',
	aliases: [`https://gone.test/${id}-alias.xml`]
})

test('the v2 load lists tombstones (canonical URL + terminal facts) with a per-row unblock command id and the DISTINCT unblock consequence copy', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (String(url).includes('/admin/tombstones')) return new Response(JSON.stringify({ model: 'logical-v2', tombstones: [tombstone('t1'), tombstone('t2', 'block')] }), { status: 200 })
		return new Response(JSON.stringify({ items: [summary('fed', 'allowed', 'approved')], nextCursor: null }), { status: 200 })
	})
	const result = (await loadAdminWith(fetch)) as LoadResult & { tombstones?: Array<{ id: string; canonicalUrl: string; action: string; commandId: string }>; tombstoneConsequence?: string }
	expect(urlsOf(fetch).some((u) => u.includes('/admin/tombstones'))).toBe(true)
	expect(result.tombstones?.map((t) => t.id)).toEqual(['t1', 't2'])
	expect(result.tombstones?.map((t) => t.canonicalUrl)).toEqual(['https://gone.test/t1.xml', 'https://gone.test/t2.xml'])
	// one command id per rendered unblock form: distinct, stable per render
	const ids = result.tombstones?.map((t) => t.commandId) ?? []
	expect(new Set(ids).size).toBe(ids.length)
	expect(ids.every((id) => /^[0-9a-f]{8}-/.test(id))).toBe(true)
	// tombstone-unblock's consequence is DISTINCT from source-governance unblock: the
	// URL becomes creatable again, and NOTHING is restored. Pinned so a rewrite that
	// implies items come back (or a generic "Are you sure?") fails this test.
	const copy = String(result.tombstoneConsequence)
	expect(copy).toMatch(/creatable again|can be created again/i)
	expect(copy).toMatch(/nothing is restored|restores nothing/i)
})

test('with tombstones absent the section is simply empty (no crash on the unpaginated read)', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (String(url).includes('/admin/tombstones')) return new Response(JSON.stringify({ model: 'logical-v2', tombstones: [] }), { status: 200 })
		return new Response(JSON.stringify({ items: [summary('fed', 'allowed', 'approved')], nextCursor: null }), { status: 200 })
	})
	const result = (await loadAdminWith(fetch)) as LoadResult & { tombstones?: unknown[] }
	expect(result.tombstones).toEqual([])
})

test('the tombstone action posts {commandId, category, note} to /admin/tombstones/:id/unblock', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ model: 'logical-v2', kind: 'unblocked' }), { status: 200 }))
	const res = (await actions.tombstone(formEvent('tombstone', { tombstoneId: 't1', category: 'remediated', note: 'appeal upheld', commandId: 'cmd-t' }, fetch) as never)) as { unblocked: boolean; commandId: string }
	expect(res.unblocked).toBe(true)
	expect(res.commandId).toBe('cmd-t')
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/admin/tombstones/t1/unblock')
	expect(init.method).toBe('POST')
	expect(JSON.parse(String(init.body))).toEqual({ commandId: 'cmd-t', category: 'remediated', note: 'appeal upheld' })
})

test('the tombstone action refuses a missing commandId or category without calling core', async () => {
	const fetch = vi.fn()
	expect(await actions.tombstone(formEvent('tombstone', { tombstoneId: 't1', category: 'remediated' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(await actions.tombstone(formEvent('tombstone', { tombstoneId: 't1', category: '', commandId: 'c' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(await actions.tombstone(formEvent('tombstone', { tombstoneId: '', category: 'remediated', commandId: 'c' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test("a tombstone unblock that core answers 409 'not blocked' reaches the admin with the commandId echoed", async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ model: 'logical-v2', error: 'source not blocked' }), { status: 409 }))
	const res = (await actions.tombstone(formEvent('tombstone', { tombstoneId: 't1', category: 'remediated', commandId: 'dup' }, fetch) as never)) as { status: number; data: { error: string; commandId: string } }
	expect(res.status).toBe(409)
	expect(res.data.error).toBe('source not blocked')
	expect(res.data.commandId).toBe('dup')
})

// --- Task 6: instance-governed members ------------------------------------

const govSummary = (id: string, canonicalUrl: string, provenance: string, federationStatus: string, overridden = false) => ({
	source: { id, canonicalUrl, attributionMode: 'aggregate', operation: 'enabled', governance: 'allowed', provenance, adminRetained: false, overridden },
	federationStatus,
	subscriptionCounts: { active: 0, pending: 0, pendingReview: 0 }
})

test('a verification-minted member nests out of user/review; an approved-federated row governs itself even when another approved instance shares its host prefix (F14)', async () => {
	const instA = govSummary('instA', 'https://inst-a.test/feed.xml', 'user_subscription', 'approved')
	// F14: instB is itself origin-verification-provenanced AND independently
	// approved-federated — it must stay un-nested even though instA's prefix
	// (same host) also covers it.
	const instB = govSummary('instB', 'https://inst-a.test/other.xml', 'origin_verification', 'approved')
	const mem1 = govSummary('mem1', 'https://inst-a.test/origin/alice.xml', 'origin_verification', 'none')
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/members/counts')) return new Response(JSON.stringify({ members: 0, overridden: 0 }), { status: 200 })
		if (u.includes('filter=governance')) return new Response(JSON.stringify({ items: [instA, instB], nextCursor: null }), { status: 200 })
		return new Response(JSON.stringify({ items: [mem1], nextCursor: null }), { status: 200 })
	})
	const result = await loadAdminWith(fetch)
	const fed = result.groups?.find((g) => g.key === 'federation')
	const user = result.groups?.find((g) => g.key === 'user')
	const review = result.groups?.find((g) => g.key === 'review')
	expect(fed?.rows.map((r) => r.id).sort()).toEqual(['instA', 'instB'])
	expect(user?.rows.map((r) => r.id)).not.toContain('mem1')
	expect(review?.rows.map((r) => r.id)).not.toContain('mem1')
	const allVisible = result.groups?.flatMap((g) => g.rows.map((r) => r.id)) ?? []
	expect(allVisible).not.toContain('mem1')
})

test('a federated instance row carries memberCounts (members, overridden, instanceGoverned) fetched per instance', async () => {
	const inst1 = govSummary('inst1', 'https://inst-a.test/feed.xml', 'user_subscription', 'approved')
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/admin/sources/inst1/members/counts')) return new Response(JSON.stringify({ members: 5, overridden: 2 }), { status: 200 })
		if (u.includes('filter=governance')) return new Response(JSON.stringify({ items: [inst1], nextCursor: null }), { status: 200 })
		return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
	})
	const result = await loadAdminWith(fetch)
	const row = result.groups?.find((g) => g.key === 'federation')?.rows.find((r) => r.id === 'inst1')
	expect(row?.memberCounts).toEqual({ members: 5, overridden: 2, instanceGoverned: 3 })
	expect(urlsOf(fetch).some((u) => u.includes('/admin/sources/inst1/members/counts'))).toBe(true)
})

test('?expand=<id> loads that instance’s member rows only, none other', async () => {
	const inst1 = govSummary('inst1', 'https://inst1.test/feed.xml', 'user_subscription', 'approved')
	const inst2 = govSummary('inst2', 'https://inst2.test/feed.xml', 'user_subscription', 'approved')
	const mem1 = govSummary('mem1', 'https://inst1.test/origin/a.xml', 'origin_verification', 'none', true)
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/members/counts')) return new Response(JSON.stringify({ members: 1, overridden: 1 }), { status: 200 })
		if (u.includes('/admin/sources/inst2/members')) throw new Error('must not fetch inst2’s members')
		if (u.includes('/admin/sources/inst1/members')) return new Response(JSON.stringify({ items: [mem1], nextCursor: null }), { status: 200 })
		if (u.includes('filter=governance')) return new Response(JSON.stringify({ items: [inst1, inst2], nextCursor: null }), { status: 200 })
		return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
	})
	const result = await loadAdminWith(fetch, '?expand=inst1')
	expect(result.expand).toBe('inst1')
	expect(result.expandedMembers?.map((m) => m.id)).toEqual(['mem1'])
	expect(result.expandedMembers?.[0]?.overridden).toBe(true)
})

test('a verification-minted row whose host has no approved instance stays in user, flagged via verification', async () => {
	const solo = govSummary('solo1', 'https://standalone.test/origin/a.xml', 'origin_verification', 'none')
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('filter=governance')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
		return new Response(JSON.stringify({ items: [solo], nextCursor: null }), { status: 200 })
	})
	const result = await loadAdminWith(fetch)
	const row = result.groups?.find((g) => g.key === 'user')?.rows.find((r) => r.id === 'solo1')
	expect(row).toBeTruthy()
	expect(row?.viaVerification).toBe(true)
	expect(row?.isInstanceMember).toBe(false)
})

test('a core outage still throws to the error page — never an empty admin list', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response('gateway down', { status: 502 }))
	await expect(loadAdminWith(fetch)).rejects.toThrow()
})

test('the federation and review sections come from the governance fetch, not from whichever page is being viewed', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('filter=governance'))
			return new Response(
				JSON.stringify({ items: [summary('fed-buried', 'allowed', 'approved'), summary('quar-buried', 'quarantined', 'none')], nextCursor: null }),
				{ status: 200 }
			)
		return new Response(JSON.stringify({ items: [summary('bulk1', 'allowed', 'none'), summary('bulk2', 'allowed', 'none')], nextCursor: null }), { status: 200 })
	})
	const result = await loadAdminWith(fetch)
	expect(result.groups?.find((g) => g.key === 'federation')?.rows.map((r) => r.id)).toEqual(['fed-buried'])
	expect(result.groups?.find((g) => g.key === 'review')?.rows.map((r) => r.id)).toEqual(['quar-buried'])
	expect(result.groups?.find((g) => g.key === 'user')?.rows.map((r) => r.id)).toEqual(['bulk1', 'bulk2'])
})
