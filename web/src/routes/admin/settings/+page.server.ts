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

const TAB_KEYS = ['local', 'federated', 'personal', 'public'] as const

// Only keys actually present on the submitted form are forwarded — a form with
// no "Timeline tabs" fields at all (e.g. a pre-feature caller) sends neither
// key, leaving the numeric-only PATCH shape unchanged.
function collectTabFields(form: FormData, prefix: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const key of TAB_KEYS) {
		const value = form.get(`${prefix}${key}`)
		if (value !== null) out[key] = String(value)
	}
	return out
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
		const tabLabels = collectTabFields(form, 'tab_label_')
		const tabSubtitles = collectTabFields(form, 'tab_subtitle_')
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await patchAdminSettings(f, {
				maxSubsPerUser,
				maxRemoteItemsPerSource,
				maxRemoteItemAgeDays,
				...(Object.keys(tabLabels).length ? { tabLabels } : {}),
				...(Object.keys(tabSubtitles).length ? { tabSubtitles } : {})
			})
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'save failed' })
		}
		return { saved: true }
	}
}
