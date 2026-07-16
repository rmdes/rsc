import type { PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { getTimeline, createPost, addRemoteUser } from '$lib/api'

export const load: PageServerLoad = async ({ fetch, url }) => {
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	try {
		const { timeline, nextCursor } = await getTimeline(fetch, { before })
		return { timeline, nextCursor, isFirstPage }
	} catch {
		return { timeline: [], nextCursor: null, isFirstPage, coreDown: true }
	}
}

export const actions = {
	compose: async ({ request, fetch }) => {
		const form = await request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		const displayName = String(form.get('displayName') ?? '').trim() || handle
		const content = String(form.get('content') ?? '').trim()
		if (!handle || !content) return fail(400, { error: 'handle and content are required' })
		try {
			await createPost(fetch, { handle, displayName, content })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'createPost failed' })
		}
		throw redirect(303, '/')
	},
	addRemote: async ({ request, fetch }) => {
		const form = await request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		const displayName = String(form.get('displayName') ?? '').trim() || handle
		const feedUrl = String(form.get('feedUrl') ?? '').trim()
		if (!handle || !feedUrl) return fail(400, { error: 'handle and feedUrl are required' })
		try {
			await addRemoteUser(fetch, { handle, displayName, feedUrl })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'addRemoteUser failed' })
		}
		throw redirect(303, '/')
	}
} satisfies import('./$types').Actions
