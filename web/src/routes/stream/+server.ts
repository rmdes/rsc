import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export const GET: RequestHandler = async ({ request }) => {
	// NOTE: when SSE replay lands in core (#20), forward the Last-Event-ID request header here or
	// reconnect catch-up will silently not work through this proxy.
	const upstream = await fetch(`${base()}/timeline/stream`, { signal: request.signal })
	return new Response(upstream.body, {
		status: upstream.status,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache'
		}
	})
}
