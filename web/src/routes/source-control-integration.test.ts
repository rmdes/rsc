import { test, expect, vi } from 'vitest'

// The whole-vertical gate (Task 10), web half. Each earlier task proved its own
// page; this file drives all three CHANGED surfaces — home, following, admin
// feeds — from ONE capability reading, the way a single web process sees them,
// in both feature states.

// Field names that exist only on the administrative projections. No ordinary
// page payload may carry any of them, asserted against the serialized payload.
const ADMIN_ONLY = ['governance', 'operation', 'provenanceNote', 'adminRetained']
const expectNoAdminFields = (payloads: unknown[]) => {
	for (const p of payloads) for (const key of ADMIN_ONLY) expect(JSON.stringify(p)).not.toContain(key)
}

const isCap = (u: unknown) => String(u).includes('/capabilities')
const cookies = { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }
const me = { user: { id: 'me1', handle: 'alice', displayName: 'Alice', kind: 'local' as const }, isAnonymous: false }

// One core, answering every route each of the three pages can call. The single
// `on` switch is the only difference between the two states.
const coreFetch = (on: boolean) =>
	vi.fn(async (url: string | URL) => {
		const u = String(url)
		const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
		if (isCap(u)) return ok({ sourceModelV2: on })
		// Under v2 the home/following rivers read the logical envelope on the SAME
		// /timeline path and now VALIDATE it (fail closed on a bad shape); legacy
		// gets the v1 shape. A malformed v2 body would correctly down the page.
		if (u.includes('/timeline')) return ok(on ? { model: 'logical-v2', lens: { kind: 'public' }, timeline: [], nextCursor: null, journalCursor: 'jc' } : { timeline: [], nextCursor: null })
		if (u.includes('/peers')) return ok({ peers: [] })
		if (u.includes('/me/following'))
			return ok({
				localFollows: [{ kind: 'local', id: 'f1', handle: 'bob', displayName: 'Bob' }],
				sourceSubscriptions: [
					{ sourceId: 's1', url: 'https://203.0.113.90/f.xml', attributionMode: 'single_publisher', subscriptionState: 'active', availability: 'available' },
					{ sourceId: 's2', url: 'https://203.0.113.91/f.xml', attributionMode: 'single_publisher', subscriptionState: 'pending', availability: 'awaiting_review' }
				]
			})
		if (u.includes('/me/subscriptions')) return on ? ok({ subscription: { sourceId: 's1', url: 'https://203.0.113.90/f.xml', attributionMode: 'single_publisher', subscriptionState: 'active', availability: 'available' } }, 201) : ok({ user: { id: 'r1', handle: 'w', displayName: 'W', kind: 'remote', feedType: 'webfeed' }, followed: true }, 201)
		if (u.includes('/me/follows/opml')) return on ? ok({ localFollowed: 0, active: 1, pending: 0, unavailable: 0, notSubscribable: 0, capSkipped: 0 }) : ok({ followed: 1, created: 1, skipped: 0 })
		if (u.includes('/follows'))
			return ok({
				following: on
					? [{ kind: 'source', sourceId: 's1', url: 'https://203.0.113.90/f.xml', displayName: 'Ex Blog' }]
					: [{ id: 'f1', handle: 'w', displayName: 'W', kind: 'remote', feedType: 'webfeed' }]
			})
		if (u.includes('/admin/sources'))
			return ok({
				items: [
					{ source: { id: 's1', canonicalUrl: 'https://203.0.113.90/f.xml', attributionMode: 'single_publisher', operation: 'enabled', governance: 'allowed', provenance: 'admin_federation', adminRetained: false }, federationStatus: 'approved', subscriptionCounts: { active: 1, pending: 0, pendingReview: 0 } }
				],
				nextCursor: null
			})
		if (u.includes('/admin/feeds')) return ok({ feeds: [{ handle: 'w', displayName: 'W', feedUrl: 'https://203.0.113.90/f.xml' }] })
		return ok({})
	})

const urlsOf = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map((c) => String(c[0]))
const bodyOf = (fetch: ReturnType<typeof vi.fn>, match: string) =>
	JSON.parse(String(((fetch.mock.calls.find((c) => String(c[0]).includes(match)) ?? [])[1] as RequestInit).body))

const homeEvent = (fetch: ReturnType<typeof vi.fn>) => ({ fetch, url: new URL('http://x/'), parent: async () => ({ me }), cookies })
const followingEvent = (fetch: ReturnType<typeof vi.fn>, handle: string) => ({ fetch, params: { handle }, url: new URL(`http://x/u/${handle}/following`), parent: async () => ({ me }), cookies })
const adminEvent = (fetch: ReturnType<typeof vi.fn>) => ({ fetch, url: new URL('http://x/admin/feeds'), cookies })
const formEvent = (action: string, fields: Record<string, string>, fetch: ReturnType<typeof vi.fn>) => ({
	request: new Request(`http://x/?/${action}`, { method: 'POST', body: new URLSearchParams(fields) }),
	fetch,
	url: new URL('http://x/'),
	cookies
})

// One reset per state = one memoized capability reading shared by all three
// page modules, exactly like one running web process.
async function pages() {
	vi.resetModules()
	return {
		home: await import('./+page.server.ts'),
		following: await import('./u/[handle]/following/+page.server.ts'),
		admin: await import('./admin/feeds/+page.server.ts')
	}
}

