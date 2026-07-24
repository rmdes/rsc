// Capability-checked logical-v2 Core client (server-only — uses $env). Callers
// invoke these ONLY after `getCapabilities` reports v2; each function validates
// the `model: 'logical-v2'` envelope and FAILS CLOSED (throws LogicalContractError)
// on any mismatch — it never falls back to or casts a v1 shape (spec §5.6 carve 2).

import { env } from '$env/dynamic/private'
import { asLogicalTimeline, asLogicalSingleItem, asLogicalThread, asLogicalHistory, logicalToEntry, LogicalContractError, type RenderEntry, type TimelineLens, type LogicalHistoryEnvelope } from './logical-types.ts'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

// Exactly one lens selector (spec §3.5). Built with encodeURIComponent, never
// URLSearchParams (the cursor wire format `<ts>~<id>` mangles under form-encoding).
export interface V2Lens {
	origin?: 'local'
	followedBy?: string
	author?: string
	publisher?: string
	federated?: true
}

function timelineUrl(opts: V2Lens & { before?: string }): string {
	const url = new URL(`${base()}/timeline`)
	const p: string[] = []
	if (opts.origin) p.push(`origin=${opts.origin}`)
	if (opts.followedBy) p.push(`followed_by=${encodeURIComponent(opts.followedBy)}`)
	if (opts.author) p.push(`author=${encodeURIComponent(opts.author)}`)
	if (opts.publisher) p.push(`publisher=${encodeURIComponent(opts.publisher)}`)
	if (opts.federated) p.push('federated=true')
	if (opts.before) p.push(`before=${encodeURIComponent(opts.before)}`)
	if (p.length) url.search = p.join('&')
	return url.toString()
}

export interface V2TimelinePage {
	lens: TimelineLens
	entries: RenderEntry[]
	nextCursor: string | null
	journalCursor: string
}

export async function getLogicalTimeline(f: typeof fetch, opts: V2Lens & { before?: string }): Promise<V2TimelinePage> {
	const res = await f(timelineUrl(opts))
	if (!res.ok) throw new Error(`timeline ${res.status}`)
	const env = asLogicalTimeline(await res.json())
	return { lens: env.lens, entries: env.timeline.map(logicalToEntry), nextCursor: env.nextCursor, journalCursor: env.journalCursor }
}

// SECONDARY rivers ONLY — the /u author page and the /following follows-management
// page, where an independently-valid rest-of-page must still render. A v2 contract
// violation discards the river to empty (the malformed payload is NOT rendered and
// NEVER cast to v1); a network failure (non-200) still propagates so the page can
// degrade to coreDown. The PRIMARY home river does NOT use this: it calls
// getLogicalTimeline directly (the throwing variant) so a contract violation THROWS
// and fails the whole page closed to coreDown, rather than rendering a misleading
// empty v2 timeline (spec §5.6 carve 2; tested in page.load.test.ts).
export async function getLogicalRiverOrEmpty(f: typeof fetch, opts: V2Lens & { before?: string }): Promise<{ entries: RenderEntry[]; nextCursor: string | null; journalCursor: string | null }> {
	try {
		const page = await getLogicalTimeline(f, opts)
		return { entries: page.entries, nextCursor: page.nextCursor, journalCursor: page.journalCursor }
	} catch (e) {
		// A contract violation (spec §5.6 carve 2) discards the river to empty and
		// yields NO snapshot cursor (the live stream stays closed until a reload
		// gets a valid envelope) — never a v1 cast.
		if (e instanceof LogicalContractError) return { entries: [], nextCursor: null, journalCursor: null }
		throw e
	}
}

// The deliberate v2-only single-item route. 404 → null (the neutral ordinary
// not-found); a malformed 200 → fail closed.
export async function getLogicalItem(f: typeof fetch, id: string): Promise<{ entry: RenderEntry; journalCursor: string } | null> {
	const res = await f(`${base()}/post/${encodeURIComponent(id)}`)
	if (res.status === 404) return null
	if (!res.ok) throw new Error(`post ${res.status}`)
	const env = asLogicalSingleItem(await res.json())
	return { entry: logicalToEntry(env.item), journalCursor: env.journalCursor }
}

export interface V2Thread {
	rootId: string | null
	entries: RenderEntry[]
	truncated: { depth: boolean; nodes: boolean; cycle: boolean }
}

export async function getLogicalThread(f: typeof fetch, id: string): Promise<V2Thread | null> {
	const res = await f(`${base()}/post/${encodeURIComponent(id)}/thread`)
	if (res.status === 404) return null
	if (!res.ok) throw new Error(`thread ${res.status}`)
	const env = asLogicalThread(await res.json())
	// Placeholders are neutral connective markers (an unavailable ancestor), not
	// rendered cards; the flat ReplyTree keys off parent ids and tolerates a
	// missing link. ponytail: render only item nodes.
	const entries = env.nodes.flatMap((n) => (n.kind === 'item' ? [logicalToEntry(n.item)] : []))
	return { rootId: env.rootId, entries, truncated: env.truncated }
}

