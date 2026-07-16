import type { PageServerLoad, Actions } from './$types'
import { fail } from '@sveltejs/kit'
import { getTimeline, getFollowing, addFollow, removeFollow, importOpml } from '$lib/api'

export const load: PageServerLoad = async ({ fetch, params, url }) => {
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	try {
		const [{ timeline, nextCursor }, following] = await Promise.all([
			getTimeline(fetch, { before, followedBy: params.handle }),
			getFollowing(fetch, params.handle)
		])
		return { handle: params.handle, timeline, nextCursor, isFirstPage, following, followIds: following.map((u) => u.id) }
	} catch {
		return { handle: params.handle, timeline: [], nextCursor: null, isFirstPage, following: [], followIds: [], coreDown: true }
	}
}

export const actions = {
	follow: async ({ request, fetch, params }) => {
		const target = String((await request.formData()).get('target') ?? '').trim().toLowerCase()
		if (!target) return fail(400, { error: 'target handle is required' })
		try {
			await addFollow(fetch, params.handle, target)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'follow failed' })
		}
		return { ok: true }
	},
	unfollow: async ({ request, fetch, params }) => {
		const target = String((await request.formData()).get('target') ?? '').trim().toLowerCase()
		try {
			await removeFollow(fetch, params.handle, target)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'unfollow failed' })
		}
		return { ok: true }
	},
	import: async ({ request, fetch, params }) => {
		const file = (await request.formData()).get('opml')
		if (!(file instanceof File)) return fail(400, { error: 'choose an OPML file' })
		try {
			const result = await importOpml(fetch, params.handle, await file.text())
			return { ok: true, result }
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'import failed' })
		}
	}
} satisfies Actions
