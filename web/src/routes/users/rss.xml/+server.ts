import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

// The all-users firehose on the WEB origin (Dave's /users/rss.xml
// convention) — the autodiscovery link in the layout points here, so a feed
// reader given the root domain subscribes to everyone. Same proxy shape as
// /u/[handle]/feed.xml.
export const GET: RequestHandler = async ({ fetch }) => {
	const upstream = await fetch(`${base()}/users/rss.xml`)
	return new Response(upstream.body, {
		status: upstream.status,
		headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/rss+xml; charset=utf-8' }
	})
}
