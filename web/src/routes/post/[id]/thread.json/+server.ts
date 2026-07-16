import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

// JSON for the wedge island — same server-side proxy pattern as /stream and
// the OPML export: the browser never talks to core directly.
export const GET: RequestHandler = async ({ params, fetch }) => {
	const upstream = await fetch(`${base()}/post/${encodeURIComponent(params.id)}/thread`)
	return new Response(upstream.body, {
		status: upstream.status,
		headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }
	})
}
