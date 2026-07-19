import type { PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { getTimeline, getPeers, getFollowing, createPost, addRemoteUser, deletePost } from '$lib/api'
import { enrichEntries } from '$lib/server/render'
import { authedFetch, cookieHeader, ensureSessionFetch } from '$lib/server/session'
import { TABS, resolveTab, tabFilter } from '$lib/tabs'

export const load: PageServerLoad = async ({ fetch, url, parent }) => {
	const before = url.searchParams.get('before') ?? undefined
	// Post-redirect success flash for add-remote (same SSR pattern as login's ?reset=1).
	const addedFeed = url.searchParams.get('feed') ?? undefined
	const isFirstPage = !before
	const { me } = await parent()
	const tab = resolveTab(url.searchParams.get('tab'), me)
	try {
		// followIds feed the live lens only, and LiveTimeline mounts on the first page only.
		const timelineP = getTimeline(fetch, { before, ...tabFilter(tab, me?.user.handle) })
		const followingP = tab === 'personal' && isFirstPage && me ? getFollowing(fetch, me.user.handle) : Promise.resolve(null)
		const [{ timeline, nextCursor }, following] = await Promise.all([timelineP, followingP])
		// Widget data, never load-bearing: a peers failure must not down the page.
		const peers = await getPeers(fetch).catch(() => [])
		// Self first (the river includes its owner); vestigial instance follows never reach the lens.
		const followIds = following && me ? [me.user.id, ...following.filter((u) => u.feedType !== 'instance').map((u) => u.id)] : undefined
		return { timeline: enrichEntries(timeline), nextCursor, isFirstPage, peers, addedFeed, tab, followIds }
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
	addRemote: async (event) => {
		const form = await event.request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		const displayName = String(form.get('displayName') ?? '').trim() || handle
		const feedUrl = String(form.get('feedUrl') ?? '').trim()
		if (!handle || !feedUrl) return fail(400, { error: 'handle and feedUrl are required' })
		try {
			// no mint: adding feeds is registered-only; a sessionless POST gets core's 401/403
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await addRemoteUser(f, { handle, displayName, feedUrl })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'addRemoteUser failed' })
		}
		throw redirect(303, `/?tab=public&feed=${encodeURIComponent(handle)}`)
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
