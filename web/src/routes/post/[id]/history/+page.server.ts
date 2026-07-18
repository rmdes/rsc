import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { getRevisions } from '$lib/api'
import { renderPostHtml } from '$lib/server/render'

export const load: PageServerLoad = async ({ fetch, params }) => {
	let data
	try {
		data = await getRevisions(fetch, params.id)
	} catch {
		throw error(404, 'no such post')
	}
	const source = data.post.source
	const currentHtml = renderPostHtml({ content: data.post.content, contentMarkdown: data.post.contentMarkdown, source })
	const versions = data.revisions.map((r) => ({
		seenAt: r.seenAt,
		html: renderPostHtml({ content: r.content, contentMarkdown: r.contentMarkdown, source })
	}))
	return { postId: params.id, editedAt: data.post.editedAt ?? null, currentHtml, versions }
}
