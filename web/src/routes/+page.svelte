<script lang="ts">
	import type { PageData } from './$types'
	import type { TimelineEntry } from '$lib/types.ts'
	import LiveTimeline from '$lib/LiveTimeline.svelte'

	let { data }: { data: PageData } = $props()

	let live = $state<TimelineEntry[]>([])
	const posts = $derived([...live, ...data.timeline])

	function onPost(entry: TimelineEntry) {
		if (!posts.some((p) => p.id === entry.id)) live = [entry, ...live]
	}
</script>

<LiveTimeline {onPost} />

<h1>Textcaster</h1>

<form method="POST" action="?/compose" class="composer">
	<input name="handle" placeholder="your handle" required />
	<input name="displayName" placeholder="display name (optional)" />
	<textarea name="content" placeholder="what's happening?" required></textarea>
	<button>Post</button>
</form>

<form method="POST" action="?/addRemote" class="add-remote">
	<input name="handle" placeholder="remote handle" required />
	<input name="displayName" placeholder="display name (optional)" />
	<input name="feedUrl" type="url" placeholder="https://their-site.com/feed.xml" required />
	<button>Add remote user</button>
</form>

<ul class="timeline">
	{#each posts as post (post.id)}
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
