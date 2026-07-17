import type { PageServerLoad, Actions } from './$types'
import { fail } from '@sveltejs/kit'
import { getTimeline, getFollowing, addFollow, removeFollow, importOpml } from '$lib/api'
import { enrichEntries } from '$lib/server/render'
import { authedFetch, cookieHeader, ensureSessionFetch } from '$lib/server/session'

export const load: PageServerLoad = async ({ fetch, params, url }) => {
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	try {
		const [{ timeline, nextCursor }, following] = await Promise.all([
			getTimeline(fetch, { before, followedBy: params.handle }),
			getFollowing(fetch, params.handle)
		])
		return { handle: params.handle, timeline: enrichEntries(timeline), nextCursor, isFirstPage, following, followIds: following.map((u) => u.id) }
	} catch {
		return { handle: params.handle, timeline: [], nextCursor: null, isFirstPage, following: [], followIds: [], coreDown: true }
	}
}

export const actions = {
	follow: async (event) => {
		const target = String((await event.request.formData()).get('target') ?? '').trim().toLowerCase()
		if (!target) return fail(400, { error: 'target handle is required' })
		try {
			const f = await ensureSessionFetch(event)
			await addFollow(f, target)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'follow failed' })
		}
		return { ok: true }
	},
	unfollow: async (event) => {
		const target = String((await event.request.formData()).get('target') ?? '').trim().toLowerCase()
		try {
			const f = await ensureSessionFetch(event)
			await removeFollow(f, target)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'unfollow failed' })
		}
		return { ok: true }
	},
	import: async (event) => {
		const file = (await event.request.formData()).get('opml')
		if (!(file instanceof File)) return fail(400, { error: 'choose an OPML file' })
		try {
			// no mint: OPML import is registered-only; a sessionless POST gets core's 401/403
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			const result = await importOpml(f, await file.text())
			return { ok: true, result }
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'import failed' })
		}
	}
} satisfies Actions
