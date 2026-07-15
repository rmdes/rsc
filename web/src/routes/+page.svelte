<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	let live = $state<TimelineEntry[]>([])
	const posts = $derived([...live, ...data.timeline])

	function onPost(entry: TimelineEntry) {
		if (!posts.some((p) => p.id === entry.id)) live = [entry, ...live]
	}
</script>

{#if data.isFirstPage}
	<LiveTimeline {onPost} />
{/if}

<h1>Textcaster</h1>

{#if data.coreDown}
	<p class="notice" role="alert">Core API unreachable — is the core server running?</p>
{/if}

{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

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

{#if data.nextCursor}
	<a class="older" href="/?before={encodeURIComponent(data.nextCursor)}">Older posts</a>
{/if}
