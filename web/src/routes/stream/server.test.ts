import { test, expect, vi, afterEach } from 'vitest'
import { GET } from './+server.ts'

const originalFetch = global.fetch

afterEach(() => {
	global.fetch = originalFetch
})

test('GET proxies the core SSE stream with the right headers', async () => {
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('event: post\ndata: {}\n\n'))
			controller.close()
		}
	})
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/stream')
	const res = await GET({ request } as never)

	expect(fetchMock).toHaveBeenCalledWith(
		'http://localhost:8787/timeline/stream',
		expect.objectContaining({ signal: request.signal })
	)
	expect(res.headers.get('content-type')).toBe('text/event-stream')
	expect(res.headers.get('cache-control')).toBe('no-cache')

	const text = await res.text()
	expect(text).toContain('event: post')
})

test('GET forwards upstream error status', async () => {
	const body = new ReadableStream({
		start(controller) {
			controller.close()
		}
	})
	const fetchMock = vi.fn(async () => new Response(body, { status: 500 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/stream')
	const res = await GET({ request } as never)

	expect(res.status).toBe(500)
})

test('GET forwards the Last-Event-ID header upstream', async () => {
	const body = new ReadableStream({
		start(controller) {
			controller.close()
		}
	})
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/stream', { headers: { 'Last-Event-ID': 'post-42' } })
	await GET({ request } as never)

	const init = (fetchMock as any).mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('Last-Event-ID')).toBe('post-42')
})

test('GET keeps the upstream content-type on error responses', async () => {
	const fetchMock = vi.fn(
		async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
	)
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/stream')
	const res = await GET({ request } as never)

	expect(res.status).toBe(500)
	expect(res.headers.get('content-type')).toBe('application/json')
})
