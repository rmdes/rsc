import type { PageServerLoad } from './$types'
import { redirect, isRedirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { getLogicalRiverOrEmpty } from '$lib/logical-api'
import { enrichEntries } from '$lib/server/render'

// The permanent reserved-handle redirect (V4 §3.5). Every legacy remote handle
// is reserved at conversion; /u is local-accounts only, so a reserved handle
// redirects permanently to its publisher page. The reservation outlives source
// removal and purge, so a hit does NOT promise the publisher still exists —
// after a purge the redirect still fires and /p/:publisherId 404s through the
// ordinary not-found path (spec WP5). There is deliberately no post-purge branch.
// A non-200 (unreserved handle, or a core blip) simply renders the page as today.
async function reservedPublisher(f: typeof fetch, handle: string): Promise<string | null> {
	const res = await f(`${env.CORE_API_URL ?? 'http://localhost:8787'}/handles/${encodeURIComponent(handle)}`)
	if (!res.ok) return null
	const body = (await res.json()) as { reserved?: unknown; publisherId?: unknown }
	return body.reserved === true && typeof body.publisherId === 'string' ? body.publisherId : null
}

export const load: PageServerLoad = async ({ fetch, params, url }) => {
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	try {
		// The reservation lookup is a converted-instance fact; asking before the
		// river avoids rendering a page we are about to leave. 308 keeps the
		// method and marks the move permanent.
		const publisherId = await reservedPublisher(fetch, params.handle)
		if (publisherId) throw redirect(308, `/p/${publisherId}`)
		const { entries: timeline, nextCursor } = await getLogicalRiverOrEmpty(fetch, { before, author: params.handle })
		return { handle: params.handle, timeline: enrichEntries(timeline), nextCursor, isFirstPage }
	} catch (e) {
		// A redirect is control flow, not a core failure — it must not be swallowed
		// into the coreDown fallback below.
		if (isRedirect(e)) throw e
		return { handle: params.handle, timeline: [], nextCursor: null, isFirstPage, coreDown: true }
	}
}
