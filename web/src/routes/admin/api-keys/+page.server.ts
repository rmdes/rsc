import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { listAdminApiKeys, createAdminApiKey, revokeApiKey, type ApiKeySummary } from '$lib/api'
import { authedFetch, cookieHeader } from '$lib/server/session'
import { PERMISSION_OPTIONS } from './permissions.ts'

// SvelteKit runs form actions BEFORE any layout load() (including this
// route's own admin/+layout.server.ts isAdmin check) — so, contrary to an
// earlier version of this comment, the layout gate alone does NOT protect
// these actions. `create` and `revoke` are protected by different
// mechanisms, not one shared gate:
// - create POSTs to /admin/api-keys, so it's covered by core's
//   `app.use('/admin/*', authed, requireAdmin())` (core/src/api/app.ts) PLUS
//   web/src/hooks.server.ts's `handle`, which closes the SvelteKit-layer gap
//   above for non-GET requests.
// - revoke POSTs to /api/auth/api-key/delete — a different Hono mount the
//   /admin/* wildcard never touches. Its real protection is better-auth's
//   own per-key ownership check (@better-auth/api-key: apiKey.referenceId
//   !== session.user.id → 404) — admin status is irrelevant there; any
//   registered user can only ever revoke their own keys.
// Matches the same honest split settings/api-keys/+page.server.ts documents
// for its own guard() (SvelteKit-layer = UX/defense-in-depth, core = the
// real security boundary).

// Same split as settings/api-keys/+page.server.ts's toActionFail — a clean
// core rejection keeps its own status; a 401 means the browser's whole
// session died between page load and submit (redirect, not fail() — there's
// no form to re-render); anything else is a genuine server error.
// createAdminApiKey/revokeApiKey (lib/api.ts) attach the real status to the
// thrown error for this to read.
function toActionFail(err: unknown, passthrough: number[], fallback: string) {
	const status = err instanceof Error ? (err as { status?: unknown }).status : undefined
	if (status === 401) throw redirect(303, '/')
	const code = typeof status === 'number' && passthrough.includes(status) ? status : 500
	return fail(code, { error: err instanceof Error ? err.message : fallback })
}

// Explicit OutputData, same reasoning as settings/api-keys/+page.server.ts:
// the default generic's OutputDataShape wraps the return in `T | void`,
// which a test's direct `out.keys` access can't see through.
export const load: PageServerLoad<{ keys: ApiKeySummary[] }> = async ({ fetch, cookies, url }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	const keys = await listAdminApiKeys(f)
	return { keys }
}

export const actions = {
	create: async ({ request, fetch, cookies, url }) => {
		const form = await request.formData()
		const name = String(form.get('name') ?? '').trim()
		if (!name) return fail(400, { error: 'name is required' })
		const permissions: Record<string, string[]> = {}
		for (const opt of PERMISSION_OPTIONS) {
			if (form.get(opt.formKey)) {
				permissions[opt.resource] = [...(permissions[opt.resource] ?? []), opt.action]
			}
		}
		if (Object.keys(permissions).length === 0) return fail(400, { error: 'select at least one permission' })
		const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
		try {
			const created = await createAdminApiKey(f, { name, permissions })
			// The plaintext key lives only in this action's returned `form` —
			// never in `data` / the load return — so a page refresh can't re-show
			// it, same as settings/api-keys.
			return { createdKey: created.key, createdName: created.name }
		} catch (err) {
			return toActionFail(err, [400, 403], 'could not create key')
		}
	},

	revoke: async ({ request, fetch, cookies, url }) => {
		const form = await request.formData()
		const id = String(form.get('id') ?? '')
		if (!id) return fail(400, { error: 'missing key id' })
		const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
		try {
			// configId:'admin' is required — revokeApiKey's default ('user') would
			// 404 an admin-tier key (see the comment on revokeApiKey in lib/api.ts).
			await revokeApiKey(f, id, 'admin')
		} catch (err) {
			// 404 (already-revoked/nonexistent key id) is a benign no-op from the
			// admin's perspective, not a server error — same split as `create`.
			return toActionFail(err, [404], 'could not revoke key')
		}
		throw redirect(303, '/admin/api-keys')
	}
} satisfies Actions
