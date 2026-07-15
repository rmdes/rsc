<script lang="ts">
	import type { PageData } from './$types'

	let { data }: { data: PageData } = $props()
</script>

<h1>Textcaster</h1>

<ul class="timeline">
	{#each data.timeline as post (post.id)}
		<li class="post" class:remote={post.source === 'remote'}>
			<strong>{post.author.displayName}</strong>
			<span class="handle">@{post.author.handle}</span>
			<span class="kind">{post.source}</span>
			{#if post.title}<h2 class="title">{post.title}</h2>{/if}
			<p>{post.content}</p>
			{#if post.url}<a href={post.url} rel="noreferrer">source</a>{/if}
		</li>
	{/each}
</ul>
