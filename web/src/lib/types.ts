export interface TimelineEntry {
	id: string
	title: string | null
	content: string
	contentMarkdown?: string | null
	contentHtml?: string
	url: string | null
	publishedAt: string
	source: 'local' | 'remote'
	author: { id: string; handle: string; displayName: string; kind: 'local' | 'remote'; feedUrl?: string | null; feedType?: 'person' | 'webfeed' | 'instance' | null }
	inReplyTo?: string | null
	inReplyToPostId?: string | null
	replyContextAuthor?: string | null
	replyContextSnippet?: string | null
	threadRootId?: string | null
	replyCount?: number
	sourceName?: string | null
	sourceFeedUrl?: string | null
	editedAt?: string | null
}
