import { fail } from '@sveltejs/kit'
import { authedFetch, base, cookieHeader } from '$lib/server/session'
import { listTombstones, unblockTombstone } from '$lib/logical-api'
import { AUDIT_CATEGORIES } from '$lib/logical-types'
import type { Actions, PageServerLoad } from './$types'

// Tombstone-unblock's consequence is DISTINCT from source-governance unblock (which
// returns a blocked source to quarantine): unblocking a TOMBSTONE only lifts the URL
// reservation so the URL is CREATABLE again — it restores NOTHING (no items, no
// evidence, no subscriptions come back). Kept here (testable) beside the load.
const TOMBSTONE_CONSEQUENCE =
	'Unblocking this tombstone lifts the URL reservation so the URL can be created again as a fresh source. Nothing is restored — no items, evidence, or subscriptions come back; a new source starts empty.'

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

// Only the SourceSummary fields this page renders, plus the two core sends
// that are read here ONLY to derive booleans (never forwarded raw, F1):
// provenance drives isInstanceMember/viaVerification; overridden is already a
// boolean on the wire. Task 4 (admin-governance-visibility) widens this on
// purpose for the first time: retention (orphan reap-reason label) and
// addedBy (first-3 subscriber handles) are now deliberately rendered, and
// subscriptionCounts is read only to turn addedBy's first-3 into a "+N" tail
// — never forwarded raw either.
interface SourceSummary {
	source: {
		id: string
		canonicalUrl: string
		attributionMode: 'single_publisher' | 'aggregate'
		operation: 'enabled' | 'paused'
		governance: 'allowed' | 'quarantined' | 'blocked'
		provenance: string
		overridden: boolean
	}
	federationStatus: 'none' | 'pending' | 'approved'
	subscriptionCounts: { active: number; pending: number; pendingReview: number }
	retention: 'verified_origin' | 'audit_history' | 'admin_retained' | 'reapable' | null
	addedBy: { handle: string; displayName: string }[]
}

// ONE membership predicate, client-side mirror of core's membership.ts
// instancePrefix (scheme+host only, via `new URL`) — http and https on one
// host do NOT group.
function instancePrefixClient(canonicalUrl: string): string | null {
	try {
		const u = new URL(canonicalUrl)
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
		return `${u.protocol}//${u.host}/`
	} catch {
		return null
	}
}

// 2026-07-28 spec-edge amendment (plan review F14): a row that is itself
// approved-federated governs itself — it is never treated as a member, even
// when another approved instance's prefix happens to cover its URL.
function isInstanceMember(row: SourceSummary, allRows: SourceSummary[]): boolean {
	if (row.source.provenance !== 'origin_verification') return false
	if (row.federationStatus === 'approved') return false
	const rowPrefix = instancePrefixClient(row.source.canonicalUrl)
	return allRows.some((inst) => inst.federationStatus === 'approved' && inst.source.id !== row.source.id && instancePrefixClient(inst.source.canonicalUrl) === rowPrefix)
}

// Not exported: SvelteKit only allows load/actions/etc. out of a +page.server.
const GROUPS = [
	{ key: 'federation', title: 'Approved federation', blurb: 'Federated with this instance. Revoking ends interoperability without changing governance or anyone’s subscriptions.' },
	{ key: 'review', title: 'Quarantine and pending federation', blurb: 'Quarantined sources keep being acquired but their deliveries stay out of ordinary timelines; pending candidates are not federated yet.' },
	{ key: 'user', title: 'Allowed user sources', blurb: 'Subscribed by users, allowed, not federated.' },
	{ key: 'blocked', title: 'Blocked sources', blurb: 'No acquisition, no eligible deliveries — still fully inspectable. Unblocking returns a source to quarantine, never straight to visibility.' }
] as const

// A verification-minted member (isInstanceMember) that would otherwise land
// in 'user' or 'review' is routed to 'member' instead — a key that matches
// none of GROUPS, so it never renders flatly. It resurfaces only via that
// instance's own ?expand= member list (Task 6). Blocked/federation are left
// alone: a member can't be 'federation' (F14 excludes approved rows from
// membership) and a cascaded-blocked member still needs to show up in the
// blocked group like every other blocked source.
type GroupKey = (typeof GROUPS)[number]['key'] | 'member'

