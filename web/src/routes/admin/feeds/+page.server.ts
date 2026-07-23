import { fail } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { listAdminFeeds, addRemoteUser, removeRemoteFeed, getCapabilities } from '$lib/api'
import type { Actions, PageServerLoad } from './$types'

// ponytail: the two v2 admin calls live here, not in $lib/api.ts, because this
// task's scope is this page and nothing else consumes them yet — which costs a
// third copy of `base()` (api.ts and server/session.ts already have one).
// Upgrade path: move them beside the other v2 wrappers the moment a second
// surface needs them.
const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

async function coreError(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as { error?: unknown }
		if (typeof body.error === 'string') return body.error
	} catch {
		// non-JSON body — use the fallback
	}
	return fallback
}

// core's `:action` segments (Task 7 contract). Every one equals its domain
// action verbatim except `attribution-mode` → `set_attribution_mode`, which is
// also the only one carrying an attributionMode. Membership is checked with
// Array.includes, never `in`/property lookup: `constructor` must not reach a
// core URL and land in an audit row's free-text action column.
const ACTIONS = ['pause', 'resume', 'quarantine', 'allow', 'approve', 'reject', 'revoke', 'block', 'unblock', 'attribution-mode'] as const
type SourceAction = (typeof ACTIONS)[number]
// Pause/resume are operational rather than moderation decisions, so they alone
// may carry no category (design §5); core 400s the others without one.
const CATEGORY_OPTIONAL: ReadonlySet<string> = new Set(['pause', 'resume'])

// Only the SourceSummary fields this page renders. Everything else core sends
// (provenance, retention, subscription counts) is ignored on purpose.
interface SourceSummary {
	source: { id: string; canonicalUrl: string; attributionMode: 'single_publisher' | 'aggregate'; operation: 'enabled' | 'paused'; governance: 'allowed' | 'quarantined' | 'blocked' }
	federationStatus: 'none' | 'pending' | 'approved'
}

// Not exported: SvelteKit only allows load/actions/etc. out of a +page.server.
const GROUPS = [
	{ key: 'federation', title: 'Approved federation', blurb: 'Federated with this instance. Revoking ends interoperability without changing governance or anyone’s subscriptions.' },
	{ key: 'review', title: 'Quarantine and pending federation', blurb: 'Quarantined sources keep being acquired but their deliveries stay out of ordinary timelines; pending candidates are not federated yet.' },
	{ key: 'user', title: 'Allowed user sources', blurb: 'Subscribed by users, allowed, not federated.' },
	{ key: 'blocked', title: 'Blocked sources', blurb: 'No acquisition, no eligible deliveries — still fully inspectable. Unblocking returns a source to quarantine, never straight to visibility.' }
] as const

const groupOf = (s: SourceSummary): (typeof GROUPS)[number]['key'] =>
	s.source.governance === 'blocked'
		? 'blocked'
		: s.source.governance === 'quarantined' || s.federationStatus === 'pending'
			? 'review'
			: s.federationStatus === 'approved'
				? 'federation'
				: 'user'

// The legal transitions for these axes, mirroring core's SOURCE_TRANSITIONS.
// Offering an illegal one would only earn core's 409 `invalid transition`.
const availableActions = (s: SourceSummary): SourceAction[] => [
	s.source.operation === 'enabled' ? 'pause' : 'resume',
	...(s.source.governance === 'allowed' ? (['quarantine'] as const) : []),
	...(s.source.governance === 'quarantined' ? (['allow'] as const) : []),
	...(s.federationStatus === 'pending' && s.source.governance !== 'blocked' ? (['approve'] as const) : []),
	...(s.federationStatus === 'pending' ? (['reject'] as const) : []),
	...(s.federationStatus === 'approved' ? (['revoke'] as const) : []),
	s.source.governance === 'blocked' ? 'unblock' : 'block',
	'attribution-mode'
]

// One command id per rendered form (design §11): resubmitting the same rendered
// form — browser retry, back-and-resubmit — replays the identical id, so core
// returns the original result instead of mutating twice.
const toRow = (s: SourceSummary) => ({
	id: s.source.id,
	url: s.source.canonicalUrl,
	governance: s.source.governance,
	operation: s.source.operation,
	attributionMode: s.source.attributionMode,
	federationStatus: s.federationStatus,
	group: groupOf(s),
	actions: availableActions(s).map((action) => ({ action, commandId: crypto.randomUUID() }))
})

