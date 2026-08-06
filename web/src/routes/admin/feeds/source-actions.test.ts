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
	subscriptionCounts: { active: 1, pending: 0, pendingReview: 0 },
	retention: null,
	addedBy: [] as { handle: string; displayName: string }[]
})

// An orphan-filter row: core only fills in `retention` (non-null) for
// `filter=orphan` results — addedBy is always empty here too, since an
// orphan by definition has zero subscriptions of any kind.
const orphanSummary = (id: string, retention: 'instance_member' | 'verified_origin' | 'audit_history' | 'admin_retained' | 'reapable') => ({
	source: { id, canonicalUrl: `https://orphan.test/${id}.xml`, attributionMode: 'single_publisher', operation: 'enabled', governance: 'allowed', provenance: 'user_subscription', adminRetained: false },
	federationStatus: 'none',
	subscriptionCounts: { active: 0, pending: 0, pendingReview: 0 },
	retention,
	addedBy: [] as { handle: string; displayName: string }[]
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
	addedBy: { handle: string; displayName: string }[]
	subscriberTotal: number
	actions: Array<{ action: string; commandId: string }>
}
type OrphanRow = { id: string; url: string; retention: string | null; commandId: string }
type Group = { key: string; title: string; blurb: string; rows: Row[] }
type LoadResult = {
	groups?: Group[]
	cursor?: string | null
	nextCursor?: string | null
	establishCommandId?: string
	expand?: string | null
	expandedMembers?: Row[]
	q?: string | null
	orphanRows?: OrphanRow[]
	orphanCursor?: string | null
	orphanNextCursor?: string | null
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

test('bulkSource posts the same per-source endpoint once per row, using each row\'s OWN commandId, and returns per-row outcomes', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/s1/quarantine')) return new Response(JSON.stringify({ source: {} }), { status: 200 })
		if (u.includes('/s2/quarantine')) return new Response(JSON.stringify({ error: 'invalid transition' }), { status: 409 })
		throw new Error(`unexpected fetch ${u}`)
	})
	// Task 5's request shape (as corrected mid-execution): ONE candidate per
	// checked row — the checkbox's own value, "sourceId|action:commandId|…"
	// listing every action that row offers. The clicked `action` picks each
	// row's matching commandId; s3 offers only `block`, so it is skipped.
	const form = new URLSearchParams()
	form.append('action', 'quarantine')
	form.append('candidate', 's1|quarantine:cmd-s1|block:cmd-s1-block')
	form.append('candidate', 's2|quarantine:cmd-s2')
	form.append('candidate', 's3|block:cmd-s3')
	form.append('category', 'spam')
	const res = (await actions.bulkSource({
		request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: form }),
		fetch,
		url: new URL('http://x/admin/feeds'),
		cookies
	} as never)) as { bulkResults: { sourceId: string; ok: boolean; error?: string }[]; bulkAction: string }
	expect(res.bulkAction).toBe('quarantine')
	// A FAILED row echoes the command id core already saw. `load()` re-mints
	// every row's ids on the invalidateAll that follows this submit, so without
	// the echo the retry would carry a different id and core's ledger would read
	// it as a second command instead of a replay (design §11).
	expect(res.bulkResults).toEqual([
		{ sourceId: 's1', ok: true },
		{ sourceId: 's2', ok: false, error: 'invalid transition', commandId: 'cmd-s2' }
	])
	expect(fetch).toHaveBeenCalledTimes(2)
	const [s1Url, s1Init] = fetch.mock.calls.find((c) => String(c[0]).includes('/s1/'))! as unknown as [string, RequestInit]
	expect(s1Url).toContain('/admin/sources/s1/quarantine')
	expect(JSON.parse(String(s1Init.body))).toEqual({ commandId: 'cmd-s1', category: 'spam' })
})

