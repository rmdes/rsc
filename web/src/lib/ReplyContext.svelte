<script lang="ts">
	let { author, snippet = null, url = null }: { author: string; snippet?: string | null; url?: string | null } = $props()
</script>
<span class="reply-context">In reply to {author}{#if snippet}: “{snippet}”{/if}{#if url} <a class="reply-context" href={url} rel="noreferrer">↗</a>{/if}</span>
