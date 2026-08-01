import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { listApiKeys, createApiKey, revokeApiKey, type ApiKeySummary } from '$lib/api'
import { authedFetch, cookieHeader, hasSession } from '$lib/server/session'
import { PERMISSION_OPTIONS } from './permissions.ts'

// Explicit OutputData (not the bare `PageServerLoad`), same reasoning as
// accounts/+page.server.ts: the default generic's OutputDataShape wraps the
// return in `T | void`, which the test's direct `out.keys` access can't see
// through.
export const load: PageServerLoad<{ keys: ApiKeySummary[] }> = async ({ fetch, cookies, url }) => {
	if (!hasSession(cookies)) throw redirect(303, '/')
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	const keys = await listApiKeys(f)
	return { keys }
}

export const actions = {
	create: async ({ request, fetch, cookies, url }) => {
		const form = await request.formData()
		const name = String(form.get('name') ?? '').trim()
		if (!name) return fail(400, { error: 'name is required' })
		// Each resource in PERMISSION_OPTIONS appears at most once today, so
		// no accumulation is needed — [opt.action] is the whole array.
		const permissions: Record<string, string[]> = {}
		for (const opt of PERMISSION_OPTIONS) {
			if (form.get(opt.formKey)) permissions[opt.resource] = [opt.action]
		}
		if (Object.keys(permissions).length === 0) return fail(400, { error: 'select at least one permission' })
		const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
		try {
			const created = await createApiKey(f, { name, permissions })
			// The plaintext key lives only in this action's returned `form` —
			// never in `data` / the load return — so a page refresh can't re-show
			// it (brief's Step 2/4 requirement).
			return { createdKey: created.key, createdName: created.name, createdPrefix: created.prefix }
		} catch (err) {
			return fail(500, { error: err instanceof Error ? err.message : 'could not create key' })
		}
	},

	revoke: async ({ request, fetch, cookies, url }) => {
		const form = await request.formData()
		const id = String(form.get('id') ?? '')
		if (!id) return fail(400, { error: 'missing key id' })
		const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
		try {
			await revokeApiKey(f, id)
		} catch (err) {
			return fail(500, { error: err instanceof Error ? err.message : 'could not revoke key' })
		}
		throw redirect(303, '/settings/api-keys')
	}
} satisfies Actions
