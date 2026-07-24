import { test, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// V3 item-review surface (spec §7.3): the bounded evidence-review page behind
// GET /admin/items/:id + its first audit page, plus the hide/restore moderation
// forms. Same v2-only capability carve as the acquisition console: cap OFF → 404.
// Server-only test harness (no component renderer here) — the loader/actions are
// exercised directly; the no-{@html}/no-second-sanitize invariant is asserted by
// reading the .svelte source. The capability reading is memoized per module
// instance, so every load case takes a FRESH +page.server.ts.

const isCap = (u: unknown) => String(u).includes('/capabilities')
const cookies = { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }

const loadEvent = (fetch: ReturnType<typeof vi.fn>, id = 'li1') => ({
	fetch,
	params: { id },
	url: new URL(`http://x/admin/items/${id}`),
	cookies
})

function formEvent(action: string, fields: Record<string, string>, fetch: ReturnType<typeof vi.fn>, id = 'li1') {
	return {
		request: new Request(`http://x/admin/items/${id}?/${action}`, { method: 'POST', body: new URLSearchParams(fields) }),
		fetch,
		url: new URL(`http://x/admin/items/${id}`),
		cookies
	}
}

const urlsOf = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map((c) => String(c[0]))

// A detail envelope whose bounded sections are SHORTER than their true totals,
// and whose raw evidence carries a <script> payload (must survive verbatim in the
// loader — Web escapes at render, never sanitizes/strips at the data layer).
const detail = (over: Record<string, unknown> = {}) => ({
	model: 'logical-v2',
	logicalItemId: 'li1',
	origin: 'remote',
	state: 'hidden',
	hiddenAt: '2026-07-20T00:00:00Z',
	selected: { deliveryId: 'd1', publisherId: 'p1', attributionLevel: 'bound_single_publisher' },
	parentLogicalItemId: null,
	threadRootId: null,
	counts: { deliveries: 101, versions: 250, claims: 12, conflicts: 3, audit: 40 },
	deliveries: [
		{
			deliveryId: 'd1',
			sourceId: 's1',
			eligible: true,
			keyKind: 'guid',
			key: 'g1',
			firstSeenAt: '2026-07-19T00:00:00Z',
			versions: [{ observationVersionId: 'v1', arrivalAt: '2026-07-19T00:00:00Z', wireOrdinal: 0, fingerprint: 'fp1', rawEvidence: '<script>alert(1)</script> raw & unsafe' }]
		}
	],
	claims: [{ claimId: 'c1', evidenceLevel: 'bound_single_publisher', publisherId: 'p1', firstSeenAt: '2026-07-19T00:00:00Z', observationVersionId: 'v1', conflictIds: [] }],
	conflicts: [],
	verification: [{ publisherFeedUrl: 'https://pub.test/feed.xml', state: 'verified', attempts: 2, lastCheckedAt: '2026-07-20T00:00:00Z' }],
	...over
})

const auditPage = (over: Record<string, unknown> = {}) => ({
	model: 'logical-v2',
	items: [{ id: 'a1', logicalItemId: 'li1', commandId: 'cmd-a1', actorId: 'admin', actorKind: 'administrator', action: 'hide', category: 'spam', note: 'x', resultJson: '{}', createdAt: '2026-07-20T00:00:00Z' }],
	nextCursor: 'auditNext',
	...over
})

type LoadResult = Record<string, unknown>

async function loadItem(fetch: ReturnType<typeof vi.fn>, id = 'li1'): Promise<LoadResult> {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	return (await load(loadEvent(fetch, id) as never)) as LoadResult
}

async function itemAction(action: 'hide' | 'restore', fetch: ReturnType<typeof vi.fn>, fields: Record<string, string>) {
	vi.resetModules()
	const { actions } = await import('./+page.server.ts')
	return actions[action](formEvent(action, fields, fetch) as never)
}

// --- capability off / unknown item: hidden as 404 -----------------------------

test('with the capability off the item-review load is 404 and never touches /admin/items', async () => {
	const fetch = vi.fn(async (url: string | URL) => (isCap(url) ? new Response(JSON.stringify({ sourceModelV2: false }), { status: 200 }) : new Response('{}', { status: 200 })))
	await expect(loadItem(fetch)).rejects.toMatchObject({ status: 404 })
	expect(urlsOf(fetch).some((u) => u.includes('/admin/items/'))).toBe(false)
})

test('an unknown item (neutral 404 from core) is hidden as 404', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		return new Response(JSON.stringify({ model: 'logical-v2', error: 'item unavailable' }), { status: 404 })
	})
	await expect(loadItem(fetch)).rejects.toMatchObject({ status: 404 })
})

// --- capability on: the bounded detail + first audit page ----------------------

test('the item-review load reads the detail + first audit page and mints stable hide/restore command ids', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		if (String(url).includes('/audit')) return new Response(JSON.stringify(auditPage()), { status: 200 })
		return new Response(JSON.stringify(detail()), { status: 200 })
	})
	const result = await loadItem(fetch)
	expect(urlsOf(fetch).some((u) => u.includes('/admin/items/li1') && !u.includes('/audit'))).toBe(true)
	expect(urlsOf(fetch).some((u) => u.includes('/admin/items/li1/audit'))).toBe(true)
	expect((result.detail as { state: string }).state).toBe('hidden')
	expect((result.audit as unknown[]).length).toBe(1)
	expect(result.auditNextCursor).toBe('auditNext')
	// the eight V3 AuditCategory values back the required category <select>
	expect(result.categories).toEqual(['spam', 'abuse', 'illegal_content', 'compromised_source', 'operator_policy', 'false_positive', 'remediated', 'other'])
	expect(result.hideCommandId).toMatch(/^[0-9a-f]{8}-/)
	expect(result.restoreCommandId).toMatch(/^[0-9a-f]{8}-/)
	expect(result.hideCommandId).not.toBe(result.restoreCommandId)
})

