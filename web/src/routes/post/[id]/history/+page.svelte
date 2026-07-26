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
		{#each data.versions as v, i (v.key)}
			<li>
				{#if v.seenAt}
					<time datetime={v.seenAt}>{v.seenAt.slice(0, 16).replace('T', ' ')}</time>
				{:else}
					<span class="badge-kind">{i === 0 ? 'created' : 'earlier version'}</span>
				{/if}
				{#if v.title}<h2 class="title">{v.title}</h2>{/if}
				<PostBody post={{ content: '', contentHtml: v.html, enclosures: v.enclosures }} />
			</li>
		{/each}
		<li class="current">
			<span class="badge-kind">current{#if data.editedAt} · edited {data.editedAt.slice(0, 16).replace('T', ' ')}{/if}</span>
			{#if data.currentTitle}<h2 class="title">{data.currentTitle}</h2>{/if}
			<PostBody post={{ content: '', contentHtml: data.currentHtml, enclosures: data.currentEnclosures }} />
		</li>
	</ol>
</div>
