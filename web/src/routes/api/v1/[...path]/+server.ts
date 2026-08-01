import type { RequestHandler } from './$types'
import { base } from '$lib/server/session'

// Generic catch-all for the phase 2-4 JSON REST routes (spec: "Namespace",
// rev 2 — one forwarder for all of them, since none needs frame
// transformation; the firehose is the one exception and keeps its own
// bespoke proxy at web/src/routes/api/v1/firehose/stream/+server.ts).
// Forwards x-api-key, not cookies — this app's api-key-authed routes never
// accept a session, so there is nothing else to relay.
const proxy: RequestHandler = async ({ request, params, url }) => {
	// Final review Finding 2: no phase 2/3/4 route this proxy is meant to
	// serve lives under an `api/` prefix — but core mounts better-auth at
	// /api/auth/*, so without this guard a request to
	// /api/v1/api/auth/reference reaches core's dev-only openAPI reference
	// one path segment away from the auth proxy's own hard-404 guard
	// (web/src/routes/api/auth/[...path]/+server.ts), which CLAUDE.md calls
	// load-bearing. 404 (not 403), matching that guard's own reasoning.
	if (params.path.startsWith('api/')) return new Response(null, { status: 404 })
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
