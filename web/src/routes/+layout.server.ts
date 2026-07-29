import type { LayoutServerLoad } from './$types'
import { getMe } from '$lib/api'
import { authedFetch, base, cookieHeader, hasSession } from '$lib/server/session'
import { resolveTab } from '$lib/tabs'

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
	const tab = (me: Parameters<typeof resolveTab>[1]) => resolveTab(url.searchParams.get('tab'), me)
	const subscribeCommandId = (me: { isAnonymous: boolean } | null) =>
		url.pathname === '/' && me && !me.isAnonymous ? crypto.randomUUID() : undefined
	if (!hasSession(cookies)) return { me: null, mailEnabled, tab: tab(null), subscribeCommandId: subscribeCommandId(null) }
	try {
		const me = await getMe(authedFetch(fetch, url.origin, cookieHeader(cookies)))
		return { me, mailEnabled, tab: tab(me), subscribeCommandId: subscribeCommandId(me) }
	} catch {
		return { me: null, mailEnabled, tab: tab(null), subscribeCommandId: subscribeCommandId(null) }
	}
}
