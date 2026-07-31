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

// Resolve ?tab= + viewer state to the tab actually rendered. Guests can never
// resolve to personal (no handle to filter by); anons can select it explicitly
// (they have a follow graph) but default to public.
export function resolveTab(raw: string | null, me: { isAnonymous: boolean } | null): Tab {
	if (raw && (TABS as readonly string[]).includes(raw) && !(raw === 'personal' && !me)) return raw as Tab
	return me && !me.isAnonymous ? 'personal' : 'public'
}
