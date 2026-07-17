import { test, expect, vi } from 'vitest'
import { load } from './+layout.server.ts'

test('load returns me: null without calling the core when there is no session cookie', async () => {
	const fetch = vi.fn()
	const result = await load({ fetch, cookies: { getAll: () => [] }, url: new URL('http://x/') } as never)
	expect(result).toEqual({ me: null })
	expect(fetch).not.toHaveBeenCalled()
})

test('load forwards the session cookie and returns getMe()', async () => {
	const fetch = vi.fn(
		async (..._args: unknown[]) => new Response(JSON.stringify({ user: { id: 'u1', handle: 'a' }, isAnonymous: true }), { status: 200 })
	)
	const cookies = { getAll: () => [{ name: 'textcaster.session_token', value: 's1' }] }
	const result = await load({ fetch, cookies, url: new URL('http://x/') } as never)
	expect(result).toEqual({ me: { user: { id: 'u1', handle: 'a' }, isAnonymous: true } })
	const init = fetch.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('cookie')).toBe('textcaster.session_token=s1')
})

test('load degrades to me: null when the core is unreachable', async () => {
	const fetch = vi.fn(async () => {
		throw new Error('fetch failed')
	})
	const cookies = { getAll: () => [{ name: 'textcaster.session_token', value: 's1' }] }
	const result = await load({ fetch, cookies, url: new URL('http://x/') } as never)
	expect(result).toEqual({ me: null })
})
