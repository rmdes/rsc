import type { PageServerLoad, Actions } from './$types'
import { fail } from '@sveltejs/kit'
import { getFollowing, addFollow, removeFollow, getOwnerFollowing, unsubscribeSource, importOpmlV2 } from '$lib/api'
import { getLogicalRiverOrEmpty } from '$lib/logical-api'
import type { FollowRow, OwnerFollowingView, PublicFollowingEntry } from '$lib/types'
import { enrichEntries } from '$lib/server/render'
import { authedFetch, cookieHeader, ensureSessionFetch } from '$lib/server/session'

// The owner's own projection: the only one that can carry a pending source.
// One command id per rendered unsubscribe form, so a no-JS retry replays it.
const ownerRows = (v: OwnerFollowingView): FollowRow[] => [
	...v.localFollows.map((l) => ({ kind: 'local' as const, id: l.id, handle: l.handle, displayName: l.displayName })),
	...v.sourceSubscriptions.map((s) => ({
		kind: 'source' as const,
		sourceId: s.sourceId,
		url: s.url,
		label: s.url,
		pending: s.subscriptionState !== 'active',
		commandId: crypto.randomUUID()
	}))
]

// What a visitor sees: core filters this projection to active + allowed, so a
// pending source is unreachable here, not merely hidden.
const publicRows = (entries: PublicFollowingEntry[]): FollowRow[] =>
	entries.map((e) =>
		e.kind === 'local'
			? { kind: 'local', id: e.id, handle: e.handle, displayName: e.displayName }
			: { kind: 'source', sourceId: e.sourceId, url: e.url, label: e.displayName || e.url, pending: false, commandId: '' }
	)

export const load: PageServerLoad = async ({ fetch, params, url, parent, cookies }) => {
	const handle = params.handle.toLowerCase() // handles are stored lowercase; a mixed-case URL must not demote the owner to visitor mode
	const before = url.searchParams.get('before') ?? undefined
	const isFirstPage = !before
	const { me } = await parent()
	const isOwner = me?.user.handle === handle
	try {
		// The follows list is fetched in parallel with the river.
		const followingP = getFollowing(fetch, handle)
		// Cold-pod hazard: a throw in the awaits below leaves this rejection
		// unhandled and kills the process (see the home load).
		followingP.catch(() => {})
		const { entries: timeline, nextCursor } = await getLogicalRiverOrEmpty(fetch, { before, followedBy: handle })
		const following = await followingP
		const page = { handle, isOwner, timeline: enrichEntries(timeline), nextCursor, isFirstPage }
		// Core serves /users/:handle/follows with the public projection — same
		// path, same in-flight call, different shape depending on ownership.
		const rows = isOwner
			? ownerRows(await getOwnerFollowing(authedFetch(fetch, url.origin, cookieHeader(cookies))))
			: publicRows(following as unknown as PublicFollowingEntry[])
		return {
			...page,
			following: [],
			rows,
			// ponytail: a v2 source carries no local user id, so the live lens
			// tracks local follows only — V2's logical-item ordinary reads
			// supersede this.
			followIds: rows.flatMap((r) => (r.kind === 'local' ? [r.id] : [])),
			commandIds: { subscribe: crypto.randomUUID(), import: crypto.randomUUID() }
		}
	} catch {
		return { handle, isOwner, timeline: [], nextCursor: null, isFirstPage, following: [], followIds: [], coreDown: true }
	}
}

export const actions = {
	follow: async (event) => {
		const target = String((await event.request.formData()).get('target') ?? '').trim().toLowerCase()
		if (!target) return fail(400, { error: 'target handle is required' })
		try {
			const f = await ensureSessionFetch(event)
			await addFollow(f, target)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'follow failed' })
		}
		return { ok: true }
	},
	unfollow: async (event) => {
		const target = String((await event.request.formData()).get('target') ?? '').trim().toLowerCase()
		try {
			const f = await ensureSessionFetch(event)
			await removeFollow(f, target)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'unfollow failed' })
		}
		return { ok: true }
	},
	// v2-only: the markup that renders this form exists only while the flag is
	// on, and it always carries its own command id — no capability probe needed.
	unsubscribe: async (event) => {
		const form = await event.request.formData()
		const sourceId = String(form.get('sourceId') ?? '').trim()
		if (!sourceId) return fail(400, { error: 'sourceId is required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await unsubscribeSource(f, sourceId, String(form.get('commandId') ?? '') || crypto.randomUUID())
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'unsubscribe failed' })
		}
		return { ok: true }
	},
	import: async (event) => {
		const form = await event.request.formData()
		const file = form.get('opml')
		if (!(file instanceof File)) return fail(400, { error: 'choose an OPML file' })
		try {
			// no mint: OPML import is registered-only; a sessionless POST gets core's 401/403
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			const opml = await file.text()
			// The load's coreDown catch can drop `commandIds` from the rendered form
			// (a core blip mid-load); mint one here (mirrors unsubscribe above) when
			// the form carries none.
			const result = await importOpmlV2(f, opml, String(form.get('commandId') ?? '') || crypto.randomUUID())
			return { ok: true, result }
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'import failed' })
		}
	}
} satisfies Actions
