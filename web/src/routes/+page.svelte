<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import ReplyTree from '$lib/ReplyTree.svelte'
	import FeedIcon from '$lib/FeedIcon.svelte'
	import { plaintext } from '$lib/plaintext'
	import { hiddenIds, fetchThread } from '$lib/wedge'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	let live = $state<TimelineEntry[]>([])
	const posts = $derived([...live, ...data.timeline])

	function onPost(entry: TimelineEntry) {
		if (!posts.some((p) => p.id === entry.id)) live = [entry, ...live]
	}

	// Open wedges: post id → its flat thread. Revealed subtrees hide from the
	// top level (a post never shows twice) and return when the wedge folds.
	let expanded = $state<Record<string, TimelineEntry[]>>({})
	const hidden = $derived(hiddenIds(expanded))
	async function toggleWedge(id: string) {
		if (expanded[id]) delete expanded[id]
		else expanded[id] = await fetchThread(id)
	}
</script>

{#if data.isFirstPage}
	<LiveTimeline {onPost} />
{/if}

<div class="shell">
	<aside class="tools">
		<header class="masthead">
			<a href="/">Textcaster</a>
			<ThemeToggle />
		</header>

		<details class="panel" open>
			<summary>New post</summary>
			<form method="POST" action="?/compose" class="composer">
				<input name="handle" placeholder="your handle" required />
				<input name="displayName" placeholder="display name (optional)" />
				<textarea name="content" placeholder="what's happening?" required></textarea>
				<button>Post</button>
			</form>
		</details>

		<details class="panel">
			<summary>Add remote user</summary>
			<form method="POST" action="?/addRemote" class="add-remote">
				<input name="handle" placeholder="remote handle" required />
				<input name="displayName" placeholder="display name (optional)" />
				<input name="feedUrl" type="url" placeholder="https://their-site.com/feed.xml" required />
				<button>Add remote user</button>
			</form>
		</details>
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
						<a class="handle" href="/u/{post.author.handle}">@{post.author.handle}</a>
						<span class="kind">{post.source}</span>
						<time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time>
						<FeedIcon author={post.author} />
					</div>
					{#if post.title}<h2 class="title">{post.title}</h2>{/if}
					<p>{plaintext(post.content)}</p>
					<a class="source" href="/post/{post.id}">{post.replyCount || post.threadRootId || post.inReplyToPostId ? 'View conversation' : 'Reply'}</a>
					{#if post.inReplyTo && !post.inReplyToPostId && post.inReplyTo.startsWith('http')}
						<a class="source" href={post.inReplyTo} rel="noreferrer">in reply to ↗</a>
					{/if}
					{#if post.url}<a class="source" href={post.url} rel="noreferrer">{URL.parse(post.url)?.hostname ?? 'source'}</a>{/if}
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
	</aside>
</div>
