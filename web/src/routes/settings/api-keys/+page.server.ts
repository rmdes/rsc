import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { listApiKeys, createApiKey, revokeApiKey, type ApiKeySummary } from '$lib/api'
import { authedFetch, cookieHeader, hasSession } from '$lib/server/session'
import { PERMISSION_OPTIONS } from './permissions.ts'

// Registered-only (spec: self-serve keys are for any REGISTERED user) —
// hasSession alone can't tell: an anonymous guest's session sets the same
// cookie. Mirrors accounts/+page.server.ts's guard() exactly, reusing the
// parent layout's already-fetched /me (isAnonymous) rather than adding new
// session-reading plumbing. Core's own 403 on POST /me/api-keys is the real
// boundary; this is only so a guest never sees the create form.
function guard(me: { isAnonymous?: boolean } | null): asserts me is { isAnonymous?: boolean } {
	if (!me || me.isAnonymous) throw redirect(303, '/')
}

// Shared by both actions below (final review Finding 4 — the create action's
// fix round already made this split for `create`; `revoke` got the same
// blanket-500 treatment `create` had before that round, the identical defect
// class left on the sibling action). A clean core rejection in `passthrough`
// keeps its own status; a 401 means the session expired between page load
// and submit (redirect matches this file's own load()/guard() precedent, not
// a fail() — there's no form to re-render for an expired session); anything
// else is a genuine server error. createApiKey/revokeApiKey (lib/api.ts)
// attach the real status to the thrown error for this to read.
function toActionFail(err: unknown, passthrough: number[], fallback: string) {
	const status = err instanceof Error ? (err as { status?: unknown }).status : undefined
	if (status === 401) throw redirect(303, '/')
	const code = typeof status === 'number' && passthrough.includes(status) ? status : 500
	return fail(code, { error: err instanceof Error ? err.message : fallback })
}

// Explicit OutputData (not the bare `PageServerLoad`), same reasoning as
// accounts/+page.server.ts: the default generic's OutputDataShape wraps the
// return in `T | void`, which the test's direct `out.keys` access can't see
// through.
export const load: PageServerLoad<{ keys: ApiKeySummary[] }> = async ({ fetch, cookies, url, parent }) => {
	if (!hasSession(cookies)) throw redirect(303, '/')
	const { me } = await parent()
	guard(me)
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	const keys = await listApiKeys(f)
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
			const created = await createApiKey(f, { name, permissions })
			// The plaintext key lives only in this action's returned `form` —
			// never in `data` / the load return — so a page refresh can't re-show
			// it (brief's Step 2/4 requirement).
			return { createdKey: created.key, createdName: created.name }
		} catch (err) {
			// A clean core rejection (bad name, guest session, or an expired
			// session) is handled by the shared helper; anything else is a
			// genuine server error. createApiKey (lib/api.ts) attaches the real
			// status to the thrown error.
			return toActionFail(err, [400, 403], 'could not create key')
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
			// 404 (already-revoked/nonexistent key id) is a benign no-op from the
			// user's perspective, not a server error — same split as `create`.
			return toActionFail(err, [404], 'could not revoke key')
		}
		throw redirect(303, '/settings/api-keys')
	}
} satisfies Actions
