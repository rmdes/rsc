import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { renderPostHtml } from '$lib/server/render'
import { asStreamEvent, logicalToEntry } from '$lib/logical-types'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

const RESET_FRAME = 'event: reset\ndata: {"model":"logical-v2","kind":"reset"}\n\n'

export const GET: RequestHandler = async ({ request }) => {
	// The client already knows the model from its capability-checked SSR load, so
	// it opens /stream?v2=1 for the logical-v2 journal. No capability probe here:
	// trusting the client's own SSR reading avoids a second round trip AND keeps
	// the v1 path (no ?v2) byte-identical.
	const url = new URL(request.url)
	const v2 = url.searchParams.get('v2') === '1'
	// EventSource sends Last-Event-ID on auto-reconnect; forwarding it lets core
	// replay missed events. A FRESH EventSource cannot set that header, so ?last=
	// is the query-param fallback — the header wins when both exist.
	const lastEventId = request.headers.get('last-event-id') ?? url.searchParams.get('last')
	const upstreamUrl = `${base()}${v2 ? '/stream' : '/timeline/stream'}`
	let upstream: Response
	try {
		upstream = await fetch(upstreamUrl, {
			signal: request.signal,
			headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {}
		})
	} catch {
		// Core unreachable (restart under `node --watch` in dev, or a deploy): a
		// retryable 503 — EventSource reconnects on its own — not a 500.
		return new Response('core unavailable', { status: 503 })
	}
	if (!upstream.ok) {
		return new Response(upstream.body, {
			status: upstream.status,
			headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' }
		})
	}

	// A real SSE frame transformer, not a body pipe. Frames are buffered across
	// chunks and split on the blank-line delimiter; id: and event: lines pass
	// through BYTE-VERBATIM (the Last-Event-ID replay contract rests on them).
	const decoder = new TextDecoder()
	const encoder = new TextEncoder()
	let buffer = ''

	// V1: only `event: post` data: JSON is enriched with contentHtml; anything
	// unparseable forwards untouched (the client falls back to plaintext).
	const enrichV1 = (frame: string): string => {
		if (!/^event: post$/m.test(frame)) return frame
		return frame
			.split('\n')
			.map((line) => {
				if (!line.startsWith('data: ')) return line
				try {
					const entry = JSON.parse(line.slice(6))
					if (typeof entry !== 'object' || entry === null) return line
					return `data: ${JSON.stringify({ ...entry, contentHtml: renderPostHtml(entry) })}`
				} catch {
					return line
				}
			})
			.join('\n')
	}

	// V2: translate a LogicalV2StreamEvent frame into the render-shape event the
	// client reconciler consumes. upsert → enriched entry through the ONE server
	// sanitizer; remove → {id, overlay}; reset passes through. A malformed frame
	// FAILS CLOSED (spec §5.6 carve 2): a reset replaces it — never a v1 cast.
	const enrichV2 = (frame: string): string => {
		if (frame.startsWith(':') || !/^event: /m.test(frame)) return frame // heartbeat / stray
		if (/^event: reset$/m.test(frame)) return frame
		const idLine = frame.split('\n').find((l) => l.startsWith('id: '))
		const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
		if (!dataLine) return frame
		try {
			const ev = asStreamEvent(JSON.parse(dataLine.slice(6)))
			const head = `${idLine ? idLine + '\n' : ''}`
			// replyCounts ride a resolved-reply upsert/remove — an authoritative TOTAL.
			const overlay = ev.kind !== 'reset' && ev.replyCounts ? { rootReplyCount: ev.replyCounts.rootConversationReplyCount, threadRootId: ev.replyCounts.rootLogicalItemId } : {}
			if (ev.kind === 'upsert') {
				const entry = logicalToEntry(ev.item)
				const data = { ...entry, contentHtml: renderPostHtml(entry), ...overlay }
				return `event: upsert\n${head}data: ${JSON.stringify(data)}`
			}
			if (ev.kind === 'remove') {
				return `event: remove\n${head}data: ${JSON.stringify({ id: ev.logicalItemId, ...overlay })}`
			}
			return frame // reset (already handled above; defensive)
		} catch {
			return RESET_FRAME.trimEnd() // fail closed: the client discards + refetches + reconnects
		}
	}

	const enrichFrame = v2 ? enrichV2 : enrichV1
	const transformed = upstream.body!.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true })
				const frames = buffer.split('\n\n')
				buffer = frames.pop() ?? ''
				for (const frame of frames) controller.enqueue(encoder.encode(enrichFrame(frame) + '\n\n'))
			},
			flush(controller) {
				if (buffer) controller.enqueue(encoder.encode(enrichFrame(buffer)))
			}
		})
	)
	return new Response(transformed, {
		status: upstream.status,
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
	})
}