test('bulkSource refuses attribution-mode and unknown actions without calling core', async () => {
	const fetch = vi.fn()
	for (const action of ['attribution-mode', 'constructor', 'purge']) {
		const form = new URLSearchParams()
		form.append('action', action)
		form.append('candidate', `s1|${action}:cmd-1`)
		form.append('category', 'spam')
		const res = await actions.bulkSource({ request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)
		expect(res).toMatchObject({ status: 400 })
	}
	expect(fetch).not.toHaveBeenCalled()
})

test('bulkSource with zero selected rows is a no-op, not an error', async () => {
	const fetch = vi.fn()
	const form = new URLSearchParams()
	form.append('action', 'quarantine')
	const res = (await actions.bulkSource({ request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)) as { bulkResults: unknown[] }
	expect(res.bulkResults).toEqual([])
	expect(fetch).not.toHaveBeenCalled()
})

// A checked row that doesn't offer the clicked action is SKIPPED, not an
// error: the toolbar offers the union of the group's actions until JS narrows
// it to the selection's intersection, so a no-JS admin can legitimately click
// "Quarantine" with a blocked row checked. Same for a value with no usable
// pair at all — nothing reaches core with an undefined commandId.
test('bulkSource silently skips a checked row that does not offer the clicked action', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ source: {} }), { status: 200 }))
	const form = new URLSearchParams()
	form.append('action', 'quarantine')
	form.append('candidate', 's1|quarantine:cmd-s1')
	form.append('candidate', 's2|unblock:cmd-s2|pause:cmd-s2-pause') // a blocked row: no quarantine
	form.append('category', 'spam')
	const res = (await actions.bulkSource({ request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)) as {
		bulkResults: { sourceId: string; ok: boolean }[]
	}
	expect(res.bulkResults).toEqual([{ sourceId: 's1', ok: true }])
	expect(fetch).toHaveBeenCalledTimes(1)
	expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toContain('/admin/sources/s1/quarantine')
})

test('bulkSource treats a candidate with no usable action:commandId pair as nothing to do, never a call with an undefined id', async () => {
	const fetch = vi.fn()
	for (const candidate of ['', 's1', 's1|', 's1|quarantine:', '|quarantine:cmd-1', 's1|block:cmd-1']) {
		const form = new URLSearchParams()
		form.append('action', 'quarantine')
		form.append('candidate', candidate)
		form.append('category', 'spam')
		const res = (await actions.bulkSource({ request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)) as { bulkResults: unknown[] }
		expect(res.bulkResults).toEqual([])
	}
	expect(fetch).not.toHaveBeenCalled()
})

test('bulkSource requires a category unless every action is pause/resume', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
	const withoutCategory = new URLSearchParams()
	withoutCategory.append('action', 'quarantine')
	withoutCategory.append('candidate', 's1|quarantine:cmd-1')
	expect(await actions.bulkSource({ request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: withoutCategory }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)).toMatchObject({ status: 400 })

	const pauseForm = new URLSearchParams()
	pauseForm.append('action', 'pause')
	pauseForm.append('candidate', 's1|pause:cmd-1')
	const pauseRes = (await actions.bulkSource({ request: new Request('http://x/admin/feeds?/bulkSource', { method: 'POST', body: pauseForm }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)) as { bulkResults: { ok: boolean }[] }
	expect(pauseRes.bulkResults[0].ok).toBe(true)
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
	subscriptionCounts: { active: 0, pending: 0, pendingReview: 0 },
	retention: null,
	addedBy: [] as { handle: string; displayName: string }[]
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

// C1 (whole-branch review): the admin UI had no way to moderate a nested
// member at all — the +page.svelte fix (a shared Manage-panel snippet,
// covered by feeds.render.test.ts) relies on this exact data already being
// present on a member row. Pin it here so the SAME `?/source` action/id
// shape a governance form posts for an ordinary row is confirmed present
// for a member row too.
test('a member row carries a working governance action (quarantine) targeting its OWN id, same shape as an ordinary row', async () => {
	const inst1 = govSummary('inst1', 'https://inst1.test/feed.xml', 'user_subscription', 'approved')
	const mem1 = govSummary('mem1', 'https://inst1.test/origin/a.xml', 'origin_verification', 'none')
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/members/counts')) return new Response(JSON.stringify({ members: 1, overridden: 0 }), { status: 200 })
		if (u.includes('/admin/sources/inst1/members')) return new Response(JSON.stringify({ items: [mem1], nextCursor: null }), { status: 200 })
		if (u.includes('filter=governance')) return new Response(JSON.stringify({ items: [inst1], nextCursor: null }), { status: 200 })
		return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
	})
	const result = await loadAdminWith(fetch, '?expand=inst1')
	const member = result.expandedMembers?.[0]
	expect(member?.id).toBe('mem1')
	const quarantine = member?.actions.find((a) => a.action === 'quarantine')
	expect(quarantine).toBeTruthy()
	expect(quarantine?.commandId).toMatch(/^[0-9a-f-]{36}$/)
	// Posting this action goes through the same `source` form action as any
	// ordinary row, keyed on the MEMBER's own id — never the instance's.
	const res = await actions.source(formEvent('source', { sourceId: member!.id, action: 'quarantine', category: 'operator_policy', commandId: quarantine!.commandId }, fetch) as never)
	expect(res).toEqual({ done: 'quarantine' })
	const call = fetch.mock.calls.find((c) => String(c[0]).includes('/quarantine'))!
	expect(String(call[0])).toContain(`/admin/sources/${member!.id}/quarantine`)
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

// The `overridden` bit defaults to 1 at the schema level for every pre-existing
// row (migration 19) — it's noise unless the row is actually a governed member.
test('overridden is suppressed for a non-member row even when the raw source carries overridden=true', async () => {
	const independentInstance = govSummary('inst1', 'https://inst-a.test/feed.xml', 'user_subscription', 'approved', true)
	const soloVerification = govSummary('solo1', 'https://standalone.test/origin/a.xml', 'origin_verification', 'none', true)
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/members/counts')) return new Response(JSON.stringify({ members: 0, overridden: 0 }), { status: 200 })
		if (u.includes('filter=governance')) return new Response(JSON.stringify({ items: [independentInstance], nextCursor: null }), { status: 200 })
		return new Response(JSON.stringify({ items: [soloVerification], nextCursor: null }), { status: 200 })
	})
	const result = await loadAdminWith(fetch)
	const instRow = result.groups?.find((g) => g.key === 'federation')?.rows.find((r) => r.id === 'inst1')
	const soloRow = result.groups?.find((g) => g.key === 'user')?.rows.find((r) => r.id === 'solo1')
	expect(instRow?.overridden).toBe(false)
	expect(soloRow?.overridden).toBe(false)
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

// --- Task 4: search, the orphan group, and operator reap ---------------------

test('?q= is threaded into the ordinary sources fetch and echoed back on the load result', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('filter=orphan') || u.includes('filter=governance')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
		return new Response(JSON.stringify({ items: [summary('bulk1', 'allowed', 'none')], nextCursor: null }), { status: 200 })
	})
	const result = await loadAdminWith(fetch, '?q=example.test')
	expect(result.q).toBe('example.test')
	// The ordinary (unfiltered/ungoverned) sources fetch carries q= — the
	// governance and orphan fetches (and the unrelated tombstones read) are
	// independent reads and never receive it.
	const ordinaryCall = urlsOf(fetch).find((u) => u.includes('/admin/sources') && !u.includes('filter='))
	expect(ordinaryCall).toContain('q=example.test')
	expect(urlsOf(fetch).filter((u) => u.includes('filter=')).some((u) => u.includes('q='))).toBe(false)
})

test('no ?q= on the request omits it from every fetch and echoes result.q as null', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }))
	const result = await loadAdminWith(fetch)
	expect(result.q).toBeNull()
	expect(urlsOf(fetch).some((u) => u.includes('q='))).toBe(false)
})

