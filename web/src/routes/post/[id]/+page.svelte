<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import Avatar from '$lib/Avatar.svelte'
	import ReplyTree from '$lib/ReplyTree.svelte'
	import ThreadPlaceholder from '$lib/ThreadPlaceholder.svelte'
	import PostBody from '$lib/PostBody.svelte'
	import MarkdownComposer from '$lib/MarkdownComposer.svelte'
	import EditedMarker from '$lib/EditedMarker.svelte'
	import ReplyContext from '$lib/ReplyContext.svelte'
	import RelativeTime from '$lib/RelativeTime.svelte'
	import { enhance } from '$app/forms'
	import type { SubmitFunction } from '@sveltejs/kit'
	import { loadDraft, saveDraft } from '$lib/draft'
	import { confirmSubmit } from '$lib/confirm'
	import { AUDIT_CATEGORIES } from '$lib/logical-types'

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
	// P3 (backlog): this page never got the v2 journal live stream (see the home
	// page's $effect) — snapshot-only, reload to refresh.
	const posts = $derived(data.thread)

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

<svelte:head><title>Conversation — RSC</title></svelte:head>

<div class="lens">
	<h1>Conversation</h1>
	{#if parent}
		<p class="subnav">Replying to <a href="/post/{parent.id}">@{parent.author.handle}</a></p>
	{:else if viewed && !viewed.inReplyToPostId && viewed.replyContextAuthor}
		<p class="subnav"><ReplyContext author={viewed.replyContextAuthor} snippet={viewed.replyContextSnippet} url={viewed.inReplyTo?.startsWith('http') ? viewed.inReplyTo : null} /></p>
	{:else if viewed?.inReplyTo && !viewed.inReplyToPostId && viewed.inReplyTo.startsWith('http')}
		<p class="subnav">Replying to <a href={viewed.inReplyTo} rel="noreferrer">↗ {viewed.inReplyTo}</a></p>
	{/if}

	{#if data.coreDown}<p class="notice" role="alert">Can't load this page right now — try again shortly.</p>{/if}
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

	<ul class="timeline">
		{#if root?.placeholder}
			<!-- D11: the conversation's root is an unavailable ancestor — render a
			     neutral marker and its live replies, never "No such conversation." -->
			<li class="post placeholder">
				<ThreadPlaceholder />
				<ReplyTree thread={posts} parentId={root.id} openAll={true} highlightId={data.postId} />
			</li>
		{:else if root}
			<li class="post" class:remote={root.source === 'remote'} class:highlight={root.id === data.postId}>
				<div class="byline">
					<Avatar author={root.author} sourceName={root.sourceName} />
					<strong>{root.sourceName ?? root.author.displayName}</strong>
					{#if root.publisherId}
						<a class="handle" href="/p/{encodeURIComponent(root.publisherId)}">{root.author.displayName}</a>
					{:else if root.author.handle}
						<a class="handle" href="/u/{root.author.handle}">@{root.author.handle}</a>
					{/if}
					<span class="kind">{root.source}</span>
					<a class="permalink" href="/post/{root.id}"><RelativeTime datetime={root.publishedAt} /></a>
					<EditedMarker post={root} />
					{#if root.id === data.postId}<span class="here">You are here</span>{/if}
				</div>
				{#if root.title}<h2 class="title">{root.title}</h2>{/if}
				<PostBody post={root} />
				{#if root.source === 'remote' && root.url}<a class="source" href={root.url} rel="noreferrer">source</a>{/if}
				{#if root.source === 'local' && !root.removed && data.me?.user.id === root.author.id}
					<a class="edit" href="/post/{root.id}/edit">Edit</a>
				{/if}
				{#if root.source === 'local' && root.author.id === data.me?.user.id}
					<!-- Author's own removal: core's DELETE /posts/:id takes no body. -->
					<form method="POST" action="?/deletePost" use:enhance={confirmSubmit('Remove this post? This can\'t be undone.')}>
						<input type="hidden" name="id" value={root.id} />
						<button class="danger-link" type="submit">Remove</button>
					</form>
				{:else if root.source === 'local' && data.me?.isAdmin}
					<!-- Admin removing someone else's post: core's DELETE /admin/posts/:id
					     REQUIRES {category, note?} — same moderation-category pattern as
					     admin/items/[id]'s Hide/Restore forms. -->
					<form method="POST" action="?/deletePost" class="remove-admin" use:enhance={confirmSubmit('Remove this post? This can\'t be undone.')}>
						<input type="hidden" name="id" value={root.id} />
						<input type="hidden" name="asAdmin" value="1" />
						<label class="visually-hidden" for="remove-cat-{root.id}">Moderation category</label>
						<select id="remove-cat-{root.id}" name="category" required>
							{#each AUDIT_CATEGORIES as c (c)}<option value={c}>{c.replace(/_/g, ' ')}</option>{/each}
						</select>
						<label class="visually-hidden" for="remove-note-{root.id}">Note (optional)</label>
						<input id="remove-note-{root.id}" name="note" placeholder="note (optional)" />
						<button class="danger-link" type="submit">Remove</button>
					</form>
				{/if}
				<ReplyTree thread={posts} parentId={root.id} openAll={true} highlightId={data.postId} />
			</li>
		{:else if posts.length === 0}
			<!-- Genuinely empty: no item AND no placeholder node (D11) -->
			<li class="timeline-empty">No such conversation.</li>
		{/if}
	</ul>

	{#if !viewed?.removed}
		<!-- The server already refuses a reply to a removed post (403, Task 2) —
		     don't offer an action that will only fail. -->
		<details class="panel" open>
			<summary>Reply</summary>
			{#if replyError}<p class="error" role="alert">{replyError}</p>{/if}
			<form method="POST" action="?/reply" class="composer" use:enhance={submitReply}>
				<MarkdownComposer placeholder="write a reply" bind:value={content} />
				<button>Reply</button>
			</form>
		</details>
	{/if}
</div>
