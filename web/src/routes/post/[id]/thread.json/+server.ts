import type { RequestHandler } from './$types'
import { getLogicalThread } from '$lib/logical-api'
import { enrichEntries } from '$lib/server/render'

// SEC-1: this is the wedge's ingress — thread entries include remote
// (untrusted) content and MUST be enriched server-side like every other
// route to the browser.
export const GET: RequestHandler = async ({ params, fetch }) => {
	// /post/:id/thread returns the bounded LogicalThreadEnvelope; a malformed
	// one fails closed (throws → 500, which the client's fetchThread tolerates
	// by leaving the wedge closed) rather than being cast to some other shape.
	const t = await getLogicalThread(fetch, params.id)
	if (!t) return Response.json({ thread: [] }, { status: 404 })
	return Response.json({ thread: enrichEntries(t.entries) })
}
