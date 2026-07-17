import type { PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { getTimeline, createPost, addRemoteUser } from '$lib/api'
import { enrichEntries } from '$lib/server/render'
import { authedFetch, cookieHeader, ensureSessionFetch } from '$lib/server/session'

export const load: PageServerLoad = async ({ fetch, url }) => {
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	try {
		const { timeline, nextCursor } = await getTimeline(fetch, { before })
		return { timeline: enrichEntries(timeline), nextCursor, isFirstPage }
	} catch {
		return { timeline: [], nextCursor: null, isFirstPage, coreDown: true }
	}
}

export const actions = {
	compose: async (event) => {
		const form = await event.request.formData()
		const content = String(form.get('content') ?? '').trim()
		if (!content) return fail(400, { error: 'content is required' })
		try {
			const f = await ensureSessionFetch(event)
			await createPost(f, { content })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'createPost failed' })
		}
		throw redirect(303, '/')
	},
	addRemote: async (event) => {
		const form = await event.request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		const displayName = String(form.get('displayName') ?? '').trim() || handle
		const feedUrl = String(form.get('feedUrl') ?? '').trim()
		if (!handle || !feedUrl) return fail(400, { error: 'handle and feedUrl are required' })
		try {
			// no mint: adding feeds is registered-only; a sessionless POST gets core's 401/403
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await addRemoteUser(f, { handle, displayName, feedUrl })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'addRemoteUser failed' })
		}
		throw redirect(303, '/')
	}
} satisfies import('./$types').Actions
