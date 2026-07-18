import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { getThread, createPost, deletePost } from '$lib/api'
import { enrichEntries } from '$lib/server/render'
import { authedFetch, cookieHeader, ensureSessionFetch } from '$lib/server/session'

export const load: PageServerLoad = async ({ fetch, params }) => {
	try {
		const thread = await getThread(fetch, params.id)
		return { postId: params.id, thread: enrichEntries(thread), rootId: thread[0]?.id ?? params.id }
	} catch {
		return { postId: params.id, thread: [], rootId: params.id, coreDown: true }
	}
}

export const actions = {
	reply: async (event) => {
		const form = await event.request.formData()
		const content = String(form.get('content') ?? '').trim()
		if (!content) return fail(400, { error: 'content is required' })
		try {
			const f = await ensureSessionFetch(event)
			await createPost(f, { content, inReplyTo: event.params.id })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'reply failed' })
		}
		throw redirect(303, `/post/${event.params.id}`)
	},
	deletePost: async (event) => {
		const form = await event.request.formData()
		const id = String(form.get('id') ?? '').trim()
		if (!id) return fail(400, { error: 'id required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await deletePost(f, id)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'remove failed' })
		}
		return { removed: true }
	}
} satisfies Actions
