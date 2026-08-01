import type { LayoutServerLoad } from './$types'
import { getMe, getInstanceConfig } from '$lib/api'
import { authedFetch, cookieHeader, hasSession } from '$lib/server/session'
import { resolveTab, mergeTabCopy } from '$lib/tabs'

export const load: LayoutServerLoad = async ({ fetch, cookies, url }) => {
	const cfg = await getInstanceConfig(fetch)
	const { labels: tabLabels, subtitles: tabSubtitles } = mergeTabCopy({ labels: cfg.tabLabels, subtitles: cfg.tabSubtitles })
	const mailEnabled = cfg.mailEnabled
	const tab = (me: Parameters<typeof resolveTab>[1]) => resolveTab(url.searchParams.get('tab'), me)
	const subscribeCommandId = (me: { isAnonymous: boolean } | null) =>
		url.pathname === '/' && me && !me.isAnonymous ? crypto.randomUUID() : undefined
	const commonExtras = { mailEnabled, tabLabels, tabSubtitles }
	if (!hasSession(cookies)) return { me: null, ...commonExtras, tab: tab(null), subscribeCommandId: subscribeCommandId(null) }
	try {
		const me = await getMe(authedFetch(fetch, url.origin, cookieHeader(cookies)))
		return { me, ...commonExtras, tab: tab(me), subscribeCommandId: subscribeCommandId(me) }
	} catch {
		return { me: null, ...commonExtras, tab: tab(null), subscribeCommandId: subscribeCommandId(null) }
	}
}
