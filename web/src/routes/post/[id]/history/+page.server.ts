import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { getLogicalHistory } from '$lib/logical-api'
import { renderPostHtml } from '$lib/server/render'

export const load: PageServerLoad = async ({ fetch, params }) => {
	// The ordinary history route returns LogicalHistoryEnvelope; a malformed
	// envelope fails CLOSED to the neutral 404 rather than being cast to some
	// other shape.
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
		.map((e) => ({ key: e.sequence, seenAt: e.updatedAt ?? '', title: e.title ?? '', enclosures: e.enclosures, html: render(e) }))
	return {
		postId: params.id,
		editedAt: current?.updatedAt ?? null,
		currentHtml: current ? render(current) : '',
		currentTitle: current?.title ?? '',
		currentEnclosures: current?.enclosures ?? [],
		versions
	}
}
