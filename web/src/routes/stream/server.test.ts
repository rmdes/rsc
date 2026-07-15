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
	expect(res.headers.get('connection')).toBe('keep-alive')

	const text = await res.text()
	expect(text).toContain('event: post')
})
