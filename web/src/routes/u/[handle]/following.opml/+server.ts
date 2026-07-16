import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export const GET: RequestHandler = async ({ params, fetch }) => {
	const upstream = await fetch(`${base()}/users/${encodeURIComponent(params.handle)}/following.opml`)
	return new Response(upstream.body, {
		status: upstream.status,
		headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/xml; charset=utf-8' }
	})
}
