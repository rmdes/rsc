import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { getThread, createPost } from '$lib/api'
import { enrichEntries } from '$lib/server/render'
import { ensureSessionFetch } from '$lib/server/session'

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
	}
} satisfies Actions