test('the orphan group is fetched with filter=orphan, maps retention/commandId per row, and paginates on its OWN ?orphanCursor= param, independent of ?cursor=', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('filter=orphan')) return new Response(JSON.stringify({ items: [orphanSummary('orph1', 'verified_origin'), orphanSummary('orph2', 'reapable')], nextCursor: 'orph-next' }), { status: 200 })
		if (u.includes('filter=governance')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
		return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
	})
	const result = await loadAdminWith(fetch, '?cursor=ordinary-page2&orphanCursor=orph-page2')
	expect(result.orphanRows?.map((r) => [r.id, r.url, r.retention])).toEqual([
		['orph1', 'https://orphan.test/orph1.xml', 'verified_origin'],
		['orph2', 'https://orphan.test/orph2.xml', 'reapable']
	])
	expect(result.orphanCursor).toBe('orph-page2') // echoed back like `cursor`, not conflated with it
	expect(result.orphanNextCursor).toBe('orph-next')
	// One command id per row now (not two) — the row renders exactly one
	// reap form, plain or force, decided by retention, never both.
	for (const r of result.orphanRows ?? []) {
		expect(r.commandId).toMatch(/^[0-9a-f]{8}-/)
		expect('forceCommandId' in r).toBe(false)
	}
	// The orphan fetch used ITS OWN cursor param, never the ordinary list's.
	const orphanCall = urlsOf(fetch).find((u) => u.includes('filter=orphan'))
	expect(orphanCall).toContain('cursor=orph-page2')
	expect(orphanCall).not.toContain('cursor=ordinary-page2')
})

// --- Task 9: ?detail= inlines a source's own detail panel via loadSourceDetail ---

