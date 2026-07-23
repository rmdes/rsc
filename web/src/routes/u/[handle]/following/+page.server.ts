import type { PageServerLoad, Actions } from './$types'
import { fail } from '@sveltejs/kit'
import { getTimeline, getFollowing, addFollow, removeFollow, importOpml, getCapabilities, peekCapabilities, getOwnerFollowing, unsubscribeSource, importOpmlV2 } from '$lib/api'
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
		// The v1 river call rides ALONGSIDE capability (cold pod: it fires first, so
		// a capability fetch failure never runs ahead of the legacy path); the
		// follows list is fetched in parallel. A v2 core answers the same /timeline
		// with the `followed_by` lens.
		const known = peekCapabilities()
		const v1TP = known?.sourceModelV2 ? null : getTimeline(fetch, { before, followedBy: handle, topLevel: true })
		const followingP = getFollowing(fetch, handle)
		const cap = await getCapabilities(fetch)
		let timeline, nextCursor
		if (cap.sourceModelV2) {
			v1TP?.catch(() => {})
			;({ entries: timeline, nextCursor } = await getLogicalRiverOrEmpty(fetch, { before, followedBy: handle }))
		} else {
			;({ timeline, nextCursor } = await v1TP!)
		}
		const following = await followingP
		const page = { handle, isOwner, timeline: enrichEntries(timeline), nextCursor, isFirstPage }
		if (cap.sourceModelV2) {
			// Under v2 core serves /users/:handle/follows with the public projection
			// — same path, same in-flight call, different shape.
			const rows = isOwner
				? ownerRows(await getOwnerFollowing(authedFetch(fetch, url.origin, cookieHeader(cookies))))
				: publicRows(following as unknown as PublicFollowingEntry[])
			return {
				...page,
				following: [],
				rows,
				// ponytail: a v2 source carries no local user id, so the live lens
				// tracks local follows only while the flag is on — V2's logical-item
				// ordinary reads supersede this.
				followIds: rows.flatMap((r) => (r.kind === 'local' ? [r.id] : [])),
				sourceModelV2: true,
				commandIds: { subscribe: crypto.randomUUID(), import: crypto.randomUUID() }
			}
		}
		return { ...page, following, followIds: following.filter((u) => u.feedType !== 'instance').map((u) => u.id) }
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
		// ponytail: the rendered form's command id IS the capability answer here —
		// the loader already resolved it, and probing again would put a second round
		// trip in front of every upload. A legacy form carries none and stays legacy.
		// Ceiling: a page cached across a flag flip posts the wrong shape once and
		// gets core's 400; reload recovers. Probe here if the flag ever flips in prod.
		const commandId = String(form.get('commandId') ?? '')
		try {
			// no mint: OPML import is registered-only; a sessionless POST gets core's 401/403
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			const opml = await file.text()
			const result = commandId ? await importOpmlV2(f, opml, commandId) : await importOpml(f, opml)
			return { ok: true, result }
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'import failed' })
		}
	}
} satisfies Actions
