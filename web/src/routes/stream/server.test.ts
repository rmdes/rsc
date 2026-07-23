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

test('GET returns a retryable 503 when core is unreachable (fetch rejects)', async () => {
	// Core restarting under `node --watch` (dev) or a deploy (prod): the upstream
	// fetch rejects with TypeError. GET must degrade to 503, not throw a 500.
	global.fetch = vi.fn(async () => {
		throw new TypeError('fetch failed')
	}) as unknown as typeof fetch

	const request = new Request('http://x/stream')
	const res = await GET({ request } as never)

	expect(res.status).toBe(503)
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

test('GET forwards ?last= as Last-Event-ID (fresh EventSource cannot send the header)', async () => {
	const body = new ReadableStream({
		start(controller) {
			controller.close()
		}
	})
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/stream?last=post-42')
	await GET({ request } as never)

	const init = (fetchMock as any).mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('Last-Event-ID')).toBe('post-42')
})

test('GET prefers the Last-Event-ID header over ?last= when both are present', async () => {
	const body = new ReadableStream({
		start(controller) {
			controller.close()
		}
	})
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/stream?last=stale', { headers: { 'Last-Event-ID': 'post-42' } })
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

test('post events gain contentHtml; id and event lines are byte-verbatim (replay contract)', async () => {
	const frame = `event: post\nid: p-1\ndata: ${JSON.stringify({ id: 'p-1', content: '<script>x</script><p>hi</p>', source: 'remote', author: {} })}\n\n`
	const body = new ReadableStream({
		start(controller) {
			const b = new TextEncoder().encode(frame)
			// split mid-frame to prove chunk buffering works
			controller.enqueue(b.slice(0, 25))
			controller.enqueue(b.slice(25))
			controller.close()
		}
	})
	global.fetch = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
	const res = await GET({ request: new Request('http://x/stream') } as never)
	const text = await res.text()
	expect(text).toContain('event: post\n')
	expect(text).toContain('id: p-1\n')
	const data = JSON.parse(text.split('data: ')[1].split('\n')[0])
	expect(data.contentHtml).toContain('<p>hi</p>')
	expect(data.contentHtml).not.toContain('script')
})

test('a resolved-reply frame carrying rootReplyCount retains it after contentHtml enrichment', async () => {
	const frame = `event: post\nid: p-4\ndata: ${JSON.stringify({ id: 'p-4', content: 'a reply', source: 'local', author: {}, inReplyToPostId: 'root-1', threadRootId: 'root-1', rootReplyCount: 3 })}\n\n`
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(frame))
			controller.close()
		}
	})
	global.fetch = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
	const res = await GET({ request: new Request('http://x/stream') } as never)
	const text = await res.text()
	const data = JSON.parse(text.split('data: ')[1].split('\n')[0])
	expect(data.contentHtml).toBeDefined()
	expect(data.rootReplyCount).toBe(3)
})

test('an unparseable frame forwards untouched', async () => {
	const frame = 'event: post\nid: p-2\ndata: not-json\n\n'
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(frame))
			controller.close()
		}
	})
	global.fetch = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
	const res = await GET({ request: new Request('http://x/stream') } as never)
	expect(await res.text()).toContain('data: not-json\n')
})

test('a parseable-but-non-object data payload forwards byte-identical', async () => {
	const frame = 'event: post\nid: p-3\ndata: 123\n\n'
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(frame))
			controller.close()
		}
	})
	global.fetch = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
	const res = await GET({ request: new Request('http://x/stream') } as never)
	expect(await res.text()).toContain('data: 123\n')
})
