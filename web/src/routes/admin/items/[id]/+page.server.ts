import { error, fail } from '@sveltejs/kit'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { getCapabilities } from '$lib/api'
import { getAdminItemDetail, listItemAudit, hideItem, restoreItem } from '$lib/logical-api'
import { AUDIT_CATEGORIES } from '$lib/logical-types'
import type { Actions, PageServerLoad } from './$types'

// The v2-only item-review surface (spec §7.3): the bounded evidence-review page
// behind GET /admin/items/:id + its first audit page, with hide/restore moderation
// forms. Same capability carve as the acquisition console — v2 off → 404 (there is
// no v1 evidence surface to fall back to). Raw evidence reaches the page as bounded
// escaped text (Web escapes at render via `{expr}`, NEVER {@html}, never routed
// through the sanitizer): no second sanitize path is introduced here.

export const load: PageServerLoad = async ({ fetch, params, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	const cap = await getCapabilities(fetch)
	if (!cap.sourceModelV2) throw error(404, 'Not found')
	const detail = await getAdminItemDetail(f, params.id)
	if (!detail) throw error(404, 'Not found') // neutral not-found (no evidence leak)
	const audit = await listItemAudit(f, params.id)
	return {
		id: params.id,
		detail,
		audit: audit.items,
		auditNextCursor: audit.nextCursor,
		categories: AUDIT_CATEGORIES,
		// One server-minted command id per rendered moderation form (design §11): a
		// resubmit — browser retry, back-and-resubmit — replays the identical id, so
		// core returns the original result instead of applying a second mutation.
		hideCommandId: crypto.randomUUID(),
		restoreCommandId: crypto.randomUUID()
	}
}

async function moderate(event: Parameters<Actions[string]>[0], kind: 'hide' | 'restore') {
	const form = await event.request.formData()
	const itemId = String(form.get('itemId') ?? '').trim()
	const commandId = String(form.get('commandId') ?? '').trim()
	const category = String(form.get('category') ?? '').trim()
	const note = String(form.get('note') ?? '').trim()
	if (!itemId) return fail(400, { error: 'itemId is required' })
	// A missing commandId is rejected, never minted: minting on a fail() re-render
	// would hand a RETRY a fresh id, so core would see a new command (design §11).
	if (!commandId) return fail(400, { error: 'commandId is required', kind })
	if (!category) return fail(400, { error: 'a moderation category is required', kind, commandId })
	let outcome
	try {
		const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
		const run = kind === 'hide' ? hideItem : restoreItem
		outcome = await run(f, itemId, { commandId, category, ...(note ? { note } : {}) })
	} catch (err) {
		return fail(502, { error: err instanceof Error ? err.message : `${kind} failed`, kind, commandId })
	}
	// Every failing branch echoes the submitted commandId so the re-rendered form
	// pins THIS exact id and a retry replays the original command.
	if (outcome.kind === 'unavailable') return fail(404, { error: 'This item is unavailable.', kind, commandId }) // neutral
	if (outcome.kind === 'conflict') return fail(409, { error: outcome.error, kind, commandId }) // the state-conflict fact, verbatim
	return { done: kind, commandId }
}

export const actions: Actions = {
	hide: (event) => moderate(event, 'hide'),
	restore: (event) => moderate(event, 'restore')
}
