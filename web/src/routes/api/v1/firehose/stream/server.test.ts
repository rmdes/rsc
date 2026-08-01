import { test, expect, vi, afterEach } from 'vitest'
import { GET } from './+server.ts'

const originalFetch = global.fetch
const getClientAddress = () => '203.0.113.5'

afterEach(() => {
	global.fetch = originalFetch
})

test('GET proxies core\'s public firehose stream unchanged, with SSE headers', async () => {
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('event: reset\ndata: {"model":"firehose-v1","kind":"reset"}\n\n'))
			controller.close()
		}
	})
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/api/v1/firehose/stream')
	const res = await GET({ request, getClientAddress } as never)

	expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/firehose/stream', expect.objectContaining({ signal: request.signal }))
	expect(res.headers.get('content-type')).toBe('text/event-stream')
	expect(res.headers.get('cache-control')).toBe('no-cache')
	const text = await res.text()
	expect(text).toBe('event: reset\ndata: {"model":"firehose-v1","kind":"reset"}\n\n') // byte-verbatim, no transform
})

test('GET forwards upstream error status', async () => {
	const body = new ReadableStream({ start(controller) { controller.close() } })
	const fetchMock = vi.fn(async () => new Response(body, { status: 429 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/api/v1/firehose/stream')
	const res = await GET({ request, getClientAddress } as never)
	expect(res.status).toBe(429)
})

test('GET returns a retryable 503 when core is unreachable', async () => {
	global.fetch = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
	const request = new Request('http://x/api/v1/firehose/stream')
	const res = await GET({ request, getClientAddress } as never)
	expect(res.status).toBe(503)
})

test('GET forwards the Last-Event-ID header upstream', async () => {
	const body = new ReadableStream({ start(controller) { controller.close() } })
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/api/v1/firehose/stream', { headers: { 'Last-Event-ID': 'fh-9' } })
	await GET({ request, getClientAddress } as never)
	const init = (fetchMock as any).mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('Last-Event-ID')).toBe('fh-9')
})

test('GET forwards ?last= as Last-Event-ID when no header is present', async () => {
	const body = new ReadableStream({ start(controller) { controller.close() } })
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/api/v1/firehose/stream?last=fh-9')
	await GET({ request, getClientAddress } as never)
	const init = (fetchMock as any).mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('Last-Event-ID')).toBe('fh-9')
})

test('GET forwards the real client IP as x-forwarded-for, so core\'s per-IP cap is actually per-IP', async () => {
	const body = new ReadableStream({ start(controller) { controller.close() } })
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/api/v1/firehose/stream')
	await GET({ request, getClientAddress } as never)
	const init = (fetchMock as any).mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('x-forwarded-for')).toBe('203.0.113.5')
})
