import type { Actions } from './$types'
import { base } from '$lib/server/session'

export const actions = {
	forgot: async ({ request, fetch, url, getClientAddress }) => {
		const form = await request.formData()
		const email = String(form.get('email') ?? '').trim()
		if (email) {
			await fetch(`${base()}/api/auth/request-password-reset`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: url.origin, 'x-forwarded-for': getClientAddress() },
				body: JSON.stringify({ email, redirectTo: `${url.origin}/reset` })
			}).catch(() => {})
		}
		// No account enumeration: the same neutral message whether the email
		// exists, mail is unconfigured (core 503s), or the request errors.
		return { sent: true }
	}
} satisfies Actions
