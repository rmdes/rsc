import { fail } from '@sveltejs/kit'
import { authedFetch, base, cookieHeader } from './session'
import { listSourceRuns, listSourceItems, refreshSource, purgeSource } from '$lib/logical-api'
import { AUDIT_CATEGORIES } from '$lib/logical-types'
import type { Cookies, RequestEvent } from '@sveltejs/kit'
import type { AdminRunProjection } from '$lib/logical-api'

// Purge's consequence is DISTINCT from unblock's: it permanently deletes the
// source's stored evidence, but the URL STAYS blocked by its tombstone (purge does
// NOT lift the block). Kept here (testable) beside the load, not only in the
// .svelte, so a rewrite to a generic "Are you sure?" fails a test.
const PURGE_CONSEQUENCE =
	'Purging permanently deletes all stored versions and evidence for this source — this cannot be undone. The URL stays blocked by its tombstone; purge does not restore anything or lift the block.'

interface SourceGovernance {
	id: string
	canonicalUrl: string
	attributionMode: string
	operation: 'enabled' | 'paused'
	governance: 'allowed' | 'quarantined' | 'blocked'
}

interface SourcePush {
	mode: 'websub' | 'rsscloud'
	state: 'pending' | 'active'
	expiresAt: string | null
}

async function sourceGovernance(f: typeof fetch, id: string): Promise<{ source: SourceGovernance; push: SourcePush | null } | null> {
	const res = await f(`${base()}/admin/sources/${encodeURIComponent(id)}`)
	if (res.status === 404) return null
	if (!res.ok) throw new Error(`source ${res.status}`)
	const body = (await res.json()) as { source: SourceGovernance; push?: Partial<SourcePush>; pushExpiresAt?: string | null }
	const s = body.source
	const p = body.push
	return {
		source: { id: s.id, canonicalUrl: s.canonicalUrl, attributionMode: s.attributionMode, operation: s.operation, governance: s.governance },
		push: p && p.mode && p.state ? { mode: p.mode, state: p.state, expiresAt: body.pushExpiresAt ?? null } : null
	}
}

export interface SourceDetail {
	sourceId: string
	source: SourceGovernance
	push: SourcePush | null
	latestRun: AdminRunProjection | null
	nonterminalCount: number
	conflictCount: number
	items: Awaited<ReturnType<typeof listSourceItems>>['items']
	itemsNextCursor: string | null
	purgeEligible: boolean
	purgeConsequence: string
	categories: readonly string[]
	refreshCommandId: string
	purgeCommandId: string
}

// Shared by the standalone /admin/sources/[sourceId] route AND the inline
// ?detail= panel on /admin/feeds — same reads, same shape, never a
// re-derivation (Task 9, admin redesign spec Component 4).
export async function loadSourceDetail(fetch: typeof globalThis.fetch, origin: string, cookies: Cookies, sourceId: string, itemsBefore: string | null): Promise<SourceDetail | null> {
	const f = authedFetch(fetch, origin, cookieHeader(cookies))
	const detail = await sourceGovernance(f, sourceId)
	if (!detail) return null
	const source = detail.source
	const runs = await listSourceRuns(f, sourceId)
	const itemsPage = await listSourceItems(f, sourceId, itemsBefore)
	return {
		sourceId,
		source,
		push: detail.push,
		latestRun: runs.items[0] ?? null,
		nonterminalCount: runs.items.filter((r) => r.status === 'processing').length,
		conflictCount: itemsPage.conflictCount,
		items: itemsPage.items,
		itemsNextCursor: itemsPage.nextCursor,
		purgeEligible: source.governance === 'blocked',
		purgeConsequence: PURGE_CONSEQUENCE,
		categories: AUDIT_CATEGORIES,
		refreshCommandId: crypto.randomUUID(),
		purgeCommandId: crypto.randomUUID()
	}
}

// The two form actions that go with the detail above, shared by BOTH surfaces
// that render it: the standalone /admin/sources/[sourceId] route and the
// inline ?detail= panel on /admin/feeds. SvelteKit `Actions` objects can't be
// re-exported across routes, but the handler functions can — each route's
// `actions` is `{ refresh: refreshAction, purge: purgeAction, … }`, so there is
// one implementation instead of two hand-synced copies.

export async function refreshAction(event: RequestEvent) {
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
}

export async function purgeAction(event: RequestEvent) {
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
