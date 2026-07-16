<script lang="ts">
	import type { PageData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import ReplyTree from '$lib/ReplyTree.svelte'
	import FeedIcon from '$lib/FeedIcon.svelte'
	import { keepEvent } from '$lib/lens'
	import { plaintext } from '$lib/plaintext'
	import { toggleClamp } from '$lib/expand'
	import Linkified from '$lib/Linkified.svelte'
	import { hiddenIds, fetchThread } from '$lib/wedge'

	let { data }: { data: PageData } = $props()
	const authorId = $derived(data.timeline[0]?.author.id ?? null)
	const kind = $derived(data.timeline[0]?.author.kind ?? null)
	let live = $state<TimelineEntry[]>([])
	const posts = $derived([...live, ...data.timeline])

	function onPost(entry: TimelineEntry) {
		if (authorId && keepEvent(entry, { kind: 'author', authorId }) && !posts.some((p) => p.id === entry.id)) live = [entry, ...live]
	}

	let expanded = $state<Record<string, TimelineEntry[]>>({})
	const hidden = $derived(hiddenIds(expanded))
	async function toggleWedge(id: string) {
		if (expanded[id]) delete expanded[id]
		else expanded[id] = await fetchThread(id)
	}
</script>

<svelte:head><title>@{data.handle} — Textcaster</title></svelte:head>

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
			{#if data.timeline[0]}<FeedIcon author={data.timeline[0].author} />{/if}
		</h1>
		<p class="subnav"><a href="/u/{data.handle}/following">following &amp; followers</a></p>
	</div>

	{#if data.coreDown}<p class="notice" role="alert">Core API unreachable — is the core server running?</p>{/if}

	<ul class="timeline">
		{#each posts.filter((p) => !hidden.has(p.id)) as post (post.id)}
			<li class="post" class:remote={post.source === 'remote'}>
				{#if post.replyCount}
					<a
						class="wedge"
						class:light={!!expanded[post.id]}
						href="/post/{post.id}"
						role="button"
						aria-expanded={!!expanded[post.id]}
						aria-label="{expanded[post.id] ? 'Hide' : 'Show'} {post.replyCount} {post.replyCount === 1 ? 'reply' : 'replies'}"
						onclick={(e) => {
							e.preventDefault()
							toggleWedge(post.id)
						}}>▸</a
					>
				{:else}
					<span class="wedge light" aria-hidden="true">▸</span>
				{/if}
				{#if post.title}<h2 class="title">{post.title}</h2>{/if}
				<!-- click-to-expand is a pointer convenience; keyboard/AT users reach the full text via the conversation link -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<p class="body" onclick={toggleClamp}><Linkified text={plaintext(post.content)} /></p>
				<a class="source" href="/post/{post.id}">{post.replyCount || post.threadRootId || post.inReplyToPostId ? 'View conversation' : 'Reply'}</a>
				{#if post.inReplyTo && !post.inReplyToPostId && post.inReplyTo.startsWith('http')}
					<a class="source" href={post.inReplyTo} rel="noreferrer">in reply to ↗</a>
				{/if}
				{#if post.url}<a href={post.url} rel="noreferrer">source</a>{/if}
				{#if expanded[post.id]}
					<ReplyTree thread={expanded[post.id]} parentId={post.id} />
				{/if}
			</li>
		{:else}
			<li class="timeline-empty">@{data.handle} hasn't posted anything yet.</li>
		{/each}
	</ul>

	{#if data.nextCursor}
		<a class="older" href="/u/{data.handle}?before={encodeURIComponent(data.nextCursor)}">Older posts</a>
	{/if}
</div>
