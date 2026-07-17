import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

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
		cookies: { getAll: () => [{ name: 'textcaster.session_token', value: 's1' }] }
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
	expect(headers.get('cookie')).toBe('textcaster.session_token=s1')
	expect(headers.get('origin')).toBe('http://x')
	expect(JSON.parse(String(init.body))).toEqual({ handle: 'alice' })
})

test('follow mints an anonymous session first when there is none yet, then relays it', async () => {
	const mintRes = new Response(null, {
		headers: { 'set-cookie': 'textcaster.session_token=minted; Path=/; HttpOnly; Max-Age=600' }
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
	expect(new Headers(followInit.headers).get('cookie')).toBe('textcaster.session_token=minted')
	expect(event.cookies.set).toHaveBeenCalledWith('textcaster.session_token', 'minted', expect.objectContaining({ path: '/' }))
})

test('unfollow deletes the target via the core with the session cookie', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 204 }))
	const event = sessionedEvent(formRequest('unfollow', { target: 'bob' }), fetch)
	const res = await actions.unfollow(event as never)
	expect(res).toEqual({ ok: true })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/me/follows/bob')
	expect(String((init as { method?: string }).method)).toBe('DELETE')
	expect(new Headers(init.headers).get('cookie')).toBe('textcaster.session_token=s1')
})

test('import NEVER mints a session — registered-only, core 403s anonymous', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ error: 'not authenticated' }), { status: 401 }))
	const event = anonymousEvent(importRequest('<opml/>'), fetch)
	const res = await actions.import(event as never)
	expect(fetch.mock.calls.some((c) => String(c[0]).includes('/sign-in/anonymous'))).toBe(false) // no mint call ever
	expect(fetch).toHaveBeenCalledTimes(1)
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/me/follows/opml')
	const headers = new Headers(init.headers)
	expect(headers.get('cookie')).toBeNull() // no session to forward
	expect(headers.get('origin')).toBe('http://x')
	expect(res).toMatchObject({ status: 400 })
	expect((res as { data: { error: string } }).data.error).toBe('not authenticated')
})
