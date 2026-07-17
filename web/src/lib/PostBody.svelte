<script lang="ts">
	import type { TimelineEntry } from './types'
	import { plaintext } from './plaintext'
	import { toggleClamp, markClipped } from './expand'

	// THE {@html} chokepoint — the only one in the codebase. contentHtml is
	// produced exclusively by lib/server/render.ts (sanitized server-side at
	// all three ingress points); anything without it falls back to plaintext,
	// never raw.
	let { post }: { post: TimelineEntry } = $props()
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
