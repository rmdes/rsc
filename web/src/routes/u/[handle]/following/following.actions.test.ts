import { test, expect, vi } from 'vitest'
import { actions, load } from './+page.server.ts'

function formRequest(action: string, fields: Record<string, string>): Request {
	const body = new URLSearchParams(fields)
	return new Request(`http://x/?/${action}`, { method: 'POST', body })
}

function importRequest(opml: string): Request {
	const body = new FormData()
	body.set('opml', new File([opml], 'feed.opml'))
	return new Request('http://x/?/import', { method: 'POST', body })
}

// A session cookie already present → no mint path runs; ensureSessionFetch
// just wraps `fetch` with the Cookie/Origin headers.
function sessionedEvent(request: Request, fetch: ReturnType<typeof vi.fn>) {
	return {
		request,
		fetch,
		url: new URL('http://x/'),
		cookies: { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }
	}
}

function anonymousEvent(request: Request, fetch: ReturnType<typeof vi.fn>) {
	return {
		request,
		fetch,
		url: new URL('http://x/'),
		cookies: { getAll: () => [], set: vi.fn(), delete: vi.fn() },
		getClientAddress: () => '203.0.113.5'
	}
}

test('follow posts to core (session already present, no mint)', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 201 }))
	const event = sessionedEvent(formRequest('follow', { target: 'alice' }), fetch)
	const res = await actions.follow(event as never)
	expect(res).toEqual({ ok: true })
	expect(fetch).toHaveBeenCalledTimes(1) // no mint call — the session cookie already exists
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/me/follows')
	expect(String((init as { method?: string }).method)).toBe('POST')
	const headers = new Headers(init.headers)
	expect(headers.get('cookie')).toBe('rsc.session_token=s1')
	expect(headers.get('origin')).toBe('http://x')
	expect(JSON.parse(String(init.body))).toEqual({ handle: 'alice' })
})

test('follow mints an anonymous session first when there is none yet, then relays it', async () => {
	const mintRes = new Response(null, {
		headers: { 'set-cookie': 'rsc.session_token=minted; Path=/; HttpOnly; Max-Age=600' }
	})
	const fetch = vi.fn(async (url: string | URL | Request, ..._rest: unknown[]) =>
		String(url).includes('/sign-in/anonymous') ? mintRes : new Response(null, { status: 201 })
	)
	const event = anonymousEvent(formRequest('follow', { target: 'alice' }), fetch)
	const res = await actions.follow(event as never)
	expect(res).toEqual({ ok: true })
	expect(fetch).toHaveBeenCalledTimes(2) // mint, then the sessioned addFollow call
	expect(String(fetch.mock.calls[0][0])).toContain('/sign-in/anonymous')
	const followInit = fetch.mock.calls[1][1] as RequestInit
	expect(new Headers(followInit.headers).get('cookie')).toBe('rsc.session_token=minted')
	expect(event.cookies.set).toHaveBeenCalledWith('rsc.session_token', 'minted', expect.objectContaining({ path: '/' }))
})

test('unfollow deletes the target via the core with the session cookie', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 204 }))
	const event = sessionedEvent(formRequest('unfollow', { target: 'bob' }), fetch)
	const res = await actions.unfollow(event as never)
	expect(res).toEqual({ ok: true })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/me/follows/bob')
	expect(String((init as { method?: string }).method)).toBe('DELETE')
	expect(new Headers(init.headers).get('cookie')).toBe('rsc.session_token=s1')
})

test('import NEVER mints a session — registered-only, core 403s anonymous', async () => {
	vi.resetModules()
	const { actions } = await import('./+page.server.ts')
	const fetch = vi.fn(async (url: string | URL, ..._rest: unknown[]) =>
		String(url).includes('/capabilities')
			? new Response(JSON.stringify({ sourceModelV2: false }), { status: 200 })
			: new Response(JSON.stringify({ error: 'not authenticated' }), { status: 401 })
	)
	const event = anonymousEvent(importRequest('<opml/>'), fetch)
	const res = await actions.import(event as never)
	expect(fetch.mock.calls.some((c) => String(c[0]).includes('/sign-in/anonymous'))).toBe(false) // no mint call ever
	const importCall = fetch.mock.calls.find((c) => String(c[0]).includes('/me/follows/opml')) as [string, RequestInit]
	expect(importCall).toBeDefined()
	const headers = new Headers(importCall[1].headers)
	expect(headers.get('cookie')).toBeNull() // no session to forward
	expect(headers.get('origin')).toBe('http://x')
	expect(res).toMatchObject({ status: 400 })
	expect((res as { data: { error: string } }).data.error).toBe('not authenticated')
})

