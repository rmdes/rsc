import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { getThread, createPost } from '$lib/api'

export const load: PageServerLoad = async ({ fetch, params }) => {
	try {
		const thread = await getThread(fetch, params.id)
		return { postId: params.id, thread, rootId: thread[0]?.id ?? params.id }
	} catch {
		return { postId: params.id, thread: [], rootId: params.id, coreDown: true }
	}
}

export const actions = {
	reply: async ({ request, fetch, params }) => {
		const form = await request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		const content = String(form.get('content') ?? '').trim()
		if (!handle || !content) return fail(400, { error: 'handle and content are required' })
		try {
			await createPost(fetch, { handle, displayName: handle, content, inReplyTo: params.id })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'reply failed' })
		}
		throw redirect(303, `/post/${params.id}`)
	}
} satisfies Actions
