// The four home-timeline tabs — filters over the one shared post pool (SP2).
export const TABS = ['local', 'federated', 'personal', 'public'] as const
export type Tab = (typeof TABS)[number]

// Display labels, decoupled from the routing key: `personal` reads as
// "following" (the sources you chose, not a private view) and `public` as
// "explore" (the whole-instance firehose). The keys stay personal/public so
// ?tab= bookmarks and resolveTab keep working.
export const TAB_LABELS: Record<Tab, string> = {
	local: 'local',
	federated: 'federated',
	personal: 'following',
	public: 'explore'
}

// Page-head subtitle per tab — describes the scope each filter shows. Was
// hardcoded to the `personal` line on every tab.
export const TAB_SUBTITLES: Record<Tab, string> = {
	local: 'Posts written here, on this instance',
	federated: 'Posts from the instances this one federates with',
	personal: 'Everything from you and the people you follow',
	public: 'Every post and feed across this instance'
}

type TabOverrides = { labels?: Partial<Record<Tab, string | null>>; subtitles?: Partial<Record<Tab, string | null>> } | null

// Merge admin-configured overrides over the built-in defaults: null/''/missing
// all fall back, anything else wins.
export function mergeTabCopy(overrides: TabOverrides): { labels: Record<Tab, string>; subtitles: Record<Tab, string> } {
	const pick = (o: Partial<Record<Tab, string | null>> | undefined, k: Tab, def: string) => {
		const v = o?.[k]
		return v && v !== '' ? v : def
	}
	const labels = {} as Record<Tab, string>
	const subtitles = {} as Record<Tab, string>
	for (const t of TABS) {
		labels[t] = pick(overrides?.labels, t, TAB_LABELS[t])
		subtitles[t] = pick(overrides?.subtitles, t, TAB_SUBTITLES[t])
	}
	return { labels, subtitles }
}

// Resolve ?tab= + viewer state to the tab actually rendered. Guests can never
// resolve to personal (no handle to filter by); anons can select it explicitly
// (they have a follow graph) but default to public.
export function resolveTab(raw: string | null, me: { isAnonymous: boolean } | null): Tab {
	if (raw && (TABS as readonly string[]).includes(raw) && !(raw === 'personal' && !me)) return raw as Tab
	return me && !me.isAnonymous ? 'personal' : 'public'
}