export async function getLogicalHistory(f: typeof fetch, id: string): Promise<LogicalHistoryEnvelope | null> {
	const res = await f(`${base()}/posts/${encodeURIComponent(id)}/revisions`)
	if (res.status === 404) return null
	if (!res.ok) throw new Error(`revisions ${res.status}`)
	return asLogicalHistory(await res.json())
}

// --- Admin acquisition operations (spec §6.2-6.3) — run/status only -----------
// The v2 admin refresh + run/job reads that back the /admin/sources/[sourceId]
// console. These are admin-only, same-origin envelopes carrying model:'logical-v2';
// unlike the ordinary read surfaces above they are NOT rendered through the
// sanitizer, so they carry no {@html} risk. Types are defined here (server-only)
// rather than in the pure logical-types twin — no browser bundle imports them, and
// logical-types.ts is not a Task 12 staged path (frozen).

export interface AdminFetchProjection {
	outcome: 'pending' | 'not_modified' | 'parsed' | 'completed_truncated' | 'redirect_conflict' | 'operational_failure' | 'cancelled' | 'superseded' | 'policy_rejected'
	effectiveUrl: string | null
	httpStatus: number | null
	failureCategory: 'network' | 'timeout' | 'http' | 'body_limit' | 'feed_parse' | 'policy' | 'superseded' | null
	diagnostic: string | null
}
export interface AdminAcquisitionCounters {
	candidates: number; seen: number; observed: number; unchanged: number; skipped: number; omitted: number; itemsTruncated: boolean; bodyLimitExceeded: boolean; notModified: boolean
}
export interface AdminReconciliationCounters {
	reconciled: number; conflicted: number; pending: number; processing: number; retrying: number; failed: number
	failedByCategory: { operationalExhausted: number; invariantOrDataFailure: number }
}
export interface AdminRunProjection {
	model: 'logical-v2'
	runId: string
	sourceId: string
	status: 'terminal' | 'processing'
	statusLocation: string
	fetch: AdminFetchProjection
	acquisition: AdminAcquisitionCounters
	reconciliation: AdminReconciliationCounters
}
export interface AdminRefreshResult extends AdminRunProjection {
	disposition: 'created' | 'joined' | 'replayed'
}
export interface AdminJobSummary {
	jobId: string
	createdAt: string
	status: 'pending' | 'processing' | 'retrying' | 'reconciled' | 'conflicted' | 'failed'
	attempts: number
	nextAttemptAt: string | null
	failureCategory: 'operational_exhausted' | 'invariant_or_data_failure' | null
	diagnostic: string | null
}
export interface AdminPage<T> {
	model: 'logical-v2'
	items: T[]
	nextCursor: string | null
}

// The refresh outcome, mapped from the four terminal HTTP results (spec §6.2):
// 200 → terminal (the run reached terminal in the wait window), 202 → polling
// (still processing — the page offers a poll affordance), 404 → refused (a
// paused/blocked/unknown source; NEUTRAL — no run and no evidence leaks), 409 →
// conflict (a reused commandId with a mismatched [command,sourceId,actor]).
export type RefreshOutcome =
	| { kind: 'terminal'; run: AdminRefreshResult }
	| { kind: 'polling'; run: AdminRefreshResult }
	| { kind: 'refused' }
	| { kind: 'conflict' }

export async function refreshSource(f: typeof fetch, sourceId: string, commandId: string): Promise<RefreshOutcome> {
	// commandId travels ONLY as the JSON body field (spec §6.2, review rev 1 C4) —
	// no Idempotency-Key header. The stable id is minted server-side and retained
	// across retry so a resubmit replays the original run rather than starting a new one.
	const res = await f(`${base()}/admin/sources/${encodeURIComponent(sourceId)}/refresh`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ commandId })
	})
	if (res.status === 404) return { kind: 'refused' } // neutral refusal — never read the body (no evidence)
	if (res.status === 409) return { kind: 'conflict' }
	if (!res.ok) throw new Error(`refresh ${res.status}`)
	const run = (await res.json()) as AdminRefreshResult
	return { kind: res.status === 202 ? 'polling' : 'terminal', run }
}

export async function listSourceRuns(f: typeof fetch, sourceId: string, before?: string | null): Promise<AdminPage<AdminRunProjection>> {
	const q = before ? `?before=${encodeURIComponent(before)}` : ''
	const res = await f(`${base()}/admin/sources/${encodeURIComponent(sourceId)}/runs${q}`)
	if (!res.ok) throw new Error(`runs ${res.status}`)
	return (await res.json()) as AdminPage<AdminRunProjection>
}

export async function listRunJobs(f: typeof fetch, runId: string, before?: string | null): Promise<AdminPage<AdminJobSummary>> {
	const q = before ? `?before=${encodeURIComponent(before)}` : ''
	const res = await f(`${base()}/admin/acquisition-runs/${encodeURIComponent(runId)}/jobs${q}`)
	if (!res.ok) throw new Error(`jobs ${res.status}`)
	return (await res.json()) as AdminPage<AdminJobSummary>
}
