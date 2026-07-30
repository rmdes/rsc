import { error } from '@sveltejs/kit'
import { loadSourceDetail, refreshAction, purgeAction } from '$lib/server/source-detail'
import type { Actions, PageServerLoad } from './$types'

// The admin acquisition console for one source (spec §6.2-6.3): a manual
// refresh action + a status panel (governance, latest run, nonterminal count).
// It exposes NO evidence-review navigation (deliveries, conflicts, findings,
// previews) — that is Vertical 3. The load itself is shared (Task 9) with the
// ?detail= inline panel on /admin/feeds — see $lib/server/source-detail.ts.

export const load: PageServerLoad = async ({ fetch, params, url, cookies }) => {
	const detail = await loadSourceDetail(fetch, url.origin, cookies, params.sourceId, url.searchParams.get('before'))
	if (!detail) throw error(404, 'Not found')
	return detail
}

// Both handlers live in $lib/server/source-detail.ts beside the load they act
// on — the inline ?detail= panel on /admin/feeds mounts the SAME two functions,
// so there is one implementation, not two hand-synced copies.
export const actions: Actions = { refresh: refreshAction, purge: purgeAction }
