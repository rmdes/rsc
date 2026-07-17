import { test, expect, vi, afterEach } from 'vitest'
import { GET, POST } from './+server.ts'

const originalFetch = global.fetch
afterEach(() => {
	global.fetch = originalFetch
})

// Minimal SvelteKit RequestEvent stub carrying what the proxy reads.
function event(method: string, path: string, search = '', body?: string) {
	const setCookies: Array<[string, string, Record<string, unknown>]> = []
	const deleted: string[] = []
	return {
		request: new Request(`http://web.test/api/auth/${path}${search}`, {
			method,
			headers: body ? { 'content-type': 'application/json' } : {},
			body
		}),
		params: { path },
		url: new URL(`http://web.test/api/auth/${path}${search}`),
		getClientAddress: () => '203.0.113.9',
		cookies: {
			getAll: () => [{ name: 'textcaster.session_token', value: 'abc' }],
			set: (n: string, v: string, o: Record<string, unknown>) => setCookies.push([n, v, o]),
			delete: (n: string) => deleted.push(n)
		},
		_setCookies: setCookies,
		_deleted: deleted
	}
}

test('proxies a GET verify-link to core with cookie + origin, relaying the 302 and its Set-Cookie', async () => {
	const captured: { url?: string; init?: RequestInit } = {}
	global.fetch = vi.fn(async (url: string, init: RequestInit) => {
		captured.url = url
		captured.init = init
		return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': 'textcaster.session_token=NEW; Path=/; Max-Age=3600; HttpOnly' } })
	}) as unknown as typeof fetch

	const e = event('GET', 'verify-email', '?token=T&callbackURL=/')
	const res = await GET(e as never)

	// forwarded to core with the full path+query, cookie, origin, client addr
	expect(captured.url).toBe('http://localhost:8787/api/auth/verify-email?token=T&callbackURL=/')
	const h = new Headers(captured.init!.headers)
	expect(h.get('cookie')).toContain('textcaster.session_token=abc')
	expect(h.get('origin')).toBe('http://web.test')
	expect(h.get('x-forwarded-for')).toBe('203.0.113.9')
	expect(captured.init!.redirect).toBe('manual') // relay, don't follow

	// the 302 + Location reach the browser, and the new session cookie is relayed
	expect(res.status).toBe(302)
	expect(res.headers.get('location')).toBe('/')
	expect(e._setCookies.some(([n, v]) => n === 'textcaster.session_token' && v === 'NEW')).toBe(true)
})

test('proxies a POST with its body to core', async () => {
	let sentBody: string | undefined
	global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
		sentBody = init.body as string
		return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
	}) as unknown as typeof fetch

	const res = await POST(event('POST', 'sign-in/magic-link', '', '{"email":"a@b.test"}') as never)
	expect(sentBody).toBe('{"email":"a@b.test"}')
	expect(res.status).toBe(200)
})
