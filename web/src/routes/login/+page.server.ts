import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { cookieHeader, relaySetCookies } from '$lib/server/session'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export const load: PageServerLoad = async ({ url }) => {
	return { resetDone: url.searchParams.get('reset') === '1' }
}

export const actions = {
	login: async ({ request, fetch, cookies, url }) => {
		const form = await request.formData()
		const email = String(form.get('email') ?? '').trim()
		const password = String(form.get('password') ?? '')
		if (!email || !password) return fail(400, { error: 'email and password are required' })
		const cookie = cookieHeader(cookies)
		const res = await fetch(`${base()}/api/auth/sign-in/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: url.origin, ...(cookie ? { cookie } : {}) },
			body: JSON.stringify({ email, password })
		})
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { message?: string }
			return fail(res.status === 401 ? 401 : 400, { error: body.message ?? 'login failed' })
		}
		relaySetCookies(cookies, res)
		throw redirect(303, '/')
	},
	magic: async ({ request, fetch, cookies, url }) => {
		const form = await request.formData()
		const email = String(form.get('email') ?? '').trim()
		if (!email) return fail(400, { error: 'email is required' })
		const cookie = cookieHeader(cookies)
		const res = await fetch(`${base()}/api/auth/sign-in/magic-link`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: url.origin, ...(cookie ? { cookie } : {}) },
			body: JSON.stringify({ email })
		})
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { message?: string }
			return fail(res.status === 503 ? 503 : 400, { error: body.message ?? 'could not send login link' })
		}
		relaySetCookies(cookies, res)
		return { magicSent: true }
	},
	logout: async ({ fetch, cookies, url }) => {
		const cookie = cookieHeader(cookies)
		if (cookie) {
			// better-auth's sign-out 415s without a JSON content-type and 400s
			// without a body — an empty object satisfies it (verified against
			// the running core, not from the endpoint's docs).
			const res = await fetch(`${base()}/api/auth/sign-out`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: url.origin, cookie },
				body: '{}'
			})
			relaySetCookies(cookies, res)
		}
		throw redirect(303, '/')
	}
} satisfies Actions
