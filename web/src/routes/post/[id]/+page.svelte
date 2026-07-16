<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import Avatar from '$lib/Avatar.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import ReplyTree from '$lib/ReplyTree.svelte'
	import PostBody from '$lib/PostBody.svelte'
	import { keepEvent } from '$lib/lens'

	let { data, form }: { data: PageData; form: ActionData } = $props()
	let live = $state<TimelineEntry[]>([])
	const posts = $derived([...data.thread, ...live])

	function onPost(entry: TimelineEntry) {
		if (keepEvent(entry, { kind: 'thread', rootId: data.rootId }) && !posts.some((p) => p.id === entry.id)) live = [...live, entry]
	}

	// The reading view is the TREE: the root card, then every reply nested
	// under its parent (same ReplyTree as the timeline's wedge, fully unfolded).
	const root = $derived(posts.find((p) => p.id === data.rootId))

	// "Replying to" is the way up, one step at a time (rss.chat, 7/10/26):
	// when the viewed post is a reply, link its parent's page.
	const viewed = $derived(posts.find((p) => p.id === data.postId))
	const parent = $derived(
		viewed?.inReplyToPostId ? posts.find((p) => p.id === viewed.inReplyToPostId) : undefined
	)
</script>

<svelte:head><title>Conversation — Textcaster</title></svelte:head>

<LiveTimeline {onPost} />

<div class="lens">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

	<h1>Conversation</h1>
	{#if parent}
		<p class="subnav">Replying to <a href="/post/{parent.id}">@{parent.author.handle}</a></p>
	{:else if viewed?.inReplyTo && !viewed.inReplyToPostId && viewed.inReplyTo.startsWith('http')}
		<p class="subnav">Replying to <a href={viewed.inReplyTo} rel="noreferrer">↗ {viewed.inReplyTo}</a></p>
	{/if}

	{#if data.coreDown}<p class="notice" role="alert">Core API unreachable — is the core server running?</p>{/if}
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

	<ul class="timeline">
		{#if root}
			<li class="post" class:remote={root.source === 'remote'} class:highlight={root.id === data.postId}>
				<div class="byline">
					<Avatar author={root.author} sourceName={root.sourceName} />
					<strong>{root.sourceName ?? root.author.displayName}</strong>
					{#if !root.sourceName}
						<a class="handle" href="/u/{root.author.handle}">@{root.author.handle}</a>
					{/if}
					<span class="kind">{root.source}</span>
				</div>
				{#if root.title}<h2 class="title">{root.title}</h2>{/if}
				<PostBody post={root} />
				{#if root.url}<a class="source" href={root.url} rel="noreferrer">source</a>{/if}
				<ReplyTree thread={posts} parentId={root.id} openAll={true} highlightId={data.postId} />
			</li>
		{:else}
			<li class="timeline-empty">No such conversation.</li>
		{/if}
	</ul>

	<details class="panel" open>
		<summary>Reply</summary>
		<form method="POST" action="?/reply" class="composer">
			<input name="handle" placeholder="your handle" required />
			<textarea name="content" placeholder="write a reply" required></textarea>
			<button>Reply</button>
		</form>
	</details>
</div>