const groupOf = (s: SourceSummary, isMember: boolean): GroupKey => {
	const base: (typeof GROUPS)[number]['key'] =
		s.source.governance === 'blocked'
			? 'blocked'
			: s.source.governance === 'quarantined' || s.federationStatus === 'pending'
				? 'review'
				: s.federationStatus === 'approved'
					? 'federation'
					: 'user'
	return isMember && (base === 'user' || base === 'review') ? 'member' : base
}

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
// F1: isInstanceMember/viaVerification are the only derived signals carried
// forward from provenance — the raw string itself never reaches this object.
// memberCounts starts undefined; the load fills it in for federation rows only.
// addedBy is passed through as-is (already capped to 3 by core); subscriberTotal
// is the raw sum used ONLY to derive the "+N" tail in the .svelte — never
// rendered itself.
const toRow = (s: SourceSummary, isMember: boolean) => ({
	id: s.source.id,
	url: s.source.canonicalUrl,
	governance: s.source.governance,
	operation: s.source.operation,
	attributionMode: s.source.attributionMode,
	federationStatus: s.federationStatus,
	// The bit is meaningful only for a currently-governed member (it protects
	// FROM a covering instance's cascades) — every pre-existing row defaults
	// to overridden=1 at the schema level (migration 19), which is noise for
	// anything that was never a cascade candidate in the first place.
	overridden: isMember && s.source.overridden,
	isInstanceMember: isMember,
	viaVerification: s.source.provenance === 'origin_verification',
	memberCounts: undefined as { members: number; overridden: number; instanceGoverned: number } | undefined,
	group: groupOf(s, isMember),
	addedBy: s.addedBy,
	subscriberTotal: s.subscriptionCounts.active + s.subscriptionCounts.pending + s.subscriptionCounts.pendingReview,
	actions: availableActions(s).map((action) => ({ action, commandId: crypto.randomUUID() }))
})

// Orphan rows (Task 4): shown in their own always-visible, independently
// paginated group. They carry `retention` (the display-oriented ladder,
// verified_origin > admin_retained > audit_history > reapable — Task 1's
// retentionFor) instead of the ordinary transition-action list. One
// commandId per row: retention alone decides, at render time, whether the
// row shows a plain Reap form or a force Reap-anyway form — never both, so
// there's nothing left to disambiguate a second id for. An orphan by
// definition has zero subscriptions (the core WHERE clause enforces it), so
// addedBy is always empty here — no point rendering it.
const toOrphanRow = (s: SourceSummary) => ({
	id: s.source.id,
	url: s.source.canonicalUrl,
	retention: s.retention,
	commandId: crypto.randomUUID()
})

async function listSources(f: typeof fetch, cursor: string | null, filter?: 'governance' | 'orphan', q?: string): Promise<{ items: SourceSummary[]; nextCursor: string | null }> {
	const qs = [cursor ? `cursor=${encodeURIComponent(cursor)}` : '', filter ? `filter=${filter}` : '', q ? `q=${encodeURIComponent(q)}` : ''].filter(Boolean).join('&')
	const res = await f(`${base()}/admin/sources${qs ? `?${qs}` : ''}`)
	if (!res.ok) throw new Error(await coreError(res, `listAdminSources ${res.status}`))
	return (await res.json()) as { items: SourceSummary[]; nextCursor: string | null }
}

// Task 5's reads, consumed here: per-instance member rows (lazy, ?expand=)
// and counts (PT10's roll-up). Non-instance/non-federated ids come back
// empty from core (F2) rather than 404 — same posture as the sibling reads.
async function listMembers(f: typeof fetch, instanceId: string): Promise<{ items: SourceSummary[]; nextCursor: string | null }> {
	const res = await f(`${base()}/admin/sources/${encodeURIComponent(instanceId)}/members`)
	if (!res.ok) throw new Error(await coreError(res, `listSourceMembers ${res.status}`))
	return (await res.json()) as { items: SourceSummary[]; nextCursor: string | null }
}

