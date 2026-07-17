import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { cookieHeader, relaySetCookies } from '$lib/server/session'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export const load: PageServerLoad = async ({ url }) => {
	return { token: url.searchParams.get('token') ?? '' }
}

export const actions = {
	reset: async ({ request, fetch, cookies, url }) => {
		const form = await request.formData()
		const token = String(form.get('token') ?? '')
		const newPassword = String(form.get('newPassword') ?? '')
		if (!token || newPassword.length < 8) return fail(400, { error: 'a valid link and a password of at least 8 characters are required' })
		const cookie = cookieHeader(cookies)
		const res = await fetch(`${base()}/api/auth/reset-password`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: url.origin, ...(cookie ? { cookie } : {}) },
			body: JSON.stringify({ newPassword, token })
		})
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { message?: string }
			return fail(400, { error: body.message ?? 'reset failed — the link may be invalid or expired' })
		}
		relaySetCookies(cookies, res)
		throw redirect(303, '/login?reset=1')
	}
} satisfies Actions
