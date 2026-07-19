<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import Avatar from '$lib/Avatar.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import ReplyTree from '$lib/ReplyTree.svelte'
	import PostBody from '$lib/PostBody.svelte'
	import MarkdownComposer from '$lib/MarkdownComposer.svelte'
	import EditedMarker from '$lib/EditedMarker.svelte'
	import ReplyContext from '$lib/ReplyContext.svelte'
	import { mergeIncoming } from '$lib/live'
	import { keepEvent } from '$lib/lens'
	import { enhance } from '$app/forms'
	import type { SubmitFunction } from '@sveltejs/kit'
	import { loadDraft, saveDraft } from '$lib/draft'
	import { confirmSubmit } from '$lib/confirm'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	// Reply draft, keyed per post: navigating away and back resumes the reply.
	// Cleared only on confirmed submit success.
	const draftKey = $derived(`reply:${data.postId}`)
	let content = $state('')
	let replyError = $state('')
	let restored = $state(false)
	$effect(() => {
		const d = loadDraft(draftKey)
		content = d.content ?? ''
		restored = true
	})
	$effect(() => {
		if (restored) saveDraft(draftKey, { content })
	})
	const submitReply: SubmitFunction = () =>
		async ({ result, update }) => {
			if (result.type === 'failure') {
				replyError = typeof result.data?.error === 'string' ? result.data.error : 'Something went wrong'
			} else if (result.type === 'error') {
				replyError = 'Something went wrong'
			} else {
				replyError = ''
				content = ''
			}
			await update()
		}
	let live = $state<TimelineEntry[]>([])
	let edited = $state<Record<string, TimelineEntry>>({})
	const pageIds = $derived(new Set(data.thread.map((p) => p.id)))
	const posts = $derived([...data.thread, ...live].map((p) => edited[p.id] ?? p))

	function onPost(entry: TimelineEntry) {
		if (!keepEvent(entry, { kind: 'thread', rootId: data.rootId })) return
		const r = mergeIncoming(live, edited, entry, pageIds)
		live = r.live
		edited = r.edited
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
	{:else if viewed && !viewed.inReplyToPostId && viewed.replyContextAuthor}
		<p class="subnav"><ReplyContext author={viewed.replyContextAuthor} snippet={viewed.replyContextSnippet} url={viewed.inReplyTo?.startsWith('http') ? viewed.inReplyTo : null} /></p>
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
					<a class="handle" href="/u/{root.author.handle}">@{root.author.handle}</a>
					<span class="kind">{root.source}</span>
					<a class="permalink" href="/post/{root.id}"><time datetime={root.publishedAt}>{root.publishedAt.slice(0, 10)}</time></a>
					<EditedMarker post={root} />
				</div>
				{#if root.title}<h2 class="title">{root.title}</h2>{/if}
				<PostBody post={root} />
				{#if root.source === 'remote' && root.url}<a class="source" href={root.url} rel="noreferrer">source</a>{/if}
				{#if root.source === 'local' && data.me?.user.id === root.author.id}
					<a class="edit" href="/post/{root.id}/edit">Edit</a>
				{/if}
				{#if data.me?.isAdmin && root.source === 'local'}
					<form method="POST" action="?/deletePost" use:enhance={confirmSubmit('Remove this post? This can\'t be undone.')}>
						<input type="hidden" name="id" value={root.id} />
						<button class="danger-link" type="submit">Remove</button>
					</form>
				{/if}
				<ReplyTree thread={posts} parentId={root.id} openAll={true} highlightId={data.postId} />
			</li>
		{:else}
			<li class="timeline-empty">No such conversation.</li>
		{/if}
	</ul>

	<details class="panel" open>
		<summary>Reply</summary>
		{#if replyError}<p class="error" role="alert">{replyError}</p>{/if}
		<form method="POST" action="?/reply" class="composer" use:enhance={submitReply}>
			<MarkdownComposer placeholder="write a reply" bind:value={content} />
			<button>Reply</button>
		</form>
	</details>
</div>

<style>
	/* Text-button destructive affordance, matching .edit/.source's inline
	   link weight — not a filled/outlined button (that's .danger on
	   /admin/users, a card list with more visual room). */
	.danger-link {
		font: inherit;
		font-size: 0.875rem;
		background: none;
		border: none;
		padding: 0;
		color: var(--color-destructive);
		cursor: pointer;
	}

	.danger-link:hover {
		text-decoration: underline;
	}
</style>
