import type { PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { getPeers, createPost, deletePost, subscribeToSource } from '$lib/api'
import { getLogicalTimeline, type V2Lens } from '$lib/logical-api'
import { enrichEntries } from '$lib/server/render'
import { authedFetch, cookieHeader, ensureSessionFetch } from '$lib/server/session'
import { TABS, resolveTab, type Tab } from '$lib/tabs'

// The lens for a home tab (spec §3.5).
const tabLens = (tab: Tab, meHandle: string | undefined): V2Lens => {
	if (tab === 'local') return { origin: 'local' }
	if (tab === 'federated') return { federated: true }
	if (tab === 'personal') return meHandle ? { followedBy: meHandle } : {}
	return {}
}

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
		// The PRIMARY home river validates + maps the logical envelope. A malformed
		// envelope FAILS CLOSED (spec §5.6 carve 2) by throwing LogicalContractError,
		// which the catch below turns into coreDown — the same "can't load this page"
		// notice a core outage shows. It is NEVER rendered as an empty river (that
		// would present a validation failure as "no posts").
		// journalCursor is the snapshot cursor the live stream reconnects from; the
		// client opens /stream?last=<journalCursor> so Core serves from here instead
		// of forcing a reset (an empty cursor would loop reset↔refetch).
		const { entries: timeline, nextCursor, journalCursor } = await getLogicalTimeline(fetch, { before, ...tabLens(tab, me?.user.handle) })
		// Widget data, never load-bearing: a peers failure must not down the page.
		const peers = await getPeers(fetch).catch(() => [])
		return {
			timeline: enrichEntries(timeline),
			nextCursor,
			isFirstPage,
			peers,
			addedFeed,
			subscribed,
			tab,
			journalCursor,
			// One id per rendered form: resubmitting THIS form (no-JS retry) replays
			// the same command server-side instead of mutating twice.
			subscribeCommandId: crypto.randomUUID()
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
		// ponytail: a stale rendered form may carry no command id; mint one so the
		// submit still works (it only loses retry idempotency).
		const commandId = String(form.get('commandId') ?? '') || crypto.randomUUID()
		let outcome
		try {
			// no mint: subscribing is registered-only; a sessionless POST gets core's 401/403
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			outcome = await subscribeToSource(f, { url, commandId })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'subscribe failed' })
		}
		// Landing tab = where the outcome is visible (deliberate exception to tabHome).
		if (outcome.kind === 'local') throw redirect(303, outcome.created ? `/?tab=personal&feed=${encodeURIComponent(outcome.handle)}` : '/?tab=personal')
		throw redirect(303, outcome.kind === 'pending' ? '/?tab=personal&sub=pending' : '/?tab=personal&sub=added')
	},
	deletePost: async (event) => {
		const form = await event.request.formData()
		const id = String(form.get('id') ?? '').trim()
		if (!id) return fail(400, { error: 'id required' })
		// asAdmin picks which core endpoint to call; core independently re-checks
		// ownership/admin-ness on both, so this is a routing hint, not a trust boundary.
		const asAdmin = form.get('asAdmin') === '1'
		try {
			const f = authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
			await deletePost(f, id, { asAdmin })
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'remove failed' })
		}
		return { removed: true }
	}
} satisfies import('./$types').Actions