test('following load lowercases the handle, computes isOwner, and instance-filters followIds', async () => {
	const fetch = vi.fn(async (url: string | URL) =>
		String(url).includes('/follows')
			? new Response(JSON.stringify({ following: [
					{ id: 'f1', handle: 'w', displayName: 'W', kind: 'remote', feedType: 'webfeed' },
					{ id: 'f2', handle: 'i', displayName: 'I', kind: 'remote', feedType: 'instance' }
				] }), { status: 200 })
			: new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 })
	)
	const me = { user: { id: 'me1', handle: 'alice', displayName: 'Alice', kind: 'local' as const }, isAnonymous: false }
	const owner = (await load({ fetch, params: { handle: 'Alice' }, url: new URL('http://x/u/Alice/following'), parent: async () => ({ me }) } as never)) as { handle: string; isOwner: boolean; followIds: string[] }
	expect(owner.handle).toBe('alice')
	expect(owner.isOwner).toBe(true)
	expect(owner.followIds).toEqual(['f1'])
	const timelineCall = fetch.mock.calls.map((c) => String(c[0])).find((s) => s.includes('/timeline'))
	expect(timelineCall).toContain('followed_by=alice')
	expect(timelineCall).toContain('top_level=1')
	const visitor = (await load({ fetch, params: { handle: 'bob' }, url: new URL('http://x/u/bob/following'), parent: async () => ({ me }) } as never)) as { isOwner: boolean }
	expect(visitor.isOwner).toBe(false)
})

// --- v2 source registry (RSC_SOURCE_MODEL_V2) -------------------------------
// The capability reading is memoized per module instance, so each case below
// imports a FRESH +page.server.ts rather than adding a production reset hook.

const isCap = (u: unknown) => String(u).includes('/capabilities')
const me = { user: { id: 'me1', handle: 'alice', displayName: 'Alice', kind: 'local' as const }, isAnonymous: false }
const sessionedLoad = (fetch: ReturnType<typeof vi.fn>, handle: string) => ({
	fetch,
	params: { handle },
	url: new URL(`http://x/u/${handle}/following`),
	parent: async () => ({ me }),
	cookies: { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }
})

type Row = { kind: 'local'; id: string; handle: string } | { kind: 'source'; sourceId: string; url: string; label: string; pending: boolean; commandId: string }

test('with the capability on, the owner reads /me/following and sees pending as a neutral row', async () => {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	const fetch = vi.fn(async (url: string | URL) =>
		isCap(url)
			? new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
			: String(url).includes('/me/following')
				? new Response(
						JSON.stringify({
							localFollows: [{ kind: 'local', id: 'f1', handle: 'bob', displayName: 'Bob' }],
							sourceSubscriptions: [
								{ sourceId: 's1', url: 'https://ex.com/f.xml', attributionMode: 'single_publisher', subscriptionState: 'active', availability: 'available' },
								{ sourceId: 's2', url: 'https://new.example/f.xml', attributionMode: 'aggregate', subscriptionState: 'pending', availability: 'awaiting_review' }
							]
						}),
						{ status: 200 }
					)
				: String(url).includes('/follows')
					? new Response(JSON.stringify({ following: [] }), { status: 200 })
					: new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 })
	)
	const result = (await load(sessionedLoad(fetch, 'alice') as never)) as { sourceModelV2?: boolean; rows?: Row[]; followIds: string[]; commandIds?: { subscribe: string; import: string } }
	expect(String(fetch.mock.calls[0][0])).toContain('/timeline') // capability never runs ahead of the legacy call
	expect(result.sourceModelV2).toBe(true)
	expect(result.rows?.map((r) => (r.kind === 'source' ? [r.sourceId, r.pending] : [r.handle, false]))).toEqual([
		['bob', false],
		['s1', false],
		['s2', true]
	])
	// Ordinary rows carry NO governance/operation/provenance/retention state.
	for (const r of result.rows ?? []) expect(Object.keys(r).some((k) => /governance|operation|provenance|adminRetained|attributionMode|availability|subscriptionState/.test(k))).toBe(false)
	const authed = fetch.mock.calls.find((c) => String(c[0]).includes('/me/following')) as unknown as [string, RequestInit]
	expect(new Headers(authed[1].headers).get('cookie')).toBe('rsc.session_token=s1')
	expect(result.followIds).toEqual(['f1'])
	expect(result.commandIds?.subscribe).toMatch(/^[0-9a-f]{8}-/)
	expect(result.commandIds?.import).not.toBe(result.commandIds?.subscribe)
})

test('with the capability on, a visitor reads the public projection only — /me/following is never called', async () => {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	const fetch = vi.fn(async (url: string | URL) =>
		isCap(url)
			? new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
			: String(url).includes('/follows')
				? new Response(
						JSON.stringify({
							following: [
								{ kind: 'local', id: 'f1', handle: 'bob', displayName: 'Bob' },
								{ kind: 'source', sourceId: 's1', url: 'https://ex.com/f.xml', displayName: 'Ex Blog' }
							]
						}),
						{ status: 200 }
					)
				: new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 })
	)
	const result = (await load(sessionedLoad(fetch, 'bob') as never)) as { isOwner: boolean; rows?: Row[] }
	expect(result.isOwner).toBe(false)
	expect(fetch.mock.calls.some((c) => String(c[0]).includes('/me/following'))).toBe(false)
	expect(result.rows?.every((r) => r.kind === 'local' || r.pending === false)).toBe(true) // pending is unreachable, not merely hidden
	expect(result.rows?.find((r) => r.kind === 'source')).toMatchObject({ sourceId: 's1', label: 'Ex Blog' })
})

