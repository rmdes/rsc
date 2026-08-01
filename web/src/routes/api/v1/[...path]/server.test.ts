import { test, expect, vi, afterEach } from 'vitest'
import { GET } from './+server.ts'

const originalFetch = global.fetch

afterEach(() => {
	global.fetch = originalFetch
})

test('GET forwards to core at the matching unprefixed path, with the x-api-key header', async () => {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await GET({ params: { path: 'me/timeline' }, url: new URL('http://x/api/v1/me/timeline'), request: new Request('http://x/api/v1/me/timeline', { headers: { 'x-api-key': 'rsc_test_key' } }) } as never)

	expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/me/timeline', expect.objectContaining({
		headers: expect.objectContaining({ 'x-api-key': 'rsc_test_key' })
	}))
	expect(res.status).toBe(200)
	expect(await res.json()).toEqual({ ok: true })
})

test('GET without an x-api-key header still forwards (core enforces the 401, not the proxy)', async () => {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'api key required' }), { status: 401 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await GET({ params: { path: 'me/timeline' }, url: new URL('http://x/api/v1/me/timeline'), request: new Request('http://x/api/v1/me/timeline') } as never)
	expect(res.status).toBe(401)
})

test('query string is preserved on the forwarded request', async () => {
	const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	await GET({ params: { path: 'me/timeline' }, url: new URL('http://x/api/v1/me/timeline?limit=10'), request: new Request('http://x/api/v1/me/timeline?limit=10', { headers: { 'x-api-key': 'k' } }) } as never)
	expect(String((fetchMock as any).mock.calls[0][0])).toBe('http://localhost:8787/me/timeline?limit=10')
})

test('GET returns a retryable 503 when core is unreachable', async () => {
	global.fetch = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
	const res = await GET({ params: { path: 'me/timeline' }, url: new URL('http://x/api/v1/me/timeline'), request: new Request('http://x/api/v1/me/timeline') } as never)
	expect(res.status).toBe(503)
})

// Final review Finding 2: an `api/` path bypasses this generic forwarder
// straight into core's /api/auth/* mount, one segment away from the auth
// proxy's own hard-404 guard on the dev-only openAPI reference. The guard
// must short-circuit before ever calling fetch — asserted here the same way
// api/auth/proxy.test.ts asserts its own guard never reaches upstream.
test('GET 404s an api/ path without ever calling fetch (the dev-only openAPI reference guard, one segment over)', async () => {
	const fetchMock = vi.fn(async () => new Response('should not be called', { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await GET({ params: { path: 'api/auth/reference' }, url: new URL('http://x/api/v1/api/auth/reference'), request: new Request('http://x/api/v1/api/auth/reference') } as never)

	expect(res.status).toBe(404)
	expect(fetchMock).not.toHaveBeenCalled()
})