test('bounded sections keep their TRUE totals in counts while the inline rows are capped', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		if (String(url).includes('/audit')) return new Response(JSON.stringify(auditPage()), { status: 200 })
		return new Response(JSON.stringify(detail()), { status: 200 })
	})
	const result = await loadItem(fetch)
	const d = result.detail as { counts: Record<string, number>; deliveries: unknown[] }
	// the true total (101) survives even though only 1 delivery row is inlined — the
	// count is core's, never recomputed from the capped array length.
	expect(d.counts.deliveries).toBe(101)
	expect(d.deliveries.length).toBe(1)
})

test('raw evidence survives the loader VERBATIM (Web escapes at render, never sanitizes/strips at the data layer)', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		if (String(url).includes('/audit')) return new Response(JSON.stringify(auditPage()), { status: 200 })
		return new Response(JSON.stringify(detail()), { status: 200 })
	})
	const result = await loadItem(fetch)
	const raw = (result.detail as { deliveries: { versions: { rawEvidence: string }[] }[] }).deliveries[0].versions[0].rawEvidence
	expect(raw).toBe('<script>alert(1)</script> raw & unsafe') // unchanged: no strip, no escape, no re-encode
})

test('the verification section passes through, and an item never scheduled stays empty', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		if (String(url).includes('/audit')) return new Response(JSON.stringify(auditPage()), { status: 200 })
		return new Response(JSON.stringify(detail({ verification: [] })), { status: 200 })
	})
	const empty = await loadItem(fetch)
	expect((empty.detail as { verification: unknown[] }).verification).toEqual([])

	const fetch2 = vi.fn(async (url: string | URL) => {
		if (isCap(url)) return new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
		if (String(url).includes('/audit')) return new Response(JSON.stringify(auditPage()), { status: 200 })
		return new Response(JSON.stringify(detail()), { status: 200 })
	})
	const full = await loadItem(fetch2)
	expect((full.detail as { verification: { publisherFeedUrl: string; state: string; attempts: number }[] }).verification[0]).toMatchObject({ publisherFeedUrl: 'https://pub.test/feed.xml', state: 'verified', attempts: 2 })
})

// --- hide / restore actions: post {commandId, category, note?} -----------------

test('the hide action posts the commandId, category and note to /admin/items/:id/hide', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ model: 'logical-v2', kind: 'applied' }), { status: 200 }))
	const res = await itemAction('hide', fetch, { itemId: 'li1', category: 'spam', note: 'repeat', commandId: 'cmd-1' })
	expect(res).toEqual({ done: 'hide', commandId: 'cmd-1' })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/admin/items/li1/hide')
	expect(init.method).toBe('POST')
	expect(JSON.parse(String(init.body))).toEqual({ commandId: 'cmd-1', category: 'spam', note: 'repeat' })
	expect(new Headers(init.headers).get('cookie')).toBe('rsc.session_token=s1')
})

test('the restore action posts to /admin/items/:id/restore and omits an empty note', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ model: 'logical-v2', kind: 'applied' }), { status: 200 }))
	const res = await itemAction('restore', fetch, { itemId: 'li1', category: 'false_positive', commandId: 'cmd-2' })
	expect(res).toEqual({ done: 'restore', commandId: 'cmd-2' })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/admin/items/li1/restore')
	expect(JSON.parse(String(init.body))).toEqual({ commandId: 'cmd-2', category: 'false_positive' })
})

test('a hide/restore refuses a missing commandId or category without calling core, and never mints one', async () => {
	const fetch = vi.fn()
	expect(await itemAction('hide', fetch, { itemId: 'li1', category: 'spam' })).toMatchObject({ status: 400 })
	expect(await itemAction('hide', fetch, { itemId: 'li1', category: 'spam', commandId: '' })).toMatchObject({ status: 400 })
	expect(await itemAction('hide', fetch, { itemId: 'li1', category: '', commandId: 'c' })).toMatchObject({ status: 400 })
	expect(await itemAction('restore', fetch, { itemId: '', category: 'restored', commandId: 'c' })).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('a neutral 404 (item unavailable) fails without leaking the core body', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ model: 'logical-v2', error: 'item unavailable' }), { status: 404 }))
	const res = (await itemAction('hide', fetch, { itemId: 'li1', category: 'spam', commandId: 'gone' })) as { status: number; data: { error: string; commandId: string } }
	expect(res.status).toBe(404)
	expect(res.data.commandId).toBe('gone') // retained for replay
})

test("core's distinct state-conflict 409s reach the admin verbatim, with the commandId echoed for replay", async () => {
	for (const err of ['local origin', 'not applicable', 'idempotency conflict']) {
		const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ model: 'logical-v2', error: err }), { status: 409 }))
		const res = (await itemAction('restore', fetch, { itemId: 'li1', category: 'restored', commandId: 'retry-me' })) as { status: number; data: { error: string; commandId: string } }
		expect(res.status).toBe(409)
		expect(res.data.error).toBe(err)
		expect(res.data.commandId).toBe('retry-me')
	}
})

// --- the load-bearing render invariant (asserted against the .svelte source) ---

test('the item-review page introduces NO second sanitize path and NO {@html}', () => {
	const svelte = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8')
	expect(svelte).not.toContain('{@html')
	expect(svelte).not.toMatch(/server\/render/) // raw evidence is escaped text, never routed through the sanitize twin
	expect(svelte).not.toContain('sanitize')
})
