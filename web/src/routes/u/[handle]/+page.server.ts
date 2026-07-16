import type { PageServerLoad } from './$types'
import { getTimeline } from '$lib/api'

export const load: PageServerLoad = async ({ fetch, params, url }) => {
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	try {
		const { timeline, nextCursor } = await getTimeline(fetch, { before, author: params.handle })
		return { handle: params.handle, timeline, nextCursor, isFirstPage }
	} catch {
		return { handle: params.handle, timeline: [], nextCursor: null, isFirstPage, coreDown: true }
	}
}
