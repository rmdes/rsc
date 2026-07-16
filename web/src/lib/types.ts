export interface TimelineEntry {
	id: string
	title: string | null
	content: string
	url: string | null
	publishedAt: string
	source: 'local' | 'remote'
	author: { id: string; handle: string; displayName: string; kind: 'local' | 'remote' }
}
