import { authedFetch, base, cookieHeader } from './session'
import { listSourceRuns, listSourceItems } from '$lib/logical-api'
import { AUDIT_CATEGORIES } from '$lib/logical-types'
import type { Cookies } from '@sveltejs/kit'
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