test('with the capability off every changed page stays legacy and /admin/sources is never requested', async () => {
	const fetch = coreFetch(false)
	const { home, following, admin } = await pages()

	const homeData = (await home.load(homeEvent(fetch) as never)) as { sourceModelV2?: boolean; subscribeCommandId?: string; coreDown?: boolean; followIds?: string[] }
	expect(homeData.sourceModelV2).toBeUndefined()
	expect(homeData.subscribeCommandId).toBeUndefined()
	expect(homeData.coreDown).toBeUndefined()
	expect(homeData.followIds).toEqual(['me1', 'f1'])

	const followingData = (await following.load(followingEvent(fetch, 'alice') as never)) as { rows?: unknown; following: Array<{ handle: string }>; coreDown?: boolean }
	expect(followingData.rows).toBeUndefined()
	expect(followingData.following.map((u) => u.handle)).toEqual(['w'])
	expect(followingData.coreDown).toBeUndefined()

	const adminData = (await admin.load(adminEvent(fetch) as never)) as { mode: string; feeds?: Array<{ handle: string }> }
	expect(adminData).toMatchObject({ mode: 'legacy' })
	expect(adminData.feeds?.map((f) => f.handle)).toEqual(['w'])

	// Legacy subscribe still posts {url,type} — no commandId anywhere.
	await expect(home.actions.subscribe(formEvent('subscribe', { url: 'https://203.0.113.90/f.xml', type: 'webfeed' }, fetch) as never)).rejects.toMatchObject({ status: 303, location: '/?tab=personal&feed=w' })
	expect(bodyOf(fetch, '/me/subscriptions')).toEqual({ url: 'https://203.0.113.90/f.xml', type: 'webfeed' })

	// Legacy OPML import carries no x-rsc-command-id header.
	const opml = new FormData()
	opml.set('opml', new File(['<opml/>'], 'feed.opml'))
	expect(await following.actions.import({ ...formEvent('import', {}, fetch), request: new Request('http://x/?/import', { method: 'POST', body: opml }) } as never)).toEqual({ ok: true, result: { followed: 1, created: 1, skipped: 0 } })
	const opmlCall = fetch.mock.calls.find((c) => String(c[0]).includes('/me/follows/opml')) as unknown as [string, RequestInit]
	expect(new Headers(opmlCall[1].headers).get('x-rsc-command-id')).toBeNull()

	// The v2-only core routes are never touched from any of the three pages.
	expect(urlsOf(fetch).some((u) => u.includes('/admin/sources'))).toBe(false)
	expect(urlsOf(fetch).some((u) => u.includes('/me/following'))).toBe(false)
	expect(urlsOf(fetch).filter(isCap)).toHaveLength(1) // one probe per web process, memoized on its 200

	expectNoAdminFields([homeData, followingData])
})

test('with the capability on all three pages switch together: subscribe, owner projection, unsubscribe, source console', async () => {
	const fetch = coreFetch(true)
	const { home, following, admin } = await pages()

	const homeData = (await home.load(homeEvent(fetch) as never)) as { sourceModelV2?: boolean; subscribeCommandId?: string; followIds?: string[] }
	expect(homeData.sourceModelV2).toBe(true)
	expect(homeData.subscribeCommandId).toMatch(/^[0-9a-f]{8}-/)
	expect(homeData.followIds).toEqual(['me1']) // a v2 source carries no local user id

	// Subscribe posts url+commandId (no `type`) and lands on the v2 flash.
	await expect(home.actions.subscribe(formEvent('subscribe', { url: 'https://203.0.113.90/f.xml', commandId: 'cmd-1' }, fetch) as never)).rejects.toMatchObject({ status: 303, location: '/?tab=personal&sub=added' })
	expect(bodyOf(fetch, '/me/subscriptions')).toEqual({ url: 'https://203.0.113.90/f.xml', commandId: 'cmd-1' })

	// The owner reads their own projection; pending renders as a neutral row.
	const ownerData = (await following.load(followingEvent(fetch, 'alice') as never)) as { rows: Array<{ kind: string; sourceId?: string; pending?: boolean; handle?: string; commandId?: string }>; commandIds?: { subscribe: string; import: string } }
	expect(ownerData.rows.map((r) => (r.kind === 'source' ? [r.sourceId, r.pending] : [r.handle, false]))).toEqual([
		['bob', false],
		['s1', false],
		['s2', true]
	])

	// A visitor gets the public projection only — pending is unreachable.
	const visitorData = (await following.load(followingEvent(fetch, 'bob') as never)) as { isOwner: boolean; rows: Array<{ kind: string; pending?: boolean; label?: string }> }
	expect(visitorData.isOwner).toBe(false)
	expect(visitorData.rows).toEqual([{ kind: 'source', sourceId: 's1', url: 'https://203.0.113.90/f.xml', label: 'Ex Blog', pending: false, commandId: '' }])

	// Unsubscribe goes by STABLE SOURCE ID, carrying the rendered form's id.
	expect(await following.actions.unsubscribe(formEvent('unsubscribe', { sourceId: 's1', commandId: 'cmd-9' }, fetch) as never)).toEqual({ ok: true })
	const del = fetch.mock.calls.find((c) => String(c[0]).includes('/me/subscriptions/s1')) as unknown as [string, RequestInit]
	expect(del[1].method).toBe('DELETE')
	expect(JSON.parse(String(del[1].body))).toEqual({ commandId: 'cmd-9' })

	// The admin page switches to the source console on the same reading.
	const adminData = (await admin.load(adminEvent(fetch) as never)) as { mode: string; groups?: Array<{ key: string; rows: Array<{ id: string }> }> }
	expect(adminData.mode).toBe('v2')
	expect(adminData.groups?.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
		['federation', ['s1']],
		['review', []],
		['user', []],
		['blocked', []]
	])
	expect(urlsOf(fetch).some((u) => u.includes('/admin/feeds'))).toBe(false)
	expect(urlsOf(fetch).filter(isCap)).toHaveLength(1)

	// Ordinary payloads only — the admin console legitimately carries these.
	expectNoAdminFields([homeData, ownerData, visitorData])
})
