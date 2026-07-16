<script lang="ts">
	import type { PageData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import { keepEvent } from '$lib/lens'
	import { plaintext } from '$lib/plaintext'

	let { data }: { data: PageData } = $props()
	const authorId = $derived(data.timeline[0]?.author.id ?? null)
	const kind = $derived(data.timeline[0]?.author.kind ?? null)
	let live = $state<TimelineEntry[]>([])
	const posts = $derived([...live, ...data.timeline])

	function onPost(entry: TimelineEntry) {
		if (authorId && keepEvent(entry, { kind: 'author', authorId }) && !posts.some((p) => p.id === entry.id)) live = [entry, ...live]
	}
</script>

{#if data.isFirstPage && authorId}
	<LiveTimeline {onPost} />
{/if}

<div class="lens">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

	<div>
		<h1>
			@{data.handle}
			{#if kind}<span class="badge-kind">{kind}</span>{/if}
		</h1>
		<p class="subnav"><a href="/u/{data.handle}/following">following &amp; followers</a></p>
	</div>

	{#if data.coreDown}<p class="notice" role="alert">Core API unreachable — is the core server running?</p>{/if}

	<ul class="timeline">
		{#each posts as post (post.id)}
			<li class="post" class:remote={post.source === 'remote'}>
				{#if post.title}<h2 class="title">{post.title}</h2>{/if}
				<p>{plaintext(post.content)}</p>
				{#if post.url}<a href={post.url} rel="noreferrer">source</a>{/if}
			</li>
		{/each}
	</ul>

	{#if data.nextCursor}
		<a class="older" href="/u/{data.handle}?before={encodeURIComponent(data.nextCursor)}">Older posts</a>
	{/if}
</div>
