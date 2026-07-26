import { test, expect, vi, afterEach } from 'vitest'
import { GET } from './+server.ts'

const originalFetch = global.fetch

afterEach(() => {
	global.fetch = originalFetch
})

test('GET proxies the core journal stream with the right headers', async () => {
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('event: reset\ndata: {"model":"logical-v2","kind":"reset"}\n\n'))
			controller.close()
		}
	})
	const fetchMock = vi.fn(async () => new Response(body, { status: 200 }))
	global.fetch = fetchMock as unknown as typeof fetch

	const request = new Request('http://x/stream')
	const res = await GET({ request } as never)

	expect(fetchMock).toHaveBeenCalledWith('http://localhost:8787/stream', expect.objectContaining({ signal: request.signal }))
	expect(res.headers.get('content-type')).toBe('text/event-stream')
	expect(res.headers.get('cache-control')).toBe('no-cache')

	const text = await res.text()
	expect(text).toContain('event: reset')
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

// --- logical-v2 frame translation --------------------------------------------
// The proxy always reads core's /stream journal and translates
// LogicalV2StreamEvent frames into the render-shape events the client
// reconciler consumes.

const v2item = (over = {}) => ({
	kind: 'logical_item',
	id: 'i1',
	origin: 'remote',
	parentResolutionState: 'none',
	parentLogicalItemId: null,
	threadRootId: null,
	selectedAuthor: { kind: 'remote_publisher', id: 'pub1', displayName: 'Pub', canonicalFeedUrl: 'https://ex.com/f.xml', profileAvailable: true, attributionLevel: 'bound_single_publisher' },
	title: null,
	content: '<script>x</script><p>hi</p>',
	contentMarkdown: null,
	permalink: 'https://ex.com/i1',
	sourceLink: 'https://ex.com/i1',
	replyContext: null,
	enclosures: [],
	publishedAt: '2026-07-20T00:00:00.000Z',
	updatedAt: null,
	updatedAtProvenance: null,
	directReplyCount: 0,
	conversationReplyCount: 1,
	classification: { personal: false, federated: true },
	...over
})
const streamOf = (frame: string, status = 200) =>
	(global.fetch = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame)); c.close() } }), { status })) as unknown as typeof fetch)

// A page rendered before ?v2=1 stopped being sent keeps working: the param is
// ignored, never rejected, and the upstream is the journal either way.
test('a stale ?v2=1 is tolerated — still core /stream, Last-Event-ID still forwarded', async () => {
	const fetchMock = streamOf('event: reset\ndata: {"model":"logical-v2","kind":"reset"}\n\n')
	await GET({ request: new Request('http://x/stream?v2=1', { headers: { 'Last-Event-ID': 'jc-9' } }) } as never)
	expect(String((fetchMock as any).mock.calls[0][0])).toBe('http://localhost:8787/stream')
	expect(new Headers(((fetchMock as any).mock.calls[0][1] as RequestInit).headers).get('Last-Event-ID')).toBe('jc-9')
})

test('v2: an upsert frame becomes event: upsert with an enriched, sanitized entry; id byte-verbatim', async () => {
	streamOf(`event: upsert\nid: jc-1\ndata: ${JSON.stringify({ model: 'logical-v2', kind: 'upsert', logicalItemId: 'i1', item: v2item() })}\n\n`)
	const res = await GET({ request: new Request('http://x/stream') } as never)
	const text = await res.text()
	expect(text).toContain('event: upsert\n')
	expect(text).toContain('id: jc-1\n')
	const data = JSON.parse(text.split('data: ')[1].split('\n')[0])
	expect(data.id).toBe('i1')
	expect(data.author.displayName).toBe('Pub')
	expect(data.contentHtml).toContain('<p>hi</p>')
	expect(data.contentHtml).not.toContain('script')
})

test('v2: an upsert of a resolved reply carries the replyCounts overlay (rootReplyCount + threadRootId)', async () => {
	const reply = v2item({ id: 'rep', parentResolutionState: 'resolved', parentLogicalItemId: 'root', threadRootId: 'root' })
	streamOf(`event: upsert\nid: jc-2\ndata: ${JSON.stringify({ model: 'logical-v2', kind: 'upsert', logicalItemId: 'rep', item: reply, replyCounts: { rootLogicalItemId: 'root', rootConversationReplyCount: 4 } })}\n\n`)
	const res = await GET({ request: new Request('http://x/stream') } as never)
	const data = JSON.parse((await res.text()).split('data: ')[1].split('\n')[0])
	expect(data.rootReplyCount).toBe(4)
	expect(data.threadRootId).toBe('root')
})

test('v2: a remove frame becomes event: remove carrying the id (+ overlay when present)', async () => {
	streamOf(`event: remove\nid: jc-3\ndata: ${JSON.stringify({ model: 'logical-v2', kind: 'remove', logicalItemId: 'gone', replyCounts: { rootLogicalItemId: 'root', rootConversationReplyCount: 2 } })}\n\n`)
	const res = await GET({ request: new Request('http://x/stream') } as never)
	const text = await res.text()
	expect(text).toContain('event: remove\n')
	const data = JSON.parse(text.split('data: ')[1].split('\n')[0])
	expect(data.id).toBe('gone')
	expect(data.rootReplyCount).toBe(2)
	expect(data.threadRootId).toBe('root')
})

test('v2: a reset frame passes through unchanged', async () => {
	streamOf('event: reset\ndata: {"model":"logical-v2","kind":"reset"}\n\n')
	const res = await GET({ request: new Request('http://x/stream') } as never)
	expect(await res.text()).toContain('event: reset\n')
})

test('v2: a malformed upsert data fails closed — a reset frame replaces it, never a v1 cast', async () => {
	streamOf('event: upsert\nid: jc-4\ndata: {"model":"logical-v2","kind":"upsert","logicalItemId":"i1","item":{"broken":true}}\n\n')
	const res = await GET({ request: new Request('http://x/stream') } as never)
	const text = await res.text()
	expect(text).toContain('event: reset\n')
	expect(text).not.toContain('event: upsert')
})
