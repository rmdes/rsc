import type { RequestHandler } from './$types'
import { base } from '$lib/server/session'

// Generic catch-all for the phase 2-4 JSON REST routes (spec: "Namespace",
// rev 2 — one forwarder for all of them, since none needs frame
// transformation; the firehose is the one exception and keeps its own
// bespoke proxy at web/src/routes/api/v1/firehose/stream/+server.ts).
// Forwards x-api-key, not cookies — this app's api-key-authed routes never
// accept a session, so there is nothing else to relay.
const proxy: RequestHandler = async ({ request, params, url }) => {
	const target = `${base()}/${params.path}${url.search}`
	const headers: Record<string, string> = {}
	const apiKey = request.headers.get('x-api-key')
	if (apiKey) headers['x-api-key'] = apiKey
	const ct = request.headers.get('content-type')
	if (ct) headers['content-type'] = ct

	const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
	let upstream: Response
	try {
		upstream = await fetch(target, {
			method: request.method,
			headers,
			body: hasBody ? await request.text() : undefined
		})
	} catch {
		return new Response('core unavailable', { status: 503 })
	}
	const out = new Headers()
	const outCt = upstream.headers.get('content-type')
	if (outCt) out.set('content-type', outCt)
	return new Response(upstream.body, { status: upstream.status, headers: out })
}

export const GET = proxy
export const POST = proxy
export const PATCH = proxy
export const DELETE = proxy