async function memberCountsFor(f: typeof fetch, instanceId: string): Promise<{ members: number; overridden: number }> {
	const res = await f(`${base()}/admin/sources/${encodeURIComponent(instanceId)}/members/counts`)
	if (!res.ok) throw new Error(await coreError(res, `sourceMemberCounts ${res.status}`))
	return (await res.json()) as { members: number; overridden: number }
}

export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	const cursor = url.searchParams.get('cursor')
	// No-JS search box (Task 4): a plain ?q= GET param, filtering only the
	// ordinary paginated list — same posture as `cursor` itself, which the
	// federation/review union below deliberately does NOT depend on either.
	const q = url.searchParams.get('q') || undefined
	// The orphan group paginates INDEPENDENTLY of the ordinary list: its own
	// query param, its own cursor, never sharing `cursor` above — a search or
	// a page-2 view of ordinary sources must not shift which orphans are shown.
	const orphanCursor = url.searchParams.get('orphanCursor')
	// The federation/review sections must not depend on WHICH page of the
	// created_at pagination is being viewed (a bulk OPML import buried three
	// approved federations behind "None." — found dogfooding 2026-07-25). The
	// governance fetch returns every federated-or-quarantined row; the page
	// fetch keeps paginating ordinary subscriptions. Union, governance first,
	// deduped by id — grouping below then sees the complete governance set on
	// every page.
	const [page, governance, orphan] = await Promise.all([
		listSources(f, cursor, undefined, q),
		listSources(f, null, 'governance'),
		listSources(f, orphanCursor, 'orphan')
	])
	const governanceIds = new Set(governance.items.map((s) => s.source.id))
	const merged = [...governance.items, ...page.items.filter((s) => !governanceIds.has(s.source.id))]
	// The governance fetch is unpaginated and always carries every approved
	// instance, so isInstanceMember's "is some OTHER row an approved instance
	// covering my prefix" check sees the whole federation set regardless of
	// which subscription page is being viewed.
	const rows = merged.map((s) => toRow(s, isInstanceMember(s, merged)))
	// PT10: the roll-up line's counts, one read per approved-federation row —
	// small and bounded (federated peers, not the whole page) so a parallel
	// fetch per row is the right size for Promise.all rather than a batch API.
	const federationRows = rows.filter((r) => r.group === 'federation')
	const counts = await Promise.all(federationRows.map((r) => memberCountsFor(f, r.id)))
	federationRows.forEach((r, i) => {
		const c = counts[i]
		r.memberCounts = { members: c.members, overridden: c.overridden, instanceGoverned: c.members - c.overridden }
	})
	// Lazy member expansion (Task 6): a plain query param, no-JS-safe — the
	// page re-renders with this one instance's member rows inlined. isMember
	// is hardcoded true: core's /members already gates to true members only
	// (F2 + the range predicate), no need to re-derive it client-side.
	const expand = url.searchParams.get('expand')
	const expandedMembers = expand ? (await listMembers(f, expand)).items.map((s) => toRow(s, true)) : []
	// V3: the reserved blocked/tombstoned URLs (unpaginated). One command id per
	// rendered unblock form — a resubmit replays the identical id (design §11).
	const tombstones = (await listTombstones(f)).map((t) => ({ ...t, commandId: crypto.randomUUID() }))
	return {
		groups: GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => r.group === g.key) })),
		expand,
		expandedMembers,
		tombstones,
		tombstoneConsequence: TOMBSTONE_CONSEQUENCE,
		categories: AUDIT_CATEGORIES,
		// The cursor that produced THIS page — echoed back so every mutating
		// form's action can carry it forward (design: no-JS pagination must
		// survive a mutation). `nextCursor` below is a different value: the
		// cursor for the page AFTER this one.
		cursor,
		nextCursor: page.nextCursor,
		// Search echo — binds the box's value and drives the "clear" link.
		q: q ?? null,
		// The orphan group: its own rows, its own cursor pair, entirely
		// independent of `cursor`/`nextCursor` above.
		orphanRows: orphan.items.map(toOrphanRow),
		orphanCursor,
		orphanNextCursor: orphan.nextCursor,
		establishCommandId: crypto.randomUUID()
	}
}

