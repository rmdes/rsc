<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import { keepEvent } from '$lib/lens'
	import { plaintext } from '$lib/plaintext'
	import { toggleClamp } from '$lib/expand'
	import Linkified from '$lib/Linkified.svelte'
	import ReplyTree from '$lib/ReplyTree.svelte'
	import FeedIcon from '$lib/FeedIcon.svelte'
	import { hiddenIds, fetchThread } from '$lib/wedge'

	let { data, form }: { data: PageData; form: ActionData } = $props()
	const followSet = $derived(new Set(data.followIds))
	let live = $state<TimelineEntry[]>([])
	const posts = $derived([...live, ...data.timeline])

	function onPost(entry: TimelineEntry) {
		if (keepEvent(entry, { kind: 'followed', followIds: followSet }) && !posts.some((p) => p.id === entry.id)) live = [entry, ...live]
	}

	let expanded = $state<Record<string, TimelineEntry[]>>({})
	const hidden = $derived(hiddenIds(expanded))
	async function toggleWedge(id: string) {
		if (expanded[id]) delete expanded[id]
		else expanded[id] = await fetchThread(id)
	}
</script>

<svelte:head><title>@{data.handle} following — Textcaster</title></svelte:head>

{#if data.isFirstPage}
	<LiveTimeline {onPost} />
{/if}

<div class="lens">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

	<div>
		<h1>@{data.handle} — following</h1>
		<p class="subnav"><a href="/u/{data.handle}">author lens</a> · <a href="/u/{data.handle}/following.opml">export OPML</a></p>
	</div>

	{#if data.coreDown}<p class="notice" role="alert">Core API unreachable — is the core server running?</p>{/if}
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
	{#if form?.ok && form.result}
		<p class="import-result">Imported: {form.result.followed} followed, {form.result.created} created, {form.result.skipped} skipped.</p>
	{/if}

	<details class="panel" open>
		<summary>Follow someone</summary>
		<form method="POST" action="?/follow" class="follow-form">
			<label class="visually-hidden" for="follow-target">Handle to follow</label>
			<input id="follow-target" name="target" placeholder="handle to follow" required />
			<button>Follow</button>
		</form>
	</details>

	<details class="panel">
		<summary>Import OPML</summary>
		<form method="POST" action="?/import" enctype="multipart/form-data" class="import-form">
			<label class="visually-hidden" for="import-opml">OPML file to import</label>
			<input id="import-opml" type="file" name="opml" accept=".opml,.xml,text/xml" required />
			<button>Import OPML</button>
		</form>
	</details>

	<section>
		<h2>Following</h2>
		{#if data.following.length === 0}
			<p class="subnav">Not following anyone yet.</p>
		{:else}
			<ul class="following-list">
				{#each data.following as u (u.id)}
					<li>
						<span><a href="/u/{u.handle}">@{u.handle}</a> <span class="badge-kind">{u.kind}</span></span>
						<form method="POST" action="?/unfollow" class="unfollow-form">
							<input type="hidden" name="target" value={u.handle} />
							<button>Unfollow</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section>
		<h2>Timeline</h2>
		<ul class="timeline">
			{#each posts.filter((p) => !hidden.has(p.id)) as post (post.id)}
				<li class="post" class:remote={post.source === 'remote'}>
					<div class="byline">
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
						<strong>{post.author.displayName}</strong>
						<a class="handle" href="/u/{post.author.handle}">@{post.author.handle}</a> {#if post.sourceName}<span class="via">from {post.sourceName}</span>{/if}
						<span class="kind">{post.source}</span>
						<FeedIcon author={post.author} sourceName={post.sourceName} sourceFeedUrl={post.sourceFeedUrl} />
					</div>
					{#if post.title}<h3 class="title">{post.title}</h3>{/if}
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
				<li class="timeline-empty">Nothing here yet — posts from the people you follow will appear as they arrive.</li>
			{/each}
		</ul>

		{#if data.nextCursor}
			<a class="older" href="/u/{data.handle}/following?before={encodeURIComponent(data.nextCursor)}">Older posts</a>
		{/if}
	</section>
</div>
