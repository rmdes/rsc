import { error, fail } from '@sveltejs/kit'
import { loadSourceDetail } from '$lib/server/source-detail'
import { authedFetch, base, cookieHeader } from '$lib/server/session'
import { refreshSource, purgeSource } from '$lib/logical-api'
import type { Actions, PageServerLoad } from './$types'

// The admin acquisition console for one source (spec §6.2-6.3): a manual
// refresh action + a status panel (governance, latest run, nonterminal count).
// It exposes NO evidence-review navigation (deliveries, conflicts, findings,
// previews) — that is Vertical 3. The load itself is shared (Task 9) with the
// ?detail= inline panel on /admin/feeds — see $lib/server/source-detail.ts.

export const load: PageServerLoad = async ({ fetch, params, url, cookies }) => {
	const detail = await loadSourceDetail(fetch, url.origin, cookies, params.sourceId, url.searchParams.get('before'))
	if (!detail) throw error(404, 'Not found')
	return detail
}

export const actions: Actions = {
	refresh: async (event) => {
		const form = await event.request.formData()
		const sourceId = String(form.get('sourceId') ?? '').trim()
		const commandId = String(form.get('commandId') ?? '').trim()
		if (!sourceId) return fail(400, { error: 'sourceId is required' })
		// A missing commandId is rejected, never minted: minting on a re-render would
		// hand a RETRY a fresh id, so core would see a new command instead of replaying.
		if (!commandId) return fail(400, { error: 'commandId is required', sourceId })
		let outcome
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			outcome = await refreshSource(f, sourceId, commandId)
		} catch (err) {
			return fail(502, { error: err instanceof Error ? err.message : 'refresh failed', sourceId, commandId })
		}
		// Every branch echoes the submitted commandId so the re-rendered form pins THIS
		// exact id and a retry replays the original command (spec §6.2).
		if (outcome.kind === 'refused') return { sourceId, commandId, refused: true } // neutral — no run, no evidence
		if (outcome.kind === 'conflict') return fail(409, { error: 'idempotency conflict', sourceId, commandId })
		return { sourceId, commandId, run: outcome.run, polling: outcome.kind === 'polling' }
	},
	purge: async (event) => {
		const form = await event.request.formData()
		const sourceId = String(form.get('sourceId') ?? '').trim()
		const commandId = String(form.get('commandId') ?? '').trim()
		const category = String(form.get('category') ?? '').trim()
		const note = String(form.get('note') ?? '').trim()
		if (!sourceId) return fail(400, { error: 'sourceId is required' })
		// A missing commandId is rejected, never minted (see refresh): a retry must
		// replay the original command, not mint a fresh one.
		if (!commandId) return fail(400, { error: 'commandId is required' })
		if (!category) return fail(400, { error: 'a moderation category is required', commandId })
		let outcome
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			outcome = await purgeSource(f, sourceId, { commandId, category, ...(note ? { note } : {}) })
		} catch (err) {
			return fail(502, { error: err instanceof Error ? err.message : 'purge failed', commandId, purge: true })
		}
		// commandId echoed (with a `purge` marker so the re-rendered purge form pins THIS
		// id) so the retry replays the original command instead of minting a new one.
		if (outcome.kind === 'unavailable') return fail(404, { error: 'This source is unavailable.', commandId, purge: true }) // neutral
		if (outcome.kind === 'conflict') return fail(409, { error: outcome.error, commandId, purge: true }) // e.g. 'source not blocked', verbatim
		return { purged: true, commandId }
	}
}
