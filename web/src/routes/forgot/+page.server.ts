import type { Actions } from './$types'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export const actions = {
	forgot: async ({ request, fetch, url }) => {
		const form = await request.formData()
		const email = String(form.get('email') ?? '').trim()
		if (email) {
			await fetch(`${base()}/api/auth/request-password-reset`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: url.origin },
				body: JSON.stringify({ email, redirectTo: `${url.origin}/reset` })
			}).catch(() => {})
		}
		// No account enumeration: the same neutral message whether the email
		// exists, mail is unconfigured (core 503s), or the request errors.
		return { sent: true }
	}
} satisfies Actions
