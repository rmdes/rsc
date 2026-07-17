import { test, expect, vi } from 'vitest'
import { load } from './+layout.server.ts'

function healthResponse(mailEnabled: boolean) {
	return new Response(JSON.stringify({ ok: true, mailEnabled }), { status: 200 })
}

test('load returns me: null and the mail flag, without calling /me, when there is no session cookie', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => healthResponse(true))
	const result = await load({ fetch, cookies: { getAll: () => [] }, url: new URL('http://x/') } as never)
	expect(result).toEqual({ me: null, mailEnabled: true })
	expect(fetch).toHaveBeenCalledTimes(1)
	expect(String(fetch.mock.calls[0][0])).toContain('/health')
})

test('load forwards the session cookie and returns getMe() alongside the mail flag', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => {
		const input = _args[0]
		if (String(input).includes('/health')) return healthResponse(false)
		return new Response(JSON.stringify({ user: { id: 'u1', handle: 'a' }, isAnonymous: true }), { status: 200 })
	})
	const cookies = { getAll: () => [{ name: 'textcaster.session_token', value: 's1' }] }
	const result = await load({ fetch, cookies, url: new URL('http://x/') } as never)
	expect(result).toEqual({ me: { user: { id: 'u1', handle: 'a' }, isAnonymous: true }, mailEnabled: false })
	const [, init] = fetch.mock.calls.find((c) => !String(c[0]).includes('/health')) as [string, RequestInit]
	expect(new Headers(init.headers).get('cookie')).toBe('textcaster.session_token=s1')
})

test('load degrades to me: null, mailEnabled: false when the core is unreachable', async () => {
	const fetch = vi.fn(async () => {
		throw new Error('fetch failed')
	})
	const cookies = { getAll: () => [{ name: 'textcaster.session_token', value: 's1' }] }
	const result = await load({ fetch, cookies, url: new URL('http://x/') } as never)
	expect(result).toEqual({ me: null, mailEnabled: false })
})
