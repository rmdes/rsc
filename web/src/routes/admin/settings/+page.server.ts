import { fail } from '@sveltejs/kit'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { getAdminSettings, patchAdminSettings } from '$lib/api'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	return { settings: await getAdminSettings(f) }
}

function parseNonNegativeInt(raw: FormDataEntryValue | null, field: string): number {
	const value = Number(String(raw ?? '').trim())
	if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be an integer ≥ 0`)
	return value
}

export const actions: Actions = {
	save: async (event) => {
		const form = await event.request.formData()
		let maxSubsPerUser: number, maxRemoteItemsPerSource: number, maxRemoteItemAgeDays: number
		try {
			maxSubsPerUser = parseNonNegativeInt(form.get('maxSubsPerUser'), 'maxSubsPerUser')
			maxRemoteItemsPerSource = parseNonNegativeInt(form.get('maxRemoteItemsPerSource'), 'maxRemoteItemsPerSource')
			maxRemoteItemAgeDays = parseNonNegativeInt(form.get('maxRemoteItemAgeDays'), 'maxRemoteItemAgeDays')
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'invalid input' })
		}
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await patchAdminSettings(f, { maxSubsPerUser, maxRemoteItemsPerSource, maxRemoteItemAgeDays })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'save failed' })
		}
		return { saved: true }
	}
}
