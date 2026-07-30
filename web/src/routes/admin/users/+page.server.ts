import { fail } from '@sveltejs/kit'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { listAdminUsers, deleteLocalAccount } from '$lib/api'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	const cursor = url.searchParams.get('cursor') ?? undefined
	const page = await listAdminUsers(f, cursor)
	return { users: page.items, cursor, nextCursor: page.nextCursor }
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
	// No commandId — deleteLocalAccount has none today (verified: it's a
	// plain DELETE with no idempotency body), so bulk matches that posture
	// exactly rather than inventing one.
	bulkDelete: async (event) => {
		const form = await event.request.formData()
		const handles = form.getAll('handle').map(String)
		if (handles.length === 0) return { bulkDeleteResults: [] }
		const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
		const bulkDeleteResults = await Promise.all(
			handles.map(async (handle) => {
				try {
					await deleteLocalAccount(f, handle)
					return { handle, ok: true }
				} catch (err) {
					return { handle, ok: false, error: err instanceof Error ? err.message : 'delete failed' }
				}
			})
		)
		return { bulkDeleteResults }
	}
}
