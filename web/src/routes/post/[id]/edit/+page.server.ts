import type { PageServerLoad, Actions } from './$types'
import { error, fail, redirect } from '@sveltejs/kit'
import { editPost } from '$lib/api'
import { getLogicalThread } from '$lib/logical-api'
import { ensureSessionFetch } from '$lib/server/session'

export const load: PageServerLoad = async ({ fetch, params, parent }) => {
	const { me } = await parent()
	// The v2 /thread path serves the LogicalThreadEnvelope, whose mapped entries
	// carry source/author so the ownership check below is shape-independent.
	// Any failure (malformed envelope included) degrades to the 404 below.
	const post = await (async () => {
		const t = await getLogicalThread(fetch, params.id)
		return t?.entries.find((p) => p.id === params.id)
	})().catch(() => undefined)
	if (!post) throw error(404, 'no such post')
	if (post.source !== 'local' || !me || me.user.id !== post.author.id) throw error(403, 'not your post')
	return { post }
}

export const actions = {
	edit: async (event) => {
		const content = String((await event.request.formData()).get('content') ?? '').trim()
		if (!content) return fail(400, { error: 'content is required' })
		try {
			const f = await ensureSessionFetch(event)
			await editPost(f, event.params.id, content)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'edit failed' })
		}
		throw redirect(303, `/post/${event.params.id}`)
	}
} satisfies Actions
