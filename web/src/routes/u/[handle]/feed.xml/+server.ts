import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

// Browser-facing feed address for local users — the feed icon's href must be
// subscribable from a feed reader, and core is not exposed to browsers, so
// this proxies core's RSS the same way /stream and following.opml do.
export const GET: RequestHandler = async ({ params, fetch }) => {
	const upstream = await fetch(`${base()}/users/${encodeURIComponent(params.handle)}/feed.xml`)
	return new Response(upstream.body, {
		status: upstream.status,
		headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/rss+xml; charset=utf-8' }
	})
}
