<script lang="ts">
	import type { TimelineEntry } from './types'

	// Ported from rss.chat theme 0.5.323-0.5.328 (live, 7/16/26): a feed icon
	// after the byline linking to the author's feed. Remote authors link to
	// their canonical feed; local authors to our proxied RSS.
	let { author }: { author: TimelineEntry['author'] } = $props()
	const href = $derived(
		author.kind === 'remote' && author.feedUrl ? author.feedUrl : `/u/${author.handle}/feed.xml`
	)
	const label = $derived(`${author.displayName}'s feed`)
</script>

<a class="feed-icon" {href} target="_blank" rel="noreferrer" title={label} aria-label={label}>
	<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
		<circle cx="2.5" cy="13.5" r="2" />
		<path d="M0 6.5v2.5a7 7 0 0 1 7 7h2.5A9.5 9.5 0 0 0 0 6.5z" />
		<path d="M0 1v2.5A12.5 12.5 0 0 1 12.5 16H15A15 15 0 0 0 0 1z" />
	</svg>
</a>
