import { test, expect, vi, afterEach } from 'vitest'
import { POST } from './+server.ts'

const originalFetch = global.fetch
afterEach(() => {
	global.fetch = originalFetch
})

// The SDK requires BOTH: application/json alone is answered 406, and a POST
// without content-type: application/json is answered 415 before routing.
const MCP_HEADERS = {
	'content-type': 'application/json',
	accept: 'application/json, text/event-stream'
}

const TIMELINE_CALL = {
	jsonrpc: '2.0',
	id: 1,
	method: 'tools/call',
	params: { name: 'rsc_timeline', arguments: {} }
}

function rpc(headers: Record<string, string> = {}) {
	return new Request('http://x/mcp', {
		method: 'POST',
		headers: { ...MCP_HEADERS, ...headers },
		body: JSON.stringify(TIMELINE_CALL)
	})
}

// Responses are text/event-stream: `event: message\ndata: {…}\n\n`.
function sseData(body: string): unknown {
	const line = body.split('\n').find((l) => l.startsWith('data:'))
	if (!line) throw new Error(`no data frame in SSE body: ${body}`)
	return JSON.parse(line.slice('data:'.length).trim())
}

test('a request with no Authorization header is 401 and never calls upstream', async () => {
	const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await POST({ request: rpc() } as never)

	expect(res.status).toBe(401)
	expect(res.headers.get('www-authenticate')).toBe('Bearer')
	expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
	['a non-Bearer scheme', 'Basic aGk6dGhlcmU='],
	['Bearer with no token', 'Bearer'],
	['Bearer with an empty token', 'Bearer   '],
	['a bare key with no scheme', 'rsc_looks_like_a_key']
])('%s is 401 and never calls upstream', async (_label, authorization) => {
	const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await POST({ request: rpc({ authorization }) } as never)

	expect(res.status).toBe(401)
	expect(fetchMock).not.toHaveBeenCalled()
})

test('a valid Bearer key round-trips a tool call and reaches core with x-api-key', async () => {
	const fetchMock = vi.fn(async () => new Response(
		JSON.stringify({ timeline: [], nextCursor: null }),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await POST({ request: rpc({ authorization: 'Bearer rsc_secret_key' }) } as never)

	expect(res.status).toBe(200)
	expect(fetchMock).toHaveBeenCalledTimes(1)

	// Upstream is core directly, at base() — no /api/v1 (core mounts at root).
	const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
	expect(String(url)).toBe('http://localhost:8787/me/timeline')
	expect(new Headers(init.headers).get('x-api-key')).toBe('rsc_secret_key')

	const payload = sseData(await res.text()) as { result?: { content?: { text?: string }[] } }
	expect(payload.result?.content?.[0]?.text).toContain('No entries.')
})

// The key is a live credential: it must never come back to the caller, in a
// success body or in an error message.
test('the API key never appears in the response body', async () => {
	global.fetch = vi.fn(async () => new Response(
		JSON.stringify({ timeline: [], nextCursor: null }),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	)) as unknown as typeof fetch

	const res = await POST({ request: rpc({ authorization: 'Bearer rsc_secret_key' }) } as never)
	expect(await res.text()).not.toContain('rsc_secret_key')
})

test('the key reaches core but never comes back in an error body', async () => {
	// A synthetic key-bearing throw would only test undici's message shape, not
	// ours: Node's fetch sets err.message to the literal "fetch failed" on every
	// real network failure (host/port live on .cause, never the message), so
	// that string can never carry the key — asserting against a fabricated one
	// is vacuous. Exercise the real leak-shaped path instead: a genuine upstream
	// rejection whose message rscFetch actually returns to the caller (the 401
	// branch), with the key demonstrably in play on the same request.
	const fetchMock = vi.fn(async () => new Response(
		JSON.stringify({ error: 'invalid api key' }),
		{ status: 401, headers: { 'content-type': 'application/json' } }
	))
	global.fetch = fetchMock as unknown as typeof fetch

	const res = await POST({ request: rpc({ authorization: 'Bearer rsc_secret_key' }) } as never)
	const body = await res.text()

	// The key reached the upstream request...
	const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
	expect(new Headers(init.headers).get('x-api-key')).toBe('rsc_secret_key')
	// ...so its absence here is a real result, not an accident of a mock that
	// was never handed the key to begin with.
	expect(body).not.toContain('rsc_secret_key')
})

// buildServer only registers tools and never calls a notifier, so
// subscriptions/listen can never emit anything real on this route — it's
// pure dead weight an unauthenticated-looking caller could otherwise use to
// pin an SSE stream + 15s keepalive timer against the process serving the
// whole web UI. maxSubscriptions: 0 must refuse it immediately instead.
test('subscriptions/listen is refused immediately and does not hold the connection open', async () => {
	const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/mcp', {
		method: 'POST',
		headers: {
			...MCP_HEADERS,
			'mcp-protocol-version': '2026-07-28',
			'mcp-method': 'subscriptions/listen',
			authorization: 'Bearer rsc_secret_key'
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'subscriptions/listen',
			params: {
				notifications: { tools: true },
				_meta: {
					'io.modelcontextprotocol/protocolVersion': '2026-07-28',
					'io.modelcontextprotocol/clientCapabilities': {}
				}
			}
		})
	})

	const res = await POST({ request } as never)

	expect(res.status).toBe(200)
	const payload = JSON.parse(await res.text()) as { error?: { message?: string } }
	expect(payload.error?.message).toBe('Subscription limit reached')
	expect(fetchMock).not.toHaveBeenCalled()
})

// GET/DELETE are deliberately not exported: SvelteKit answers 405, matching
// what the SDK itself answers for 2025-era session operations. Exporting them
// would give an unauthenticated GET a 401 and an authenticated one a 405.
test('GET and DELETE are not exported', async () => {
	const mod = await import('./+server.ts')
	expect('GET' in mod).toBe(false)
	expect('DELETE' in mod).toBe(false)
})
