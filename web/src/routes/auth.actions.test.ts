import { test, expect, vi } from 'vitest'
import { actions as registerActions } from './register/+page.server.ts'
import { actions as loginActions } from './login/+page.server.ts'
import { actions as settingsActions } from './settings/+page.server.ts'
import { actions as forgotActions } from './forgot/+page.server.ts'
import { actions as resetActions } from './reset/+page.server.ts'

function formRequest(action: string, fields: Record<string, string>): Request {
	const body = new URLSearchParams(fields)
	return new Request(`http://x/?/${action}`, { method: 'POST', body })
}

function cookielessCookies() {
	return { getAll: () => [], set: vi.fn(), delete: vi.fn() }
}

function sessionedCookies() {
	return { getAll: () => [{ name: 'textcaster.session_token', value: 's1' }], set: vi.fn(), delete: vi.fn() }
}

test('register signs up and returns check-inbox state (NOT a redirect), relaying any cookie the response carries', async () => {
	// Hard verification: sign-up never mints a usable session, so there is
	// normally no set-cookie header here — this response carries one anyway to
	// prove the relay still fires if one ever shows up.
	const res = new Response(null, { headers: { 'set-cookie': 'textcaster.session_token=minted; Path=/; HttpOnly; Max-Age=600' } })
	const fetch = vi.fn(async (..._args: unknown[]) => res)
	const cookies = cookielessCookies()
	const event = { request: formRequest('register', { email: 'a@example.com', password: 'password123' }), fetch, cookies, url: new URL('http://x/') }
	const result = await registerActions.register(event as never)
	expect(result).toEqual({ checkInbox: true, email: 'a@example.com' })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/api/auth/sign-up/email')
	const headers = new Headers(init.headers)
	expect(headers.get('origin')).toBe('http://x')
	expect(headers.get('cookie')).toBeNull() // no anon cookie to ride along in this case
	expect(JSON.parse(String(init.body))).toEqual({ email: 'a@example.com', password: 'password123', name: 'a' })
	expect(cookies.set).toHaveBeenCalledWith('textcaster.session_token', 'minted', expect.objectContaining({ path: '/' }))
})

test('register forwards an existing anonymous cookie so better-auth can link the account', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }))
	const event = { request: formRequest('register', { email: 'a@example.com', password: 'password123' }), fetch, cookies: sessionedCookies(), url: new URL('http://x/') }
	const result = await registerActions.register(event as never)
	expect(result).toEqual({ checkInbox: true, email: 'a@example.com' })
	const headers = new Headers((fetch.mock.calls[0][1] as RequestInit).headers)
	expect(headers.get('cookie')).toBe('textcaster.session_token=s1')
})

test('register surfaces the mail-gate error on a 503 from core (email accounts unavailable)', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'email accounts are not available on this instance' }), { status: 503 }))
	const event = { request: formRequest('register', { email: 'a@example.com', password: 'password123' }), fetch, cookies: cookielessCookies(), url: new URL('http://x/') }
	const result = await registerActions.register(event as never)
	expect(result).toMatchObject({ status: 503 })
	expect((result as { data: { error: string } }).data.error).toBe('Email accounts are not available on this instance — post as a guest instead.')
})

test('register rejects a short password before ever calling the core', async () => {
	const fetch = vi.fn()
	const event = { request: formRequest('register', { email: 'a@example.com', password: 'short' }), fetch, cookies: cookielessCookies(), url: new URL('http://x/') }
	const result = await registerActions.register(event as never)
	expect(result).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('register surfaces the better-auth error message on failure', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'email already registered' }), { status: 422 }))
	const event = { request: formRequest('register', { email: 'a@example.com', password: 'password123' }), fetch, cookies: cookielessCookies(), url: new URL('http://x/') }
	const result = await registerActions.register(event as never)
	expect(result).toMatchObject({ status: 400 })
	expect((result as { data: { error: string } }).data.error).toBe('email already registered')
})

test('login signs in, relays the cookie, and redirects', async () => {
	const res = new Response(null, { headers: { 'set-cookie': 'textcaster.session_token=s2; Path=/; HttpOnly; Max-Age=600' } })
	const fetch = vi.fn(async (..._args: unknown[]) => res)
	const cookies = cookielessCookies()
	const event = { request: formRequest('login', { email: 'a@example.com', password: 'password123' }), fetch, cookies, url: new URL('http://x/') }
	await expect(loginActions.login(event as never)).rejects.toMatchObject({ status: 303 })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/api/auth/sign-in/email')
	expect(JSON.parse(String(init.body))).toEqual({ email: 'a@example.com', password: 'password123' })
	expect(cookies.set).toHaveBeenCalledWith('textcaster.session_token', 's2', expect.objectContaining({ path: '/' }))
})

test('login surfaces the better-auth error message on failure', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'invalid credentials' }), { status: 401 }))
	const event = { request: formRequest('login', { email: 'a@example.com', password: 'wrong' }), fetch, cookies: cookielessCookies(), url: new URL('http://x/') }
	const result = await loginActions.login(event as never)
	expect(result).toMatchObject({ status: 401 })
	expect((result as { data: { error: string } }).data.error).toBe('invalid credentials')
})

