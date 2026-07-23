import type { PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { getTimeline, getPeers, getFollowing, createPost, subscribeToFeed, deletePost, getCapabilities, subscribeToSource } from '$lib/api'
import type { PublicFollowingEntry } from '$lib/types'
import { enrichEntries } from '$lib/server/render'
import { authedFetch, cookieHeader, ensureSessionFetch } from '$lib/server/session'
import { TABS, resolveTab, tabFilter } from '$lib/tabs'

export const load: PageServerLoad = async ({ fetch, url, parent }) => {
	const before = url.searchParams.get('before') ?? undefined
	// Post-redirect success flash for add-remote (same SSR pattern as login's ?reset=1).
	const addedFeed = url.searchParams.get('feed') ?? undefined
	// Post-subscribe flash for the v2 path, which has no handle to name. Two
	// known values only — never echo a raw query value.
	const sub = url.searchParams.get('sub')
	const subscribed = sub === 'added' || sub === 'pending' ? sub : undefined
	const isFirstPage = !before
	const { me } = await parent()
	const tab = resolveTab(url.searchParams.get('tab'), me)
	try {
		// followIds feed the live lens only, and LiveTimeline mounts on the first page only.
		const timelineP = getTimeline(fetch, { before, topLevel: true, ...tabFilter(tab, me?.user.handle) })
		const followingP = tab === 'personal' && isFirstPage && me ? getFollowing(fetch, me.user.handle) : Promise.resolve(null)
		// The capability rides ALONGSIDE the legacy calls, never ahead of them:
		// getCapabilities never rejects, so a core without /capabilities simply
		// leaves the already-in-flight legacy result standing — it can never
		// turn a working page into coreDown.
		const capP = getCapabilities(fetch)
		const [{ timeline, nextCursor }, following, cap] = await Promise.all([timelineP, followingP, capP])
		// Widget data, never load-bearing: a peers failure must not down the page.
		const peers = await getPeers(fetch).catch(() => [])
		// Self first (the river includes its owner); vestigial instance follows never reach the lens.
		// ponytail: under v2 a source follow carries no local user id, so the lens
		// tracks local follows only — V2's logical-item ordinary reads supersede this.
		const followIds =
			following && me
				? [
						me.user.id,
						...(cap.sourceModelV2
							? (following as unknown as PublicFollowingEntry[]).filter((e) => e.kind === 'local').map((e) => e.id)
							: following.filter((u) => u.feedType !== 'instance').map((u) => u.id))
					]
				: undefined
		return {
			timeline: enrichEntries(timeline),
			nextCursor,
			isFirstPage,
			peers,
			addedFeed,
			subscribed,
			tab,
			followIds,
			sourceModelV2: cap.sourceModelV2 || undefined,
			// One id per rendered form: resubmitting THIS form (no-JS retry) replays
			// the same command server-side instead of mutating twice.
			subscribeCommandId: cap.sourceModelV2 ? crypto.randomUUID() : undefined
		}
	} catch {
		return { timeline: [], nextCursor: null, isFirstPage, coreDown: true, peers: [], addedFeed, tab }
	}
}

// Named-action URLs replace the query string, so forms carry ?tab=<tab>&/action
// (SvelteKit takes the first param starting with '/'). Echo only known tabs.
const tabHome = (url: URL): string => {
	const raw = url.searchParams.get('tab')
	return raw && (TABS as readonly string[]).includes(raw) ? `/?tab=${raw}` : '/'
}

export const actions = {
	compose: async (event) => {
		const form = await event.request.formData()
		const content = String(form.get('content') ?? '').trim()
		if (!content) return fail(400, { error: 'content is required' })
		try {
			const f = await ensureSessionFetch(event)
			await createPost(f, { content })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'createPost failed' })
		}
		throw redirect(303, tabHome(event.url))
	},
	subscribe: async (event) => {
		const form = await event.request.formData()
		const url = String(form.get('url') ?? '').trim()
		if (!url) return fail(400, { error: 'url is required' })
		// A failed probe lands here as `false` — legacy, exactly like the flag off.
		if ((await getCapabilities(event.fetch)).sourceModelV2) {
			// ponytail: a form rendered before the flag flipped carries no command
			// id; mint one so the submit still works (it only loses retry idempotency).
			const commandId = String(form.get('commandId') ?? '') || crypto.randomUUID()
			let outcome
			try {
				const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
				outcome = await subscribeToSource(f, { url, commandId })
			} catch (err) {
				return fail(400, { error: err instanceof Error ? err.message : 'subscribe failed' })
			}
			if (outcome.kind === 'local') throw redirect(303, outcome.created ? `/?tab=personal&feed=${encodeURIComponent(outcome.handle)}` : '/?tab=personal')
			throw redirect(303, outcome.kind === 'pending' ? '/?tab=personal&sub=pending' : '/?tab=personal&sub=added')
		}
		const type = String(form.get('type') ?? '')
		if (type !== 'person' && type !== 'webfeed') return fail(400, { error: 'type invalid' })
		let result
		try {
			// no mint: subscribing is registered-only; a sessionless POST gets core's 401/403
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			result = await subscribeToFeed(f, { url, type })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'subscribe failed' })
		}
		// Landing tab = where the outcome is visible (deliberate exception to tabHome):
		// followed → personal (+flash); instance → federated; own feed → personal. No flash unless followed.
		if (result.followed) throw redirect(303, `/?tab=personal&feed=${encodeURIComponent(result.user.handle)}`)
		throw redirect(303, result.user.kind === 'local' ? '/?tab=personal' : '/?tab=federated')
	},
	deletePost: async (event) => {
		const form = await event.request.formData()
		const id = String(form.get('id') ?? '').trim()
		if (!id) return fail(400, { error: 'id required' })
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await deletePost(f, id)
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'remove failed' })
		}
		return { removed: true }
	}
} satisfies import('./$types').Actions
