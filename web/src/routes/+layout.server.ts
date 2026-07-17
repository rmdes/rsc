import type { LayoutServerLoad } from './$types'
import { getMe } from '$lib/api'
import { authedFetch, cookieHeader, hasSession } from '$lib/server/session'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

// Fail-soft to false: a core hiccup here should hide email UI, not crash the layout.
async function getMailEnabled(f: typeof fetch): Promise<boolean> {
	try {
		const res = await f(`${base()}/health`)
		if (!res.ok) return false
		const body = (await res.json()) as { mailEnabled?: boolean }
		return body.mailEnabled === true
	} catch {
		return false
	}
}

export const load: LayoutServerLoad = async ({ fetch, cookies, url }) => {
	const mailEnabled = await getMailEnabled(fetch)
	if (!hasSession(cookies)) return { me: null, mailEnabled }
	try {
		return { me: await getMe(authedFetch(fetch, url.origin, cookieHeader(cookies))), mailEnabled }
	} catch {
		return { me: null, mailEnabled }
	}
}