async function listSources(f: typeof fetch, cursor: string | null): Promise<{ items: SourceSummary[]; nextCursor: string | null }> {
	const res = await f(`${base()}/admin/sources${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
	if (!res.ok) throw new Error(await coreError(res, `listAdminSources ${res.status}`))
	return (await res.json()) as { items: SourceSummary[]; nextCursor: string | null }
}

export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	// getCapabilities NEVER rejects: a probe failure reads as legacy, which is
	// exactly what the flag being off is. What it must never do is swallow a
	// core outage — both reads below still throw to the error page rather than
	// render a silently empty admin list.
	const cap = await getCapabilities(fetch)
	if (!cap.sourceModelV2) return { mode: 'legacy' as const, feeds: await listAdminFeeds(f) }
	const page = await listSources(f, url.searchParams.get('cursor'))
	const rows = page.items.map(toRow)
	return {
		mode: 'v2' as const,
		groups: GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => r.group === g.key) })),
		nextCursor: page.nextCursor,
		establishCommandId: crypto.randomUUID()
	}
}

export const actions: Actions = {
	add: async (event) => {
		const form = await event.request.formData()
		const feedUrl = String(form.get('feedUrl') ?? '').trim()
		const handle = String(form.get('handle') ?? '').trim()
		const displayName = String(form.get('displayName') ?? '').trim()
		if (!handle || !feedUrl) return fail(400, { error: 'handle and feedUrl are required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await addRemoteUser(f, { handle, displayName: displayName || handle, feedUrl })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'add failed' })
		}
		return { added: true }
	},
	remove: async (event) => {
		const form = await event.request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		if (!handle) return fail(400, { error: 'handle required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await removeRemoteFeed(f, handle)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'remove failed' })
		}
		return { removed: true }
	},
	// v2-only: the markup that renders these two forms exists only while the
	// flag is on and always carries its own command id — no capability probe
	// needed (same carve as the following page's unsubscribe).
	source: async (event) => {
		const form = await event.request.formData()
		const action = String(form.get('action') ?? '')
		const sourceId = String(form.get('sourceId') ?? '').trim()
		const category = String(form.get('category') ?? '').trim()
		const note = String(form.get('note') ?? '').trim()
		if (!ACTIONS.includes(action as SourceAction)) return fail(400, { error: 'unknown action' })
		if (!sourceId) return fail(400, { error: 'sourceId is required' })
		if (!category && !CATEGORY_OPTIONAL.has(action)) return fail(400, { error: 'a moderation category is required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			const res = await f(`${base()}/admin/sources/${encodeURIComponent(sourceId)}/${action}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					commandId: String(form.get('commandId') ?? '') || crypto.randomUUID(),
					...(category ? { category } : {}),
					...(note ? { note } : {}),
					...(action === 'attribution-mode' ? { attributionMode: String(form.get('attributionMode') ?? '') } : {})
				})
			})
			// core's two 409s (`invalid transition` vs `idempotency conflict`) are
			// different facts for an admin, so the body's message is surfaced as-is.
			if (!res.ok) return fail(400, { error: await coreError(res, `${action} failed`) })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : `${action} failed` })
		}
		return { done: action }
	},
	establish: async (event) => {
		const form = await event.request.formData()
		const url = String(form.get('url') ?? '').trim()
		const attributionMode = String(form.get('attributionMode') ?? '').trim()
		const category = String(form.get('category') ?? '').trim()
		const note = String(form.get('note') ?? '').trim()
		if (!url || !category) return fail(400, { error: 'a source URL and a category are required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			const res = await f(`${base()}/admin/sources`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url, attributionMode, category, ...(note ? { note } : {}), commandId: String(form.get('commandId') ?? '') || crypto.randomUUID() })
			})
			if (!res.ok) return fail(400, { error: await coreError(res, `establish ${res.status}`) })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'establish failed' })
		}
		return { established: true }
	}
}
