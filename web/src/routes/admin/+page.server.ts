import { error, fail } from '@sveltejs/kit'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { listAdminFeeds, addRemoteUser, removeRemoteFeed } from '$lib/api'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ parent, fetch, url, cookies }) => {
	const { me } = await parent()
	if (!me?.isAdmin) throw error(404, 'Not found') // admin-only; hide existence
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	return { feeds: await listAdminFeeds(f) }
}

export const actions: Actions = {
	add: async (event) => {
		const form = await event.request.formData()
		const feedUrl = String(form.get('feedUrl') ?? '').trim()
		const handle = String(form.get('handle') ?? '').trim()
		const displayName = String(form.get('displayName') ?? '').trim()
		if (!handle || !feedUrl) return fail(400, { error: 'handle and feedUrl are required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await addRemoteUser(f, { handle, displayName: displayName || handle, feedUrl })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'add failed' })
		}
		return { added: true }
	},
	remove: async (event) => {
		const form = await event.request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		if (!handle) return fail(400, { error: 'handle required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await removeRemoteFeed(f, handle)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'remove failed' })
		}
		return { removed: true }
	},
}
