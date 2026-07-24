import { error, fail } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { getCapabilities } from '$lib/api'
import { refreshSource, listSourceRuns } from '$lib/logical-api'
import type { Actions, PageServerLoad } from './$types'

// The v2-only admin acquisition console for one source (spec §6.2-6.3): a manual
// refresh action + a status panel (governance, latest run, nonterminal count). It
// mirrors the V1 admin-feeds capability carve EXACTLY — getCapabilities never
// rejects, a probe failure reads as legacy. With v2 off this whole source-model
// console does not exist, so the page is hidden as a 404 (there is no v1 per-source
// detail surface to fall back to). It exposes NO evidence-review navigation
// (deliveries, conflicts, findings, previews) — that is Vertical 3.

// ponytail: the V1 source-detail read (governance for quarantined labeling) is one
// inline call here; the v2 run/status calls live in $lib/logical-api.ts. base() is
// duplicated the same way the feeds page duplicates it — a third copy only if a
// second surface needs the V1 read.
const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

interface SourceGovernance {
	id: string
	canonicalUrl: string
	attributionMode: string
	operation: 'enabled' | 'paused'
	governance: 'allowed' | 'quarantined' | 'blocked'
}

// Only the governance fields the status panel renders reach the page. Everything
// else the V1 detail carries (provenance, retention, subscription/audit) is dropped.
async function sourceGovernance(f: typeof fetch, id: string): Promise<SourceGovernance | null> {
	const res = await f(`${base()}/admin/sources/${encodeURIComponent(id)}`)
	if (res.status === 404) return null
	if (!res.ok) throw new Error(`source ${res.status}`)
	const body = (await res.json()) as { source: SourceGovernance }
	const s = body.source
	return { id: s.id, canonicalUrl: s.canonicalUrl, attributionMode: s.attributionMode, operation: s.operation, governance: s.governance }
}

export const load: PageServerLoad = async ({ fetch, params, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	const cap = await getCapabilities(fetch)
	if (!cap.sourceModelV2) throw error(404, 'Not found') // the source-model console is v2-only
	const source = await sourceGovernance(f, params.sourceId)
	if (!source) throw error(404, 'Not found')
	const runs = await listSourceRuns(f, params.sourceId)
	return {
		sourceId: params.sourceId,
		source,
		// Latest run first (runs order by startedAt DESC). nonterminalRuns.count is
		// spec §6.3, but Task 5 shipped no source-summary route — derive the count
		// from this first page of runs (honest for the common case; a dedicated
		// summary route with durable health/scheduling reasons is a later task).
		latestRun: runs.items[0] ?? null,
		nonterminalCount: runs.items.filter((r) => r.status === 'processing').length,
		// One server-minted command id per rendered refresh form (spec §6.2): a
		// resubmit — browser retry, back-and-resubmit — replays the identical id, so
		// core returns the original run (disposition 'replayed') instead of a 2nd fetch.
		refreshCommandId: crypto.randomUUID()
	}
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
	}
}
