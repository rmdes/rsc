import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { createPost, deletePost } from '$lib/api'
import { getLogicalThread } from '$lib/logical-api'
import { enrichEntries } from '$lib/server/render'
import { authedFetch, cookieHeader, ensureSessionFetch } from '$lib/server/session'

export const load: PageServerLoad = async ({ fetch, params }) => {
	try {
		// A v2 core returns the bounded LogicalThreadEnvelope, which a malformed
		// reply fails CLOSED into the catch (coreDown) rather than casting to a
		// v1 thread. Placeholder (unavailable-ancestor) nodes ride through as
		// neutral marker entries; item nodes render as cards (D11). enrichEntries
		// adds contentHtml — a marker's content is '' so it never gets an {@html}.
		const t = await getLogicalThread(fetch, params.id)
		return { postId: params.id, thread: enrichEntries(t?.entries ?? []), rootId: t?.rootId ?? params.id }
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
		// asAdmin picks which core endpoint to call; core independently re-checks
		// ownership/admin-ness on both, so this is a routing hint, not a trust boundary.
		const asAdmin = form.get('asAdmin') === '1'
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await deletePost(f, id, { asAdmin })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'remove failed' })
		}
		return { removed: true }
	}
} satisfies Actions
