<script lang="ts">
	import MarkdownComposer from '$lib/MarkdownComposer.svelte'
	import { enhance } from '$app/forms'
	let { data, form } = $props()
	let content = $state(data.post.content)
</script>

<svelte:head><title>Edit — Textcaster</title></svelte:head>

<div class="lens">
	<header class="masthead"><a href="/">Textcaster</a></header>
	<h1>Edit post</h1>
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
	<form method="POST" action="?/edit" class="composer" use:enhance>
		<MarkdownComposer bind:value={content} />
		<button>Save</button>
	</form>
	<p><a href="/post/{data.post.id}">Cancel</a></p>
</div>
