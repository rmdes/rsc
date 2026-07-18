<script lang="ts">
	import PostBody from '$lib/PostBody.svelte'
	let { data } = $props()
</script>

<svelte:head><title>Edit history — Textcaster</title></svelte:head>

<div class="lens">
	<header class="masthead"><a href="/">Textcaster</a></header>
	<h1>Edit history</h1>
	<p><a href="/post/{data.postId}">← back to the post</a></p>
	<ol class="history">
		{#each data.versions as v (v.seenAt)}
			<li>
				<time datetime={v.seenAt}>{v.seenAt.slice(0, 16).replace('T', ' ')}</time>
				<PostBody post={{ content: '', contentHtml: v.html }} />
			</li>
		{/each}
		<li class="current">
			<span class="badge-kind">current{#if data.editedAt} · edited {data.editedAt.slice(0, 16).replace('T', ' ')}{/if}</span>
			<PostBody post={{ content: '', contentHtml: data.currentHtml }} />
		</li>
	</ol>
</div>
