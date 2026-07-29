import { test, expect, vi } from 'vitest'
import { load } from './+layout.server.ts'

function healthResponse(mailEnabled: boolean) {
	return new Response(JSON.stringify({ ok: true, mailEnabled }), { status: 200 })
}

test('load returns me: null and the mail flag, without calling /me, when there is no session cookie', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => healthResponse(true))
	const result = await load({ fetch, cookies: { getAll: () => [] }, url: new URL('http://x/') } as never)
	expect(result).toEqual({ me: null, mailEnabled: true, tab: 'public' })
	expect(fetch).toHaveBeenCalledTimes(1)
	expect(String(fetch.mock.calls[0][0])).toContain('/health')
})

test('load forwards the session cookie and returns getMe() alongside the mail flag', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => {
		const input = _args[0]
		if (String(input).includes('/health')) return healthResponse(false)
		return new Response(JSON.stringify({ user: { id: 'u1', handle: 'a' }, isAnonymous: true }), { status: 200 })
	})
	const cookies = { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }
	const result = await load({ fetch, cookies, url: new URL('http://x/') } as never)
	expect(result).toEqual({ me: { user: { id: 'u1', handle: 'a' }, isAnonymous: true }, mailEnabled: false, tab: 'public' })
	const [, init] = fetch.mock.calls.find((c) => !String(c[0]).includes('/health')) as [string, RequestInit]
	expect(new Headers(init.headers).get('cookie')).toBe('rsc.session_token=s1')
})

test('load degrades to me: null, mailEnabled: false when the core is unreachable', async () => {
	const fetch = vi.fn(async () => {
		throw new Error('fetch failed')
	})
	const cookies = { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }
	const result = await load({ fetch, cookies, url: new URL('http://x/') } as never)
	expect(result).toEqual({ me: null, mailEnabled: false, tab: 'public' })
})

test('subscribeCommandId mints a UUID only on / for a non-anonymous session, and is absent everywhere else', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => healthResponse(true))
	const cookies = { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }
	// registered session, home page: minted
	const registeredFetch = vi.fn(async (..._args: unknown[]) => {
		const input = _args[0]
		if (String(input).includes('/health')) return healthResponse(true)
		return new Response(JSON.stringify({ user: { id: 'u1', handle: 'a' }, isAnonymous: false }), { status: 200 })
	})
	const onHome = await load({ fetch: registeredFetch, cookies, url: new URL('http://x/') } as never)
	expect((onHome as { subscribeCommandId?: string }).subscribeCommandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
	// same session, a different route: not minted
	const elsewhere = await load({ fetch: registeredFetch, cookies, url: new URL('http://x/admin') } as never)
	expect((elsewhere as { subscribeCommandId?: string }).subscribeCommandId).toBeUndefined()
	// no session at all, home page: not minted
	const guest = await load({ fetch, cookies: { getAll: () => [] }, url: new URL('http://x/') } as never)
	expect((guest as { subscribeCommandId?: string }).subscribeCommandId).toBeUndefined()
})

test('healthz is a trivial liveness answer that never touches core', async () => {
	const { GET } = await import('./healthz/+server.ts')
	const res = GET({} as never) as Response
	expect(res.status).toBe(200)
	expect(await res.text()).toBe('ok')
})
