<script lang="ts">
	import type { TimelineEntry } from './types'

	// Ported from rss.chat theme 0.5.323-0.5.328 (live, 7/16/26): a feed icon
	// after the byline linking to the author's feed. Items from aggregate feeds
	// (RSS <source>) link their PER-ITEM source feed — the item's real author —
	// else remote authors link their canonical feed, locals our proxied RSS.
	let {
		author,
		sourceName = null,
		sourceFeedUrl = null
	}: { author: TimelineEntry['author']; sourceName?: string | null; sourceFeedUrl?: string | null } =
		$props()
	// Scheme guard (defense in depth): every write path is http(s)-only already,
	// but a javascript: URL here would be click-to-XSS if that ever slips.
	const safe = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null)
	// A non-navigable v2 remote publisher has no feed URL and an empty handle — the
	// /u//feed.xml fallback would be a dead link, so it yields none and no icon renders.
	const href = $derived(
		safe(sourceFeedUrl) ??
			(author.kind === 'remote' && safe(author.feedUrl)
				? author.feedUrl
				: author.handle
					? `/u/${author.handle}/feed.xml`
					: null)
	)
	const label = $derived(`${sourceName ?? author.displayName}'s feed`)
</script>

{#if href}
	<a class="feed-icon" {href} target="_blank" rel="noreferrer" title={label} aria-label={label}>
		<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<circle cx="2.5" cy="13.5" r="2" />
			<path d="M0 6.5v2.5a7 7 0 0 1 7 7h2.5A9.5 9.5 0 0 0 0 6.5z" />
			<path d="M0 1v2.5A12.5 12.5 0 0 1 12.5 16H15A15 15 0 0 0 0 1z" />
		</svg>
	</a>
{/if}
