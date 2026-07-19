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
	import EditedMarker from '$lib/EditedMarker.svelte'
	import ReplyContext from '$lib/ReplyContext.svelte'
	import { mergeIncoming } from '$lib/live'
	import { hiddenIds, fetchThread } from '$lib/wedge'
	import { enhance } from '$app/forms'
	import { confirmSubmit } from '$lib/confirm'
	import { keepEvent, type Lens } from '$lib/lens'
	import { TABS } from '$lib/tabs'

	let { data, form }: { data: PageData; form: ActionData } = $props()

	let live = $state<TimelineEntry[]>([])
	let edited = $state<Record<string, TimelineEntry>>({})
	const pageIds = $derived(new Set(data.timeline.map((p) => p.id)))
	const posts = $derived([...live, ...data.timeline].map((p) => edited[p.id] ?? p))

	// Public river is lensless; the stream is a firehose, so every other tab
	// filters incoming SSE events client-side (same pattern as author/thread pages).
	const lens = $derived.by((): Lens | null => {
		if (data.tab === 'local') return { kind: 'source', source: 'local' }
		if (data.tab === 'federated') return { kind: 'feedType', feedType: 'instance' }
		if (data.tab === 'personal') return { kind: 'followed', followIds: new Set(data.followIds ?? []) }
		return null
	})

	function onPost(entry: TimelineEntry) {
		if (lens && !keepEvent(entry, lens)) return
		const r = mergeIncoming(live, edited, entry, pageIds)
		live = r.live
		edited = r.edited
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
			action="?tab={data.tab}&/compose"
			title="New post"
			submitLabel="Post"
			placeholder="what's happening?"
		/>

		{#if data.me && !data.me.isAnonymous}
			<details class="panel">
				<summary>Add remote user</summary>
				<form method="POST" action="?tab={data.tab}&/addRemote" class="add-remote">
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
		<nav class="tabs" aria-label="Timeline">
			{#each TABS as t (t)}
				<a href="/?tab={t}" aria-current={data.tab === t ? 'page' : undefined}>{t}</a>
			{/each}
		</nav>

		{#if data.coreDown}
			<p class="notice" role="alert">Core API unreachable — is the core server running?</p>
		{/if}

		{#if data.addedFeed}
			<p class="notice confirm" role="status">Now monitoring <strong>@{data.addedFeed}</strong> — its posts appear in your timeline as they publish.</p>
		{/if}

		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

		{#if data.tab === 'personal' && posts.length === 0 && !data.coreDown}
			<p class="notice">Your personal river is empty — <a href="/u/{data.me?.user.handle}/following">follow people and feeds</a> to fill it.</p>
		{/if}

		<ul class="timeline">
			{#each posts.filter((p) => !hidden.has(p.id)) as post (post.id)}
				<li class="post" class:remote={post.source === 'remote'}>
					<div class="byline">
						<Avatar author={post.author} sourceName={post.sourceName} />
						<strong>{post.sourceName ?? post.author.displayName}</strong>
						<a class="handle" href="/u/{post.author.handle}">@{post.author.handle}</a>
						<span class="kind">{post.source}</span>
						<a class="permalink" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
						<EditedMarker {post} />
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
					{#if !post.inReplyToPostId && post.replyContextAuthor}
						<ReplyContext author={post.replyContextAuthor} snippet={post.replyContextSnippet} url={post.inReplyTo?.startsWith('http') ? post.inReplyTo : null} />
					{:else if post.inReplyTo && !post.inReplyToPostId && post.inReplyTo.startsWith('http')}
						<a class="source" href={post.inReplyTo} rel="noreferrer">in reply to ↗</a>
					{/if}
					{#if post.source === 'remote' && post.url}<a class="source" href={post.url} rel="noreferrer">{URL.parse(post.url)?.hostname ?? 'source'}</a>{/if}
					{#if post.source === 'local' && data.me?.user.id === post.author.id}
						<a class="edit" href="/post/{post.id}/edit">Edit</a>
					{/if}
					{#if data.me?.isAdmin && post.source === 'local'}
						<form method="POST" action="?tab={data.tab}&/deletePost" use:enhance={confirmSubmit('Remove this post? This can\'t be undone.')}>
							<input type="hidden" name="id" value={post.id} />
							<button class="danger-link" type="submit">Remove</button>
						</form>
					{/if}
					{#if expanded[post.id]}
						<ReplyTree thread={expanded[post.id]} parentId={post.id} />
					{/if}
				</li>
			{/each}
		</ul>

		{#if data.nextCursor}
			<a class="older" href="/?tab={data.tab}&before={encodeURIComponent(data.nextCursor)}">Older posts</a>
		{/if}
	</main>

	<aside class="meta">
		<details class="panel" open>
			<summary>About</summary>
			<p>
				Textcaster is a feeds-native social timeline: people who post here and people who post on
				their own site are equal citizens. Everything travels as RSS — posts, replies, whole
				conversations — so following, threading, and federation work with nothing but open feeds.
			</p>
			<p>
				Built on <a href="https://textcasting.org" rel="noreferrer">Textcasting</a>, inspired by Dave
				Winer's <a href="https://github.com/scripting/rss.chat" rel="noreferrer">rss.chat</a>.
			</p>
			<p><a href="https://github.com/rmdes/textcaster" rel="noreferrer">Source &amp; docs</a></p>
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

	/* Tab bar: .admin-nav pattern + focus ring. Fixed 44px row so live
	   prepends below never shift it (MASTER: jank-free prepends). */
	.tabs {
		display: flex;
		gap: var(--space-md);
		border-bottom: 1px solid var(--color-border);
		margin-bottom: var(--space-md);
	}

	.tabs a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 var(--space-xs);
		color: var(--color-secondary);
		font-weight: 600;
		text-decoration: none;
		text-transform: capitalize;
		border-bottom: 2px solid transparent;
		transition:
			color 200ms,
			border-color 200ms;
	}

	.tabs a:hover {
		color: var(--color-foreground);
	}

	.tabs a:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-ring) 15%, transparent);
	}

	.tabs a[aria-current='page'] {
		color: var(--color-foreground);
		border-bottom-color: var(--color-accent);
	}
</style>
