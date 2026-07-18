import { fail } from '@sveltejs/kit'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { listAdminUsers, deleteLocalAccount } from '$lib/api'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	return { users: await listAdminUsers(f) }
}

export const actions: Actions = {
	deleteUser: async (event) => {
		const form = await event.request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		if (!handle) return fail(400, { error: 'handle required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await deleteLocalAccount(f, handle)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'delete failed' })
		}
		return { deleted: true }
	},
}