test('login magic action sends a magic link, relays cookies, and reports magicSent', async () => {
	const res = new Response(null, { headers: { 'set-cookie': 'textcaster.session_token=s3; Path=/; HttpOnly; Max-Age=600' } })
	const fetch = vi.fn(async (..._args: unknown[]) => res)
	const cookies = cookielessCookies()
	const event = { request: formRequest('magic', { email: 'a@example.com' }), fetch, cookies, url: new URL('http://x/') }
	const result = await loginActions.magic(event as never)
	expect(result).toEqual({ magicSent: true })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/api/auth/sign-in/magic-link')
	expect(JSON.parse(String(init.body))).toEqual({ email: 'a@example.com' })
	expect(cookies.set).toHaveBeenCalledWith('textcaster.session_token', 's3', expect.objectContaining({ path: '/' }))
})

test('login magic action rejects an empty email before ever calling the core', async () => {
	const fetch = vi.fn()
	const event = { request: formRequest('magic', { email: '' }), fetch, cookies: cookielessCookies(), url: new URL('http://x/') }
	const result = await loginActions.magic(event as never)
	expect(result).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('forgot posts a reset request with the /reset redirectTo and always returns the neutral message', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }))
	const event = { request: formRequest('forgot', { email: 'a@example.com' }), fetch, cookies: cookielessCookies(), url: new URL('http://x/') }
	const result = await forgotActions.forgot(event as never)
	expect(result).toEqual({ sent: true })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/api/auth/request-password-reset')
	expect(JSON.parse(String(init.body))).toEqual({ email: 'a@example.com', redirectTo: 'http://x/reset' })
})

test('forgot returns the same neutral message even when core errors (no account enumeration)', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'no such user' }), { status: 400 }))
	const event = { request: formRequest('forgot', { email: 'nobody@example.com' }), fetch, cookies: cookielessCookies(), url: new URL('http://x/') }
	const result = await forgotActions.forgot(event as never)
	expect(result).toEqual({ sent: true })
})

test('reset maps token and newPassword onto the core call, relays cookies, and redirects to login', async () => {
	const res = new Response(null, { headers: { 'set-cookie': 'textcaster.session_token=s4; Path=/; HttpOnly; Max-Age=600' } })
	const fetch = vi.fn(async (..._args: unknown[]) => res)
	const cookies = cookielessCookies()
	const event = { request: formRequest('reset', { token: 'tok123', newPassword: 'newpassword1' }), fetch, cookies, url: new URL('http://x/') }
	await expect(resetActions.reset(event as never)).rejects.toMatchObject({ status: 303 })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/api/auth/reset-password')
	expect(JSON.parse(String(init.body))).toEqual({ newPassword: 'newpassword1', token: 'tok123' })
	expect(cookies.set).toHaveBeenCalledWith('textcaster.session_token', 's4', expect.objectContaining({ path: '/' }))
})

test('reset rejects a short password before ever calling the core', async () => {
	const fetch = vi.fn()
	const event = { request: formRequest('reset', { token: 'tok123', newPassword: 'short' }), fetch, cookies: cookielessCookies(), url: new URL('http://x/') }
	const result = await resetActions.reset(event as never)
	expect(result).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('logout calls sign-out with the session cookie and origin, relays the clear, and redirects', async () => {
	const res = new Response(null, { headers: { 'set-cookie': 'textcaster.session_token=; Path=/; Max-Age=0' } })
	const fetch = vi.fn(async (..._args: unknown[]) => res)
	const cookies = sessionedCookies()
	const event = { fetch, cookies, url: new URL('http://x/') }
	await expect(loginActions.logout(event as never)).rejects.toMatchObject({ status: 303 })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/api/auth/sign-out')
	const headers = new Headers(init.headers)
	expect(headers.get('cookie')).toBe('textcaster.session_token=s1')
	expect(headers.get('origin')).toBe('http://x')
	expect(headers.get('content-type')).toBe('application/json') // better-auth 415s without it
	expect(init.body).toBe('{}') // and 400s on a json content-type with no body at all
	expect(cookies.delete).toHaveBeenCalledWith('textcaster.session_token', { path: '/' })
})

test('logout without a session never calls sign-out, just redirects', async () => {
	const fetch = vi.fn()
	const event = { fetch, cookies: cookielessCookies(), url: new URL('http://x/') }
	await expect(loginActions.logout(event as never)).rejects.toMatchObject({ status: 303 })
	expect(fetch).not.toHaveBeenCalled()
})

test('settings save updates the profile and redirects', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }))
	const event = { request: formRequest('save', { handle: 'newhandle', displayName: 'New Name' }), fetch, cookies: sessionedCookies(), url: new URL('http://x/') }
	await expect(settingsActions.save(event as never)).rejects.toMatchObject({ status: 303 })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(url).toContain('/me')
	expect(String((init as RequestInit).method)).toBe('PATCH')
	const headers = new Headers(init.headers)
	expect(headers.get('cookie')).toBe('textcaster.session_token=s1')
	expect(JSON.parse(String(init.body))).toEqual({ handle: 'newhandle', displayName: 'New Name' })
})

test('settings save maps a 409 handle conflict to an inline error', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'handle already taken' }), { status: 409 }))
	const event = { request: formRequest('save', { handle: 'taken', displayName: '' }), fetch, cookies: sessionedCookies(), url: new URL('http://x/') }
	const result = await settingsActions.save(event as never)
	expect(result).toMatchObject({ status: 409 })
	expect((result as { data: { error: string } }).data.error).toBe('handle already taken')
})
