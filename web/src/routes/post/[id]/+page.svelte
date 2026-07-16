<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import Avatar from '$lib/Avatar.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import { keepEvent } from '$lib/lens'
	import { plaintext } from '$lib/plaintext'
	import Linkified from '$lib/Linkified.svelte'

	let { data, form }: { data: PageData; form: ActionData } = $props()
	let live = $state<TimelineEntry[]>([])
	const posts = $derived([...data.thread, ...live])

	function onPost(entry: TimelineEntry) {
		if (keepEvent(entry, { kind: 'thread', rootId: data.rootId }) && !posts.some((p) => p.id === entry.id)) live = [...live, entry]
	}

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
		{#each posts as post (post.id)}
			<li class="post" class:remote={post.source === 'remote'} class:highlight={post.id === data.postId}>
				<div class="byline">
					<Avatar author={post.author} sourceName={post.sourceName} />
					<strong>{post.sourceName ?? post.author.displayName}</strong>
					{#if !post.sourceName}
						<a class="handle" href="/u/{post.author.handle}">@{post.author.handle}</a>
					{/if}
					<span class="kind">{post.source}</span>
				</div>
				{#if post.title}<h2 class="title">{post.title}</h2>{/if}
				<p><Linkified text={plaintext(post.content)} /></p>
				{#if post.url}<a class="source" href={post.url} rel="noreferrer">source</a>{/if}
			</li>
		{:else}
			<li class="timeline-empty">No such conversation.</li>
		{/each}
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
