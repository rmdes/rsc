import type { RequestHandler } from './$types'
import { base } from '$lib/server/session'

export const GET: RequestHandler = async ({ params, fetch }) => {
	const upstream = await fetch(`${base()}/users/${encodeURIComponent(params.handle)}/following.opml`)
	return new Response(upstream.body, {
		status: upstream.status,
		headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/xml; charset=utf-8' }
	})
}
