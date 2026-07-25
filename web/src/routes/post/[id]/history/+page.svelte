<script lang="ts">
	import PostBody from '$lib/PostBody.svelte'
	let { data } = $props()
</script>

<svelte:head><title>Edit history — RSC</title></svelte:head>

<div class="lens">
	<header class="masthead"><a href="/">RSC</a></header>
	<h1>Edit history</h1>
	<p><a href="/post/{data.postId}">← back to the post</a></p>
	<ol class="history">
		{#each data.versions as v ('key' in v ? v.key : v.seenAt)}
			<li>
				{#if v.seenAt}
					<time datetime={v.seenAt}>{v.seenAt.slice(0, 16).replace('T', ' ')}</time>
				{:else}
					<span class="badge-kind">earlier version</span>
				{/if}
				<PostBody post={{ content: '', contentHtml: v.html }} />
			</li>
		{/each}
		<li class="current">
			<span class="badge-kind">current{#if data.editedAt} · edited {data.editedAt.slice(0, 16).replace('T', ' ')}{/if}</span>
			<PostBody post={{ content: '', contentHtml: data.currentHtml }} />
		</li>
	</ol>
</div>
