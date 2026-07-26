import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { getLogicalTimeline } from '$lib/logical-api'
import { enrichEntries } from '$lib/server/render'

// The publisher page (spec §3.6) is logical-v2 ONLY: it reuses core's
// /timeline?publisher=<opaque stableId>. A page exists only for a feed-anchored
// publisher supported by ordinary evidence — core returns a neutral 404 for
// unknown, administrator-only, source-scoped fallback, and non-navigable
// publishers, and this load turns any absence (404, malformed envelope, or a
// lens that is not a publisher) into the same ordinary 404. An empty descriptor
// (a valid publisher lens with no items) still renders. No publisher follow and
// no publisher feed are introduced; /u stays local-account only.
export const load: PageServerLoad = async ({ fetch, params, url }) => {
	const before = url.searchParams.get('before') ?? undefined
	let page
	try {
		page = await getLogicalTimeline(fetch, { publisher: params.publisherId, before })
	} catch {
		// core 404 (non-public publisher) OR a fail-closed contract violation:
		// same neutral ordinary 404, never a cast to any other shape.
		throw error(404, 'no such page')
	}
	if (page.lens.kind !== 'publisher') throw error(404, 'no such page')
	return { publisher: page.lens.publisher, timeline: enrichEntries(page.entries), nextCursor: page.nextCursor, isFirstPage: !before }
}