test('a capability failure degrades the following load to legacy — never coreDown — and is retried next request', async () => {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) throw new Error('no /capabilities on this core')
		return String(url).includes('/follows')
			? new Response(JSON.stringify({ following: [{ id: 'f1', handle: 'w', displayName: 'W', kind: 'remote', feedType: 'webfeed' }] }), { status: 200 })
			: new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 })
	})
	const event = sessionedLoad(fetch, 'alice')
	const first = (await load(event as never)) as { coreDown?: boolean; sourceModelV2?: boolean; following: Array<{ handle: string }> }
	expect(first.coreDown).toBeUndefined()
	expect(first.sourceModelV2).toBeUndefined()
	expect(first.following.map((u) => u.handle)).toEqual(['w']) // the already-in-flight legacy result stands
	const capCalls = () => fetch.mock.calls.filter((c) => isCap(c[0])).length
	expect(capCalls()).toBe(1)
	await load(event as never)
	expect(capCalls()).toBe(2)
})

test('unsubscribe removes by stable source id and carries the form command id', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ ok: true }), { status: 200 }))
	const event = sessionedEvent(formRequest('unsubscribe', { sourceId: 's1', commandId: 'cmd-9' }), fetch)
	expect(await actions.unsubscribe(event as never)).toEqual({ ok: true })
	expect(fetch).toHaveBeenCalledTimes(1) // no capability probe: the rendered form already answered it
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/me/subscriptions/s1')
	expect(init.method).toBe('DELETE')
	expect(JSON.parse(String(init.body))).toEqual({ commandId: 'cmd-9' })
	expect(new Headers(init.headers).get('cookie')).toBe('rsc.session_token=s1')
})

// W5: the load's coreDown catch can drop `commandIds` from the rendered form
// (a core blip mid-load) — the action must decide v1-vs-v2 from capabilities,
// not from whether the form happens to carry a commandId, or a v2 core 400s
// the legacy-shaped POST.
test('import with NO commandId on a v2-capable instance still calls the v2 import path (post-blip load)', async () => {
	vi.resetModules()
	const { actions } = await import('./+page.server.ts')
	const counts = { localFollowed: 1, active: 1, pending: 0, unavailable: 0, notSubscribable: 0, capSkipped: 0 }
	const fetch = vi.fn(async (url: string | URL, ..._rest: unknown[]) =>
		isCap(url) ? new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 }) : new Response(JSON.stringify(counts), { status: 200 })
	)
	const body = new FormData()
	body.set('opml', new File(['<opml/>'], 'feed.opml'))
	// no commandId field at all
	const event = sessionedEvent(new Request('http://x/?/import', { method: 'POST', body }), fetch)
	const res = await actions.import(event as never)
	expect(res).toEqual({ ok: true, result: counts })
	const importCall = fetch.mock.calls.find((c) => String(c[0]).includes('/me/follows/opml')) as [string, RequestInit]
	expect(importCall).toBeDefined()
	// v2 path used (header-borne command id), never the legacy body-only POST
	const commandId = new Headers(importCall[1].headers).get('x-rsc-command-id')
	expect(commandId).toMatch(/^[0-9a-f]{8}-/) // minted in the action, mirrors unsubscribe's `|| crypto.randomUUID()`
})

test('import carries the form command id as a header and returns the v2 counts', async () => {
	vi.resetModules()
	const { actions } = await import('./+page.server.ts')
	const counts = { localFollowed: 1, active: 2, pending: 1, unavailable: 0, notSubscribable: 0, capSkipped: 0 }
	const fetch = vi.fn(async (url: string | URL, ..._rest: unknown[]) =>
		String(url).includes('/capabilities') ? new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 }) : new Response(JSON.stringify(counts), { status: 200 })
	)
	const body = new FormData()
	body.set('opml', new File(['<opml/>'], 'feed.opml'))
	body.set('commandId', 'cmd-7')
	const event = sessionedEvent(new Request('http://x/?/import', { method: 'POST', body }), fetch)
	expect(await actions.import(event as never)).toEqual({ ok: true, result: counts })
	const importCall = fetch.mock.calls.find((c) => String(c[0]).includes('/me/follows/opml')) as [string, RequestInit]
	expect(importCall).toBeDefined()
	// the form's own commandId is honored, not overwritten by a freshly minted one
	expect(new Headers(importCall[1].headers).get('x-rsc-command-id')).toBe('cmd-7')
})
