import { test, expect, vi } from 'vitest'
import type { Cookies } from '@sveltejs/kit'
import { hasSession, cookieHeader, authedFetch, relaySetCookies, ensureSessionFetch } from './session.ts'

function fakeCookies(initial: { name: string; value: string }[] = []) {
	const store = new Map(initial.map((c) => [c.name, c.value]))
	return {
		getAll: () => [...store].map(([name, value]) => ({ name, value })),
		set: vi.fn((name: string, value: string) => {
			store.set(name, value)
		}),
		delete: vi.fn((name: string) => {
			store.delete(name)
		})
	}
}

test('hasSession / cookieHeader read the cookie jar', () => {
	const empty = fakeCookies()
	expect(hasSession(empty as unknown as Cookies)).toBe(false)
	expect(cookieHeader(empty as unknown as Cookies)).toBeNull()

	const withSession = fakeCookies([{ name: 'textcaster.session_token', value: 'x' }])
	expect(hasSession(withSession as unknown as Cookies)).toBe(true)
	expect(cookieHeader(withSession as unknown as Cookies)).toBe('textcaster.session_token=x')
})

test('authedFetch injects Cookie and Origin headers', async () => {
	const f = vi.fn(async (..._args: unknown[]) => new Response(null))
	const wrapped = authedFetch(f as unknown as typeof fetch, 'http://localhost:5173', 'a=1; b=2')
	await wrapped('http://core/x')
	const init = f.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('cookie')).toBe('a=1; b=2')
	expect(new Headers(init.headers).get('origin')).toBe('http://localhost:5173')
})

test('authedFetch omits the Cookie header when cookie is null', async () => {
	const f = vi.fn(async (..._args: unknown[]) => new Response(null))
	const wrapped = authedFetch(f as unknown as typeof fetch, 'http://localhost:5173', null)
	await wrapped('http://core/x')
	const init = f.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).has('cookie')).toBe(false)
	expect(new Headers(init.headers).get('origin')).toBe('http://localhost:5173')
})

test('relaySetCookies relays name/value/maxAge, httpOnly + SameSite=Lax + Path=/', () => {
	const cookies = fakeCookies()
	const res = new Response(null, {
		headers: { 'set-cookie': 'textcaster.session_token=abc123; Path=/; HttpOnly; Max-Age=600' }
	})
	relaySetCookies(cookies as unknown as Cookies, res)
	expect(cookies.set).toHaveBeenCalledWith('textcaster.session_token', 'abc123', {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 600
	})
})

test('relaySetCookies deletes the cookie when Max-Age <= 0', () => {
	const cookies = fakeCookies([{ name: 'textcaster.session_token', value: 'stale' }])
	const res = new Response(null, {
		headers: { 'set-cookie': 'textcaster.session_token=; Path=/; Max-Age=0' }
	})
	relaySetCookies(cookies as unknown as Cookies, res)
	expect(cookies.delete).toHaveBeenCalledWith('textcaster.session_token', { path: '/' })
	expect(cookies.set).not.toHaveBeenCalled()
})

test('ensureSessionFetch mints an anonymous session once and threads the minted cookie onto the next call', async () => {
	const cookies = fakeCookies()
	const mintRes = new Response(null, {
		headers: { 'set-cookie': 'textcaster.session_token=minted; Path=/; HttpOnly; Max-Age=600' }
	})
	const f = vi.fn(async (url: string | URL | Request, ..._rest: unknown[]) => {
		if (String(url).includes('/sign-in/anonymous')) return mintRes
		return new Response(null, { status: 201 })
	})
	const event = { fetch: f as unknown as typeof fetch, cookies: cookies as unknown as Cookies, url: new URL('http://localhost:5173/'), getClientAddress: () => '203.0.113.5' }

	const acted = await ensureSessionFetch(event)
	await acted('http://localhost:8787/posts', { method: 'POST' })

	expect(f).toHaveBeenCalledTimes(2)
	const mintInit = f.mock.calls[0][1] as RequestInit
	expect(new Headers(mintInit.headers).get('origin')).toBe('http://localhost:5173')
	// better-auth 415s a bodyless POST through core's Hono mount (probed) —
	// content-type + a body are required even for this no-input endpoint.
	expect(new Headers(mintInit.headers).get('content-type')).toBe('application/json')
	expect(mintInit.body).toBe('{}')
	// the mint carries the real client address so core's per-IP rate limit
	// doesn't collapse every visitor into the web server's own bucket.
	expect(new Headers(mintInit.headers).get('x-forwarded-for')).toBe('203.0.113.5')
	const actInit = f.mock.calls[1][1] as RequestInit
	expect(new Headers(actInit.headers).get('cookie')).toBe('textcaster.session_token=minted')
	expect(cookies.set).toHaveBeenCalledWith('textcaster.session_token', 'minted', {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 600
	})
})

test('ensureSessionFetch skips minting when a session cookie already exists', async () => {
	const cookies = fakeCookies([{ name: 'textcaster.session_token', value: 'existing' }])
	const f = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 201 }))
	const event = { fetch: f as unknown as typeof fetch, cookies: cookies as unknown as Cookies, url: new URL('http://localhost:5173/'), getClientAddress: () => '203.0.113.5' }

	const acted = await ensureSessionFetch(event)
	await acted('http://localhost:8787/posts', { method: 'POST' })

	expect(f).toHaveBeenCalledTimes(1)
	const init = f.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('cookie')).toBe('textcaster.session_token=existing')
})

test('ensureSessionFetch throws when anonymous sign-in fails', async () => {
	const cookies = fakeCookies()
	const f = vi.fn(async () => new Response(null, { status: 500 }))
	const event = { fetch: f as unknown as typeof fetch, cookies: cookies as unknown as Cookies, url: new URL('http://localhost:5173/'), getClientAddress: () => '203.0.113.5' }

	await expect(ensureSessionFetch(event)).rejects.toThrow(/anonymous sign-in failed/)
})
