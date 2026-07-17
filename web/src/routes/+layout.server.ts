import type { LayoutServerLoad } from './$types'
import { getMe } from '$lib/api'
import { authedFetch, cookieHeader, hasSession } from '$lib/server/session'

export const load: LayoutServerLoad = async ({ fetch, cookies, url }) => {
	if (!hasSession(cookies)) return { me: null }
	try {
		return { me: await getMe(authedFetch(fetch, url.origin, cookieHeader(cookies))) }
	} catch {
		return { me: null }
	}
}
