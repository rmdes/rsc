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

// The resolved-path guard is only safe because the URL is built from an
// ABSOLUTE string. Resolving `params.path` as a RELATIVE reference instead
// (new URL(params.path, base)) would let `//evil.host` or `https://evil.host`
// repoint the upstream request off-box — an SSRF traded for a traversal fix.
// Whatever the path says, the request must stay on core.
test('a path that looks like another origin still forwards to core, never off-box', async () => {
	const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	for (const path of ['//evil.example/x', 'https://evil.example/x']) {
		await GET({ params: { path }, url: new URL('http://x/api/v1/'), request: new Request('http://x/api/v1/') } as never)
	}
	for (const call of (fetchMock as any).mock.calls) {
		expect(new URL(String(call[0])).origin).toBe('http://localhost:8787')
	}
	expect((fetchMock as any).mock.calls).toHaveLength(2)
})

// ...and the same guard must survive a traversal: `params.path` arrives
// percent-DECODED, so `..%2f` is a real `../` that `startsWith('api/')` reads
// past, while fetch normalizes it away and lands on /api/auth/* anyway. Match
// the resolved path, not the raw segment.
test('GET 404s an api/ path reached by traversal, without ever calling fetch', async () => {
	const fetchMock = vi.fn(async () => new Response('should not be called', { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await GET({ params: { path: '../api/auth/reference' }, url: new URL('http://x/api/v1/'), request: new Request('http://x/api/v1/') } as never)

	expect(res.status).toBe(404)
	expect(fetchMock).not.toHaveBeenCalled()
})
