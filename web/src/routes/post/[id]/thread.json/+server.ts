import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { getCapabilities } from '$lib/api'
import { getLogicalThread } from '$lib/logical-api'
import { enrichEntries } from '$lib/server/render'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

// SEC-1: this is the wedge's ingress — thread entries include remote
// (untrusted) content and MUST be enriched server-side like every other
// route to the browser.
export const GET: RequestHandler = async ({ params, fetch }) => {
	// Under v2 the same /post/:id/thread returns the bounded LogicalThreadEnvelope;
	// a malformed one fails closed (throws → 500, which the client's fetchThread
	// tolerates by leaving the wedge closed) rather than being cast to a v1 thread.
	const cap = await getCapabilities(fetch)
	if (cap.sourceModelV2) {
		const t = await getLogicalThread(fetch, params.id)
		if (!t) return Response.json({ thread: [] }, { status: 404 })
		return Response.json({ thread: enrichEntries(t.entries) })
	}
	const upstream = await fetch(`${base()}/post/${encodeURIComponent(params.id)}/thread`)
	if (!upstream.ok) {
		return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } })
	}
	const body = (await upstream.json()) as { thread: Parameters<typeof enrichEntries>[0] }
	return Response.json({ thread: enrichEntries(body.thread) })
}
