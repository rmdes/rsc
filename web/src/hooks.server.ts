import type { Handle } from '@sveltejs/kit'
import { error } from '@sveltejs/kit'
import { getMe } from '$lib/api'
import { authedFetch, cookieHeader } from '$lib/server/session'

// One gate for the whole admin surface, mirroring core's own reasoning for
// its app.use('/admin/*', authed, requireAdmin()) wildcard (core/src/api/
// app.ts): a route can't ship ungated by forgetting to add a check, because
// there is nothing per-route to forget. Scoped to non-GET/HEAD only —
// GET navigation under /admin/* is already covered by admin/
// +layout.server.ts's own isAdmin check with no redundant round-trip;
// this hook exists specifically because SvelteKit runs form actions
// BEFORE any layout load(), so that check alone does not cover actions.
// Not currently exploitable either way (core's own /admin/* session gate
// is the real, load-bearing boundary and already holds) — this is
// defense-in-depth against a future refactor silently relying on the
// SvelteKit-layer check alone.
export const handle: Handle = async ({ event, resolve }) => {
	const isAdminPath = event.url.pathname === '/admin' || event.url.pathname.startsWith('/admin/')
	const isMutating = event.request.method !== 'GET' && event.request.method !== 'HEAD'
	if (isAdminPath && isMutating) {
		const me = await getMe(authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies)))
		if (!me?.isAdmin) throw error(404, 'Not found')
	}
	return resolve(event)
}
