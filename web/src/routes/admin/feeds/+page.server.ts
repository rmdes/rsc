import { fail } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { listTombstones, unblockTombstone } from '$lib/logical-api'
import { AUDIT_CATEGORIES } from '$lib/logical-types'
import type { Actions, PageServerLoad } from './$types'

// Tombstone-unblock's consequence is DISTINCT from source-governance unblock (which
// returns a blocked source to quarantine): unblocking a TOMBSTONE only lifts the URL
// reservation so the URL is CREATABLE again — it restores NOTHING (no items, no
// evidence, no subscriptions come back). Kept here (testable) beside the load.
const TOMBSTONE_CONSEQUENCE =
	'Unblocking this tombstone lifts the URL reservation so the URL can be created again as a fresh source. Nothing is restored — no items, evidence, or subscriptions come back; a new source starts empty.'

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

async function listSources(f: typeof fetch, cursor: string | null, filter?: 'governance'): Promise<{ items: SourceSummary[]; nextCursor: string | null }> {
	const qs = [cursor ? `cursor=${encodeURIComponent(cursor)}` : '', filter ? `filter=${filter}` : ''].filter(Boolean).join('&')
	const res = await f(`${base()}/admin/sources${qs ? `?${qs}` : ''}`)
	if (!res.ok) throw new Error(await coreError(res, `listAdminSources ${res.status}`))
	return (await res.json()) as { items: SourceSummary[]; nextCursor: string | null }
}

export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	const cursor = url.searchParams.get('cursor')
	// The federation/review sections must not depend on WHICH page of the
	// created_at pagination is being viewed (a bulk OPML import buried three
	// approved federations behind "None." — found dogfooding 2026-07-25). The
	// governance fetch returns every federated-or-quarantined row; the page
	// fetch keeps paginating ordinary subscriptions. Union, governance first,
	// deduped by id — grouping below then sees the complete governance set on
	// every page.
	const [page, governance] = await Promise.all([listSources(f, cursor), listSources(f, null, 'governance')])
	const governanceIds = new Set(governance.items.map((s) => s.source.id))
	const rows = [...governance.items, ...page.items.filter((s) => !governanceIds.has(s.source.id))].map(toRow)
	// V3: the reserved blocked/tombstoned URLs (unpaginated). One command id per
	// rendered unblock form — a resubmit replays the identical id (design §11).
	const tombstones = (await listTombstones(f)).map((t) => ({ ...t, commandId: crypto.randomUUID() }))
	return {
		mode: 'v2' as const,
		groups: GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => r.group === g.key) })),
		tombstones,
		tombstoneConsequence: TOMBSTONE_CONSEQUENCE,
		categories: AUDIT_CATEGORIES,
		// The cursor that produced THIS page — echoed back so every mutating
		// form's action can carry it forward (design: no-JS pagination must
		// survive a mutation). `nextCursor` below is a different value: the
		// cursor for the page AFTER this one.
		cursor,
		nextCursor: page.nextCursor,
		establishCommandId: crypto.randomUUID()
	}
}

export const actions: Actions = {
	// v2-only: the markup that renders these two forms exists only while the
	// flag is on and always carries its own command id — no capability probe
	// needed (same carve as the following page's unsubscribe).
	source: async (event) => {
		const form = await event.request.formData()
		const action = String(form.get('action') ?? '')
		const sourceId = String(form.get('sourceId') ?? '').trim()
		const commandId = String(form.get('commandId') ?? '').trim()
		const category = String(form.get('category') ?? '').trim()
		const note = String(form.get('note') ?? '').trim()
		if (!ACTIONS.includes(action as SourceAction)) return fail(400, { error: 'unknown action' })
		if (!sourceId) return fail(400, { error: 'sourceId is required' })
		// A missing commandId is rejected, never minted: minting on a fail()
		// re-render would hand a RETRY a fresh id, so core sees a new command
		// instead of replaying the original result (design §11).
		if (!commandId) return fail(400, { error: 'commandId is required' })
		if (!category && !CATEGORY_OPTIONAL.has(action))
			return fail(400, { error: 'a moderation category is required', sourceId, action, commandId })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			const res = await f(`${base()}/admin/sources/${encodeURIComponent(sourceId)}/${action}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					commandId,
					...(category ? { category } : {}),
					...(note ? { note } : {}),
					...(action === 'attribution-mode' ? { attributionMode: String(form.get('attributionMode') ?? '') } : {})
				})
			})
			// core's two 409s (`invalid transition` vs `idempotency conflict`) are
			// different facts for an admin, so the body's message is surfaced as-is.
			// sourceId/action/commandId are echoed so the re-rendered page can pin
			// this exact form's hidden commandId to the one just submitted — a
			// retry replays the original command instead of minting a new one.
			if (!res.ok) return fail(400, { error: await coreError(res, `${action} failed`), sourceId, action, commandId })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : `${action} failed`, sourceId, action, commandId })
		}
		return { done: action }
	},
	establish: async (event) => {
		const form = await event.request.formData()
		const url = String(form.get('url') ?? '').trim()
		// Establishing federation is an operator-policy act with an instance peer:
		// the audit category and attribution mode are properties of the ACT, not
		// operator choices, so the form no longer asks (2026-07-24 maintainer call).
		// Core's pinned contract still requires both in the body.
		const attributionMode = 'aggregate'
		const category = 'operator_policy'
		const note = String(form.get('note') ?? '').trim()
		const commandId = String(form.get('commandId') ?? '').trim()
		if (!url) return fail(400, { error: 'a source URL is required' })
		// See the `source` action: a missing commandId is rejected, never minted.
		if (!commandId) return fail(400, { error: 'commandId is required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			const res = await f(`${base()}/admin/sources`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url, attributionMode, category, ...(note ? { note } : {}), commandId })
			})
			// commandId is echoed so a fail() re-render can reuse the submitted id
			// on retry, rather than the freshly-minted one load() would otherwise hand back.
			if (!res.ok) return fail(400, { error: await coreError(res, `establish ${res.status}`), commandId })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'establish failed', commandId })
		}
		return { established: true }
	},
	// v2-only: the unblock-tombstone markup exists only while the flag is on and
	// always carries its own command id — no capability probe (same carve as source).
	tombstone: async (event) => {
		const form = await event.request.formData()
		const tombstoneId = String(form.get('tombstoneId') ?? '').trim()
		const commandId = String(form.get('commandId') ?? '').trim()
		const category = String(form.get('category') ?? '').trim()
		const note = String(form.get('note') ?? '').trim()
		if (!tombstoneId) return fail(400, { error: 'tombstoneId is required' })
		// A missing commandId is rejected, never minted (see `source`): a retry must
		// replay the original command, not mint a fresh one (design §11).
		if (!commandId) return fail(400, { error: 'commandId is required' })
		if (!category) return fail(400, { error: 'a moderation category is required', tombstoneId, commandId })
		let outcome
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			outcome = await unblockTombstone(f, tombstoneId, { commandId, category, ...(note ? { note } : {}) })
		} catch (err) {
			return fail(502, { error: err instanceof Error ? err.message : 'unblock failed', tombstoneId, commandId })
		}
		// tombstoneId/commandId echoed so the re-rendered form pins THIS exact id.
		if (outcome.kind === 'unavailable') return fail(404, { error: 'This tombstone is unavailable.', tombstoneId, commandId }) // neutral
		if (outcome.kind === 'conflict') return fail(409, { error: outcome.error, tombstoneId, commandId }) // e.g. 'source not blocked', verbatim
		return { unblocked: true, commandId }
	}
}