test('?detail=<id> inlines that source\'s detail panel data into the feeds load result', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('filter=orphan') || u.includes('filter=governance')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
		if (u.includes('/admin/tombstones')) return new Response(JSON.stringify({ model: 'logical-v2', tombstones: [] }), { status: 200 })
		if (u.includes('/admin/sources/s1/runs')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
		if (u.includes('/admin/sources/s1/items')) return new Response(JSON.stringify({ model: 'logical-v2', items: [], nextCursor: null, conflictCount: 0 }), { status: 200 })
		if (u.includes('/admin/sources/s1')) return new Response(JSON.stringify({ source: { id: 's1', canonicalUrl: 'https://ex.test/feed.xml', attributionMode: 'single_publisher', operation: 'enabled', governance: 'allowed' } }), { status: 200 })
		return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })
	})
	const result = (await loadAdminWith(fetch, '?detail=s1')) as LoadResult & { detail?: { sourceId: string; source: { canonicalUrl: string } } | null }
	expect(result.detail?.sourceId).toBe('s1')
	expect(result.detail?.source.canonicalUrl).toBe('https://ex.test/feed.xml')
})

test('no ?detail= on the request omits the detail fetches and echoes detail: null', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }))
	const result = (await loadAdminWith(fetch)) as LoadResult & { detail?: unknown }
	expect(result.detail).toBeNull()
	expect(urlsOf(fetch).some((u) => u.includes('/runs') || u.includes('/items'))).toBe(false)
})

test('the reap action refuses a missing sourceId/commandId without calling core', async () => {
	const fetch = vi.fn()
	expect(await actions.reap(formEvent('reap', { commandId: 'c' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(await actions.reap(formEvent('reap', { sourceId: 's1' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(await actions.reap(formEvent('reap', { sourceId: 's1', commandId: '' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('a plain (no-force) reap posts {commandId} with no force key, and succeeds on {kind: reaped}', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ kind: 'reaped' }), { status: 200 }))
	const res = await actions.reap(formEvent('reap', { sourceId: 's1', commandId: 'cmd-1' }, fetch) as never)
	expect(res).toEqual({ reaped: true })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/admin/sources/s1/reap')
	expect(init.method).toBe('POST')
	expect(JSON.parse(String(init.body))).toEqual({ commandId: 'cmd-1' })
})

// The three reasons core's reapSource will actually lift when force:true is
// sent (see source-repository.ts's `!opts.force &&` guards) — the operator-
// reap feature's whole point. Same fixture/assertion shape for all three:
// the action is reason-agnostic, it just echoes whatever core said verbatim.
for (const reason of ['verified_origin_evidence', 'admin_retained', 'audit_history']) {
	test(`a ${reason} refusal on the plain reap 409s and echoes sourceId/commandId/force:false so the page can offer the SEPARATE force-confirm form`, async () => {
		const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ error: reason }), { status: 409 }))
		const res = await actions.reap(formEvent('reap', { sourceId: 's1', commandId: 'cmd-1' }, fetch) as never)
		expect(res).toMatchObject({ status: 400 })
		expect((res as { data: { error: string; sourceId: string; commandId: string; force: boolean } }).data).toEqual({
			error: reason,
			sourceId: 's1',
			commandId: 'cmd-1',
			force: false
		})
	})
}

test('the confirm-with-force reap posts {commandId, force: true} with a DIFFERENT commandId than the refused attempt, and succeeds', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ kind: 'reaped' }), { status: 200 }))
	const res = await actions.reap(formEvent('reap', { sourceId: 's1', commandId: 'force-cmd-2', force: 'true' }, fetch) as never)
	expect(res).toEqual({ reaped: true })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/admin/sources/s1/reap')
	expect(JSON.parse(String(init.body))).toEqual({ commandId: 'force-cmd-2', force: true })
	// This is a genuinely different id than any plain-attempt commandId would
	// have been — the action itself never re-derives or reuses one.
	expect(init.body).not.toContain('cmd-1')
})

test('a network error on reap echoes sourceId/commandId/force so a retry can replay the exact same command', async () => {
	const throwingFetch = vi.fn(async () => {
		throw new Error('response lost')
	})
	const res = await actions.reap(formEvent('reap', { sourceId: 's9', commandId: 'retry-me', force: 'true' }, throwingFetch) as never)
	expect((res as { data: { sourceId: string; commandId: string; force: boolean } }).data).toMatchObject({ sourceId: 's9', commandId: 'retry-me', force: true })
})

