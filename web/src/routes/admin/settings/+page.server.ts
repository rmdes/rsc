import { fail } from '@sveltejs/kit'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { getAdminSettings, patchAdminSettings } from '$lib/api'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	return { settings: await getAdminSettings(f) }
}

export const actions: Actions = {
	save: async (event) => {
		const raw = String((await event.request.formData()).get('maxSubsPerUser') ?? '').trim()
		const value = Number(raw)
		if (!Number.isInteger(value) || value < 0) return fail(400, { error: 'maxSubsPerUser must be an integer ≥ 0' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await patchAdminSettings(f, { maxSubsPerUser: value })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'save failed' })
		}
		return { saved: true }
	}
}
