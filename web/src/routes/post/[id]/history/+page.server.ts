import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { getRevisions, getCapabilities } from '$lib/api'
import { getLogicalHistory } from '$lib/logical-api'
import type { EnclosureDto } from '$lib/logical-types'
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

	let data
	try {
		data = await getRevisions(fetch, params.id)
	} catch {
		throw error(404, 'no such post')
	}
	const source = data.post.source
	const currentHtml = renderPostHtml({ content: data.post.content, contentMarkdown: data.post.contentMarkdown, source })
	// v1 local posts store no enclosures — an empty list here is faithful, not a
	// fallback. Revision/post titles are carried as-is (Revision.title exists).
	const versions = data.revisions.map((r) => ({
		seenAt: r.seenAt,
		title: r.title ?? '',
		enclosures: [] as EnclosureDto[],
		html: renderPostHtml({ content: r.content, contentMarkdown: r.contentMarkdown, source })
	}))
	return {
		postId: params.id,
		editedAt: data.post.editedAt ?? null,
		currentHtml,
		currentTitle: data.post.title ?? '',
		currentEnclosures: [] as EnclosureDto[],
		versions
	}
}