export const actions: Actions = {
	// The markup that renders these two forms always carries its own command
	// id — no capability probe needed (same carve as the following page's
	// unsubscribe).
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
	// The unblock-tombstone markup always carries its own command id — no
	// capability probe (same carve as source).
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
	},
	// Task 2's operator-override reap. `force` is read as a plain 'true' string
	// (a hidden input, never a checkbox) so a no-JS confirm form can carry it.
	// The two-step confirm (covering all three force-liftable reasons —
	// verified_origin_evidence, admin_retained, audit_history) lives entirely
	// in the .svelte: this action is agnostic to WHICH refusal reason came
	// back — it echoes sourceId/commandId/force verbatim so the page can
	// decide whether to show a plain retry or the separate force-confirm
	// form. commandId is never minted here, same reasoning as every other
	// action on this page.
	reap: async (event) => {
		const form = await event.request.formData()
		const sourceId = String(form.get('sourceId') ?? '').trim()
		const commandId = String(form.get('commandId') ?? '').trim()
		const force = form.get('force') === 'true'
		if (!sourceId) return fail(400, { error: 'sourceId is required' })
		if (!commandId) return fail(400, { error: 'commandId is required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			const res = await f(`${base()}/admin/sources/${encodeURIComponent(sourceId)}/reap`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ commandId, ...(force ? { force: true } : {}) })
			})
			// sourceId/commandId/force echoed so the re-rendered page can pin this
			// exact form's hidden commandId to the one just submitted, and tell
			// the plain form from the force-confirm form apart.
			if (!res.ok) return fail(400, { error: await coreError(res, `reap failed`), sourceId, commandId, force })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'reap failed', sourceId, commandId, force })
		}
		return { reaped: true }
	},
	// Bulk governance transitions across N rows in one submit. Reuses each
	// row's OWN already-minted commandId (from toRow's actions[], the exact
	// same id a lone submit of that row would use) — no new idempotency
	// scheme, no batch-wide id. attribution-mode is excluded: it's the one
	// action needing a per-row-meaningful extra field (the new mode) that
	// doesn't generalize to "the same value for every selected row" without
	// design this spec never scoped.
	bulkSource: async (event) => {
		const form = await event.request.formData()
		const action = String(form.get('action') ?? '')
		// Each candidate is "sourceId:action:commandId" — one per (checked row ×
		// action that row actually offers), so ONE form can hold several
		// actions' worth of candidates and the clicked `action` picks which
		// apply. Reuses each row's own already-minted commandId (from toRow's
		// actions[]), so the id is the exact one a lone submit would have used.
		const candidates = form.getAll('candidate').map((c) => String(c).split(':'))
		if (!ACTIONS.includes(action as SourceAction) || action === 'attribution-mode') return fail(400, { error: 'unknown or unsupported bulk action' })
		if (candidates.some((c) => c.length !== 3 || c.some((part) => !part))) return fail(400, { error: 'malformed candidate' })
		const picked = candidates.filter(([, candidateAction]) => candidateAction === action)
		if (picked.length === 0) return { bulkResults: [], bulkAction: action }
		const category = String(form.get('category') ?? '').trim()
		const note = String(form.get('note') ?? '').trim()
		if (!category && !CATEGORY_OPTIONAL.has(action)) return fail(400, { error: 'a moderation category is required' })
		const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
		const bulkResults = await Promise.all(
			picked.map(async ([sourceId, , commandId]) => {
				try {
					const res = await f(`${base()}/admin/sources/${encodeURIComponent(sourceId)}/${action}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ commandId, ...(category ? { category } : {}), ...(note ? { note } : {}) })
					})
					if (!res.ok) return { sourceId, ok: false, error: await coreError(res, `${action} failed`) }
					return { sourceId, ok: true }
				} catch (err) {
					return { sourceId, ok: false, error: err instanceof Error ? err.message : `${action} failed` }
				}
			})
		)
		return { bulkResults, bulkAction: action }
	}
}
