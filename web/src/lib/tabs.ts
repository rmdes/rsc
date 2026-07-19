// The four home-timeline tabs — filters over the one shared post pool (SP2).
export const TABS = ['local', 'federated', 'personal', 'public'] as const
export type Tab = (typeof TABS)[number]

// Resolve ?tab= + viewer state to the tab actually rendered. Guests can never
// resolve to personal (no handle to filter by); anons can select it explicitly
// (they have a follow graph) but default to public.
export function resolveTab(raw: string | null, me: { isAnonymous: boolean } | null): Tab {
	if (raw && (TABS as readonly string[]).includes(raw) && !(raw === 'personal' && !me)) return raw as Tab
	return me && !me.isAnonymous ? 'personal' : 'public'
}

export function tabFilter(tab: Tab, meHandle: string | undefined): { source?: 'local'; feedType?: 'instance'; followedBy?: string } {
	if (tab === 'local') return { source: 'local' }
	if (tab === 'federated') return { feedType: 'instance' }
	if (tab === 'personal') return { followedBy: meHandle }
	return {}
}
