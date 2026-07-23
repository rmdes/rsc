import type { PageServerLoad } from './$types'
import { getTimeline, getCapabilities, peekCapabilities } from '$lib/api'
import { getLogicalRiverOrEmpty } from '$lib/logical-api'
import { enrichEntries } from '$lib/server/render'

export const load: PageServerLoad = async ({ fetch, params, url }) => {
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	try {
		// Ride the v1 author call alongside capability on a cold pod; a v2 core
		// answers the same /timeline with the logical `author=<handle>` lens (a
		// local-account activity view; /u stays local-only, /p is the publisher).
		const known = peekCapabilities()
		const v1P = known?.sourceModelV2 ? null : getTimeline(fetch, { before, author: params.handle })
		const cap = await getCapabilities(fetch)
		let timeline, nextCursor
		if (cap.sourceModelV2) {
			v1P?.catch(() => {})
			;({ entries: timeline, nextCursor } = await getLogicalRiverOrEmpty(fetch, { before, author: params.handle }))
		} else {
			;({ timeline, nextCursor } = await v1P!)
		}
		return { handle: params.handle, timeline: enrichEntries(timeline), nextCursor, isFirstPage, sourceModelV2: cap.sourceModelV2 || undefined }
	} catch {
		return { handle: params.handle, timeline: [], nextCursor: null, isFirstPage, coreDown: true }
	}
}
