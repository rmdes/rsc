import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export const GET: RequestHandler = async ({ request }) => {
	// EventSource sends Last-Event-ID on reconnect; forwarding it lets core
	// replay missed posts through this proxy.
	const lastEventId = request.headers.get('last-event-id')
	const upstream = await fetch(`${base()}/timeline/stream`, {
		signal: request.signal,
		headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {}
	})
	if (!upstream.ok) {
		return new Response(upstream.body, {
			status: upstream.status,
			headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' }
		})
	}
	return new Response(upstream.body, {
		status: upstream.status,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache'
		}
	})
}
