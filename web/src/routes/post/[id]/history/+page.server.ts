import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { getRevisions, getCapabilities } from '$lib/api'
import { getLogicalHistory } from '$lib/logical-api'
import { renderPostHtml } from '$lib/server/render'

export const load: PageServerLoad = async ({ fetch, params }) => {
	// A capability failure degrades to legacy. Under v2 the ordinary history route
	// returns LogicalHistoryEnvelope; a malformed envelope fails CLOSED to the
	// neutral 404 rather than being cast to a v1 revisions payload.
	const cap = await getCapabilities(fetch)
	if (cap.sourceModelV2) {
		let h
		try {
			h = await getLogicalHistory(fetch, params.id)
		} catch {
			throw error(404, 'no such post')
		}
		if (!h) throw error(404, 'no such post')
		// Every branch renders through the ONE server sanitizer twin.
		const render = (e: { content: string | null; markdown: string | null }) => renderPostHtml({ content: e.content ?? '', contentMarkdown: e.markdown, source: h.origin })
		const current = h.entries.find((e) => e.current)
		const versions = h.entries
			.filter((e) => !e.current)
			.sort((a, b) => a.sequence - b.sequence) // oldest-first
			.map((e) => ({ seenAt: e.updatedAt ?? '', html: render(e) }))
		return { postId: params.id, editedAt: current?.updatedAt ?? null, currentHtml: current ? render(current) : '', versions }
	}

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
