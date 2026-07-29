<script lang="ts">
	import MarkdownComposer from '$lib/MarkdownComposer.svelte'
	import { enhance } from '$app/forms'
	let { data, form } = $props()
	// $derived (not $state): seeds from the post, holds local edits (bind:value
	// reassigns it), and re-seeds when navigating to a different post — same-route
	// component reuse otherwise keeps a stale $state. Svelte 5.25+ reassignable derived.
	let content = $derived(data.post.content)
</script>

<svelte:head><title>Edit — RSC</title></svelte:head>

<div class="lens">
	<h1>Edit post</h1>
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
	<form method="POST" action="?/edit" class="composer" use:enhance>
		<MarkdownComposer bind:value={content} />
		<button>Save</button>
	</form>
	<p><a href="/post/{data.post.id}">Cancel</a></p>
</div>
