<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import ComposerDialog from '$lib/ComposerDialog.svelte'
	import ReplyTree from '$lib/ReplyTree.svelte'
	import FeedIcon from '$lib/FeedIcon.svelte'
	import Avatar from '$lib/Avatar.svelte'
	import PostBody from '$lib/PostBody.svelte'
	import { hiddenIds, fetchThread } from '$lib/wedge'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	let live = $state<TimelineEntry[]>([])
	const posts = $derived([...live, ...data.timeline])

	function onPost(entry: TimelineEntry) {
		if (!posts.some((p) => p.id === entry.id)) live = [entry, ...live]
	}

	// Group Textcasting peers by instance host: "which textcasters is this
	// instance connected to" reads as instances, not individual feed URLs.
	const peerHosts = $derived.by(() => {
		const counts = new Map<string, number>()
		for (const p of data.peers ?? []) {
			const host = p.feedUrl ? URL.parse(p.feedUrl)?.host : null
			if (host) counts.set(host, (counts.get(host) ?? 0) + 1)
		}
		return [...counts.entries()].map(([host, feeds]) => ({ host, feeds }))
	})

	// Open wedges: post id → its flat thread. Revealed subtrees hide from the
	// top level (a post never shows twice) and return when the wedge folds.
	let expanded = $state<Record<string, TimelineEntry[]>>({})
	const hidden = $derived(hiddenIds(expanded))
	async function toggleWedge(id: string) {
		if (expanded[id]) delete expanded[id]
		else expanded[id] = await fetchThread(id)
	}
</script>

<svelte:head><title>Textcaster</title></svelte:head>

{#if data.isFirstPage}
	<LiveTimeline {onPost} />
{/if}

<div class="shell">
	<aside class="tools">
		<header class="masthead">
			<a href="/">Textcaster</a>
			<ThemeToggle />
		</header>

		<ComposerDialog
			draftKey="compose"
			action="?/compose"
			title="New post"
			submitLabel="Post"
			placeholder="what's happening?"
		/>

		{#if data.me && !data.me.isAnonymous}
			<details class="panel">
				<summary>Add remote user</summary>
				<form method="POST" action="?/addRemote" class="add-remote">
					<input name="handle" placeholder="remote handle" required />
					<input name="displayName" placeholder="display name (optional)" />
					<input name="feedUrl" type="url" placeholder="https://their-site.com/feed.xml" required />
					<button>Add remote user</button>
				</form>
			</details>
		{:else}
			<p class="auth-note">Register to add feeds.</p>
		{/if}
	</aside>

	<main>
		{#if data.coreDown}
			<p class="notice" role="alert">Core API unreachable — is the core server running?</p>
		{/if}

		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

		<ul class="timeline">
			{#each posts.filter((p) => !hidden.has(p.id)) as post (post.id)}
				<li class="post" class:remote={post.source === 'remote'}>
					<div class="byline">
						<Avatar author={post.author} sourceName={post.sourceName} />
						<strong>{post.sourceName ?? post.author.displayName}</strong>
						<a class="handle" href="/u/{post.author.handle}">@{post.author.handle}</a>
						<span class="kind">{post.source}</span>
						<a class="permalink" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
						<FeedIcon author={post.author} sourceName={post.sourceName} sourceFeedUrl={post.sourceFeedUrl} />
					</div>
					{#if post.title}<h2 class="title">{post.title}</h2>{/if}
					<PostBody {post} />
					{#if post.replyCount}
						<a
							class="wedge"
							class:light={!!expanded[post.id]}
							href="/post/{post.id}"
							role="button"
							aria-expanded={!!expanded[post.id]}
							onclick={(e) => {
								e.preventDefault()
								toggleWedge(post.id)
							}}><span class="glyph" aria-hidden="true">▸</span>{expanded[post.id] ? 'Hide replies' : `${post.replyCount} ${post.replyCount === 1 ? 'reply' : 'replies'}`}</a>
					{/if}
					{#if !(post.replyCount || post.threadRootId || post.inReplyToPostId)}
						<a class="source" href="/post/{post.id}">Reply</a>
					{/if}
					{#if post.inReplyTo && !post.inReplyToPostId && post.inReplyTo.startsWith('http')}
						<a class="source" href={post.inReplyTo} rel="noreferrer">in reply to ↗</a>
					{/if}
					{#if post.source === 'remote' && post.url}<a class="source" href={post.url} rel="noreferrer">{URL.parse(post.url)?.hostname ?? 'source'}</a>{/if}
					{#if expanded[post.id]}
						<ReplyTree thread={expanded[post.id]} parentId={post.id} />
					{/if}
				</li>
			{/each}
		</ul>

		{#if data.nextCursor}
			<a class="older" href="/?before={encodeURIComponent(data.nextCursor)}">Older posts</a>
		{/if}
	</main>

	<aside class="meta">
		<details class="panel" open>
			<summary>About</summary>
			<p>
				One timeline where people who post here and people who post on their own site are equal
				citizens. Local posts appear live; remote feeds are polled in.
			</p>
			<p><a href="https://textcasting.org" rel="noreferrer">Textcasting</a></p>
		</details>

		<details class="panel" open>
			<summary>Feed</summary>
			<p class="feed-widget">
				<a class="feed-badge" href="/users/rss.xml" target="_blank" rel="noreferrer" aria-label="All posts — RSS feed">
					<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
						<circle cx="2.5" cy="13.5" r="2" />
						<path d="M0 6.5v2.5a7 7 0 0 1 7 7h2.5A9.5 9.5 0 0 0 0 6.5z" />
						<path d="M0 1v2.5A12.5 12.5 0 0 1 12.5 16H15A15 15 0 0 0 0 1z" />
					</svg>
				</a>
				<a href="/users/rss.xml" target="_blank" rel="noreferrer">All posts · RSS</a>
			</p>
		</details>

		{#if peerHosts.length}
			<details class="panel" open>
				<summary>Connected instances</summary>
				<!-- Textcasting peers only: remote feeds whose items carry
				     source:markdown — instances that thread and interop with us. -->
				<ul class="peer-list">
					{#each peerHosts as p (p.host)}
						<li>
							<a href="https://{p.host}/" rel="noreferrer">{p.host}</a>
							<span class="badge-kind">{p.feeds} {p.feeds === 1 ? 'feed' : 'feeds'}</span>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</aside>
</div>
