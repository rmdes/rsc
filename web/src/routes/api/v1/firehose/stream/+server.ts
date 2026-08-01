import type { RequestHandler } from './$types'
import { base } from '$lib/server/session'

// Public, anonymous — no cookie/session handling, unlike every other proxy
// in this app. A plain pass-through: core's /firehose/stream already emits
// the final wire-safe JSON shape (reusing the same content-rendering path
// /users/rss.xml uses), so unlike web/src/routes/stream/+server.ts (which
// renders raw internal DTOs through the sanitizer for the browser), this
// proxy does no frame transformation at all.
export const GET: RequestHandler = async ({ request }) => {
	const url = new URL(request.url)
	const lastEventId = request.headers.get('last-event-id') ?? url.searchParams.get('last')
	const upstreamUrl = `${base()}/firehose/stream`
	let upstream: Response
	try {
		upstream = await fetch(upstreamUrl, {
			signal: request.signal,
			headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {}
		})
	} catch {
		return new Response('core unavailable', { status: 503 })
	}
	if (!upstream.ok) {
		return new Response(upstream.body, {
			status: upstream.status,
			headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' }
		})
	}
	return new Response(upstream.body, {
		status: upstream.status,
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
	})
}