test('bulkReap posts per-row force values independently — a mixed batch sends force only for the rows that need it', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/orph1/reap')) return new Response(JSON.stringify({ kind: 'reaped' }), { status: 200 })
		// orph2 REFUSES: the per-row force assertion below is about the request
		// body, so failing it here costs the test nothing and lets the same case
		// cover the failed-row command-id echo (design §11, as bulkSource does).
		if (u.includes('/orph2/reap')) return new Response(JSON.stringify({ error: 'has_subscribers' }), { status: 409 })
		throw new Error(`unexpected fetch ${u}`)
	})
	const form = new URLSearchParams()
	form.append('candidate', 'orph1:cmd-orph1:false')
	form.append('candidate', 'orph2:cmd-orph2:true')
	const res = (await actions.bulkReap({ request: new Request('http://x/admin/feeds?/bulkReap', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)) as { bulkReapResults: { sourceId: string; ok: boolean }[] }
	expect(res.bulkReapResults).toEqual([
		{ sourceId: 'orph1', ok: true },
		{ sourceId: 'orph2', ok: false, error: 'has_subscribers', commandId: 'cmd-orph2' }
	])
	const [orph1Url, orph1Init] = fetch.mock.calls.find((c) => String(c[0]).includes('orph1'))! as unknown as [string, RequestInit]
	expect(JSON.parse(String(orph1Init.body))).toEqual({ commandId: 'cmd-orph1' })
	const [, orph2Init] = fetch.mock.calls.find((c) => String(c[0]).includes('orph2'))! as unknown as [string, RequestInit]
	expect(JSON.parse(String(orph2Init.body))).toEqual({ commandId: 'cmd-orph2', force: true })
})

test('bulkReap with zero candidates is a no-op', async () => {
	const fetch = vi.fn()
	const res = (await actions.bulkReap({ request: new Request('http://x/admin/feeds?/bulkReap', { method: 'POST', body: new URLSearchParams() }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)) as { bulkReapResults: unknown[] }
	expect(res.bulkReapResults).toEqual([])
	expect(fetch).not.toHaveBeenCalled()
})

test('bulkTombstone posts {commandId, category, note} per selected tombstone and reports per-row outcomes', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/t1/unblock')) return new Response(JSON.stringify({ model: 'logical-v2', kind: 'unblocked' }), { status: 200 })
		if (u.includes('/t2/unblock')) return new Response(JSON.stringify({ model: 'logical-v2', error: 'source not blocked' }), { status: 409 })
		throw new Error(`unexpected fetch ${u}`)
	})
	const form = new URLSearchParams()
	form.append('candidate', 't1:cmd-t1')
	form.append('candidate', 't2:cmd-t2')
	form.append('category', 'remediated')
	form.append('note', 'appeal upheld')
	const res = (await actions.bulkTombstone({ request: new Request('http://x/admin/feeds?/bulkTombstone', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)) as { bulkTombstoneResults: { tombstoneId: string; ok: boolean; error?: string }[] }
	expect(res.bulkTombstoneResults).toEqual([
		{ tombstoneId: 't1', ok: true },
		{ tombstoneId: 't2', ok: false, error: 'source not blocked', commandId: 'cmd-t2' }
	])
	const [, t1Init] = fetch.mock.calls.find((c) => String(c[0]).includes('t1'))! as unknown as [string, RequestInit]
	expect(JSON.parse(String(t1Init.body))).toEqual({ commandId: 'cmd-t1', category: 'remediated', note: 'appeal upheld' })
})

test('bulkTombstone refuses a missing category without calling core', async () => {
	const fetch = vi.fn()
	const form = new URLSearchParams()
	form.append('candidate', 't1:cmd-t1')
	const res = await actions.bulkTombstone({ request: new Request('http://x/admin/feeds?/bulkTombstone', { method: 'POST', body: form }), fetch, url: new URL('http://x/admin/feeds'), cookies } as never)
	expect(res).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

// The inline ?detail= panel's refresh/purge used to be hand-copied duplicates of
// sources/[sourceId]/+page.server.ts's, carrying a "kept in sync by hand"
// comment. They are now literally the same two functions (their behaviour is
// covered by source-detail.test.ts's refresh/purge cases) — this is the guard
// that fails if someone re-inlines a copy and the two drift again.
test('the feeds route mounts the SHARED refresh/purge handlers rather than its own copies', () => {
	// Identity (`toBe` against an imported reference) can't be used here: the
	// vitest transform resolves `$lib/...` and the `./+page.server.ts` import
	// chain to two module instances. The function NAME is the durable signal —
	// a re-inlined copy would be an anonymous/`refresh`-named arrow, not the
	// shared named declaration.
	expect(actions.refresh?.name).toBe('refreshAction')
	expect(actions.purge?.name).toBe('purgeAction')
})
