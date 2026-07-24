<script lang="ts">
	import { plaintext } from './plaintext'
	import { toggleClamp, markClipped } from './expand'

	// THE {@html} chokepoint — the only one in the codebase. contentHtml is
	// produced exclusively by lib/server/render.ts (sanitized server-side at
	// all three ingress points); anything without it falls back to plaintext,
	// never raw. Prop type is the minimal shape this component actually
	// reads (not TimelineEntry) so callers like the history page — which only
	// have a version's content/contentHtml, not a full TimelineEntry — can
	// route through the same one chokepoint.
	let { post }: { post: { content: string; contentHtml?: string; enclosures?: { url: string; mimeType: string | null; title: string | null; sizeBytes: number | null; durationSeconds: number | null }[] } } = $props()

	// MASTER.md "text first, enclosures second": native elements only, an
	// attachment block BELOW the text, never a hero. Only http(s) URLs render
	// (feed-supplied values; anything else falls to nothing, not to a link).
	const httpUrl = (u: string): boolean => u.startsWith('https://') || u.startsWith('http://')
	const kindOf = (mime: string | null, url: string): 'audio' | 'video' | 'image' | 'file' => {
		const m = mime ?? ''
		if (m.startsWith('audio/')) return 'audio'
		if (m.startsWith('video/')) return 'video'
		if (m.startsWith('image/')) return 'image'
		if (/\.(mp3|m4a|ogg|oga|opus|wav)(\?|$)/i.test(url)) return 'audio'
		if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return 'video'
		if (/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(url)) return 'image'
		return 'file'
	}
	const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
	const label = (e: { url: string; title: string | null; durationSeconds: number | null }): string =>
		e.title ?? (e.durationSeconds ? `Audio · ${mmss(e.durationSeconds)}` : new URL(e.url).hostname)
	const enclosures = $derived((post.enclosures ?? []).filter((e) => httpUrl(e.url)))
</script>

<!-- click-to-expand is a pointer convenience; keyboard/AT users reach the full text via the conversation link -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="body" onclick={toggleClamp} use:markClipped>
	{#if post.contentHtml}
		{@html post.contentHtml}
	{:else}
		<p>{plaintext(post.content)}</p>
	{/if}
</div>
{#if enclosures.length > 0}
	<div class="enclosures">
		{#each enclosures as e (e.url)}
			{#if kindOf(e.mimeType, e.url) === 'audio'}
				<figure>
					<figcaption>{label(e)}</figcaption>
					<audio controls preload="none" src={e.url}></audio>
				</figure>
			{:else if kindOf(e.mimeType, e.url) === 'video'}
				<!-- svelte-ignore a11y_media_has_caption — remote feed media ships no track -->
				<video controls preload="none" src={e.url}></video>
			{:else if kindOf(e.mimeType, e.url) === 'image'}
				<img loading="lazy" src={e.url} alt={e.title ?? ''} />
			{:else}
				<a href={e.url} rel="noopener nofollow" download>{label(e)}</a>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.enclosures {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.enclosures figure {
		margin: 0;
	}
	.enclosures figcaption {
		font-size: 0.8125rem;
		color: var(--color-muted);
		margin-bottom: 0.25rem;
	}
	.enclosures audio,
	.enclosures video,
	.enclosures img {
		width: 100%;
		max-width: 100%;
	}
	.enclosures img,
	.enclosures video {
		border-radius: 4px;
		height: auto;
	}
</style>
