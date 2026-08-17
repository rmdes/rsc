import { error, fail } from '@sveltejs/kit'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { getAdminItemDetail, listItemAudit, hideItem, restoreItem } from '$lib/logical-api'
import { deletePost } from '$lib/api'
import { AUDIT_CATEGORIES, type AuditCategory } from '$lib/logical-types'
import type { Actions, PageServerLoad } from './$types'

// The item-review surface (spec §7.3): the bounded evidence-review page behind
// GET /admin/items/:id + its first audit page, with hide/restore moderation
// forms. Raw evidence reaches the page as bounded escaped text (Web escapes at
// render via `{expr}`, NEVER {@html}, never routed through the sanitizer): no
// second sanitize path is introduced here.

export const load: PageServerLoad = async ({ fetch, params, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	const detail = await getAdminItemDetail(f, params.id)
	if (!detail) throw error(404, 'Not found') // neutral not-found (no evidence leak)
	// Paginate the audit trail: the ?before cursor from the "Older audit" link (an
	// absent cursor is null → first page). Mirrors the source-detail items load.
	const audit = await listItemAudit(f, params.id, url.searchParams.get('before'))
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

// A local item's logicalItemId IS its post id (materializeLocalItem/appendJournal
// both key the local logical row on the post id — core/src/logical/local.ts), so
// deletePost(itemId) is the same identity Hide/Restore already resolve. Removal
// has no idempotency ledger (core's RemovalBody carries {category, note?}, no
// commandId — service.deletePost's only outcomes are its 404/409 guards, nothing
// to replay against), unlike hide/restore's commandId-bearing ModBody above.
async function removeItem(event: Parameters<Actions[string]>[0]) {
	const form = await event.request.formData()
	const itemId = String(form.get('itemId') ?? '').trim()
	const category = String(form.get('category') ?? '').trim()
	const note = String(form.get('note') ?? '').trim()
	if (!itemId) return fail(400, { error: 'itemId is required' })
	if (!category) return fail(400, { error: 'a moderation category is required', kind: 'remove' })
	try {
		const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
		// deletePost throws uniformly on a non-ok response (unlike hideItem/restoreItem's
		// structured outcome above) — same fail(400) shape every other deletePost caller
		// in the app uses (+page.server.ts x2), not moderate()'s 404/409 split.
		await deletePost(f, itemId, { asAdmin: true, category: category as AuditCategory, ...(note ? { note } : {}) })
	} catch (err) {
		return fail(400, { error: err instanceof Error ? err.message : 'remove failed', kind: 'remove' })
	}
	return { done: 'remove' }
}

export const actions: Actions = {
	hide: (event) => moderate(event, 'hide'),
	restore: (event) => moderate(event, 'restore'),
	remove: removeItem
}
