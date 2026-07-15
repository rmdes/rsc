import type { PageServerLoad } from './$types'
import { getTimeline } from '$lib/api.ts'

export const load: PageServerLoad = async ({ fetch }) => {
	const timeline = await getTimeline(fetch)
	return { timeline }
}
