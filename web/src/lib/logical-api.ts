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

// A SECONDARY river (author page, follows-management page): a v2 contract
// violation discards the river to empty — the malformed payload is NOT rendered
// and NEVER cast to v1 — while the rest of the page, built from an independently
// valid envelope, still renders. A network failure (non-200) still propagates so
// the page can degrade to coreDown. The PRIMARY home river fails the whole page
// closed instead (spec §5.6 carve 2; tested in page.load.test.ts).
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
