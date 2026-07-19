<script lang="ts">
	import type { PageData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import LiveTimeline from '$lib/LiveTimeline.svelte'
	import ThemeToggle from '$lib/ThemeToggle.svelte'
	import ReplyTree from '$lib/ReplyTree.svelte'
	import FeedIcon from '$lib/FeedIcon.svelte'
	import PostBody from '$lib/PostBody.svelte'
	import EditedMarker from '$lib/EditedMarker.svelte'
	import ReplyContext from '$lib/ReplyContext.svelte'
	import { keepEvent } from '$lib/lens'
	import { mergeIncoming } from '$lib/live'
	import { fetchThread } from '$lib/wedge'

	let { data }: { data: PageData } = $props()
	const authorId = $derived(data.timeline[0]?.author.id ?? null)
	const kind = $derived(data.timeline[0]?.author.kind ?? null)
	let live = $state<TimelineEntry[]>([])
	let edited = $state<Record<string, TimelineEntry>>({})
	const pageIds = $derived(new Set(data.timeline.map((p) => p.id)))
	const posts = $derived([...live, ...data.timeline].map((p) => edited[p.id] ?? p))

	function onPost(entry: TimelineEntry) {
		if (!authorId || !keepEvent(entry, { kind: 'author', authorId })) return
		const r = mergeIncoming(live, edited, entry, pageIds)
		live = r.live
		edited = r.edited
	}

	// An author lens shows ONE card per conversation, not one per post: the
	// author's replies fold under their thread's top card (a visible stack)
	// instead of littering the top level as duplicate-looking cards. Top card
	// is the author's root when they own it, else their latest reply there.
	// Grouping is per loaded page (a sibling behind "Older posts" merges when
	// loaded); the conversation page stays the source of truth.
	type Group = { top: TimelineEntry; others: TimelineEntry[] }
	const groups = $derived.by((): Group[] => {
		const byThread = new Map<string, TimelineEntry[]>()
		for (const p of posts) {
			const key = p.threadRootId ?? p.id
			byThread.set(key, [...(byThread.get(key) ?? []), p])
		}
		return [...byThread.values()].map((members) => {
			const top = members.find((m) => !m.threadRootId) ?? members[0]
			return { top, others: members.filter((m) => m !== top).reverse() } // oldest-first when unfolded
		})
	})

	let expanded = $state<Record<string, TimelineEntry[]>>({})
	async function toggleWedge(id: string) {
		if (expanded[id]) delete expanded[id]
		else expanded[id] = await fetchThread(id)
	}
	// Folded own-cards unfold locally — they're already loaded, no fetch.
	let stackOpen = $state<Record<string, boolean>>({})
</script>

<svelte:head>
	<title>@{data.handle} — Textcaster</title>
	<!-- Readers pick the FIRST alternate link: on an author page that is the
	     author's feed (remote profiles proxy-redirect to their canonical one);
	     the layout's firehose link follows as the site-wide fallback. -->
	<link rel="alternate" type="application/rss+xml" title="@{data.handle}" href="/u/{data.handle}/feed.xml" />
</svelte:head>

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
		{#each groups as { top: post, others } (post.threadRootId ?? post.id)}
			<li class="post" class:remote={post.source === 'remote'} class:stacked={others.length > 0}>
				<!-- aggregate lenses (e.g. @rsschat) carry a per-item author; the date
				     permalink lives top-right like every byline, not in the action row -->
				<div class="byline">
					{#if post.sourceName}<strong>{post.sourceName}</strong>{/if}
					<a class="permalink" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
					<EditedMarker {post} />
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
				{:else if others.length}
					<a
						class="wedge"
						class:light={!!stackOpen[post.id]}
						href="/post/{post.id}"
						role="button"
						aria-expanded={!!stackOpen[post.id]}
						onclick={(e) => {
							e.preventDefault()
							stackOpen[post.id] = !stackOpen[post.id]
						}}><span class="glyph" aria-hidden="true">▸</span>{stackOpen[post.id] ? 'Hide' : `${others.length} more in this conversation`}</a>
				{/if}
				{#if !(post.replyCount || post.threadRootId || post.inReplyToPostId)}
					<a class="source" href="/post/{post.id}">Reply</a>
				{/if}
				{#if !post.inReplyToPostId && post.replyContextAuthor}
					<ReplyContext author={post.replyContextAuthor} snippet={post.replyContextSnippet} url={post.inReplyTo?.startsWith('http') ? post.inReplyTo : null} />
				{:else if post.inReplyTo && !post.inReplyToPostId && post.inReplyTo.startsWith('http')}
					<a class="source" href={post.inReplyTo} rel="noreferrer">in reply to ↗</a>
				{/if}
				{#if post.source === 'remote' && post.url}<a href={post.url} rel="noreferrer">source</a>{/if}
				{#if post.source === 'local' && data.me?.user.id === post.author.id}
					<a class="edit" href="/post/{post.id}/edit">Edit</a>
				{/if}
				{#if expanded[post.id]}
					<ReplyTree thread={expanded[post.id]} parentId={post.id} />
				{:else if stackOpen[post.id]}
					<ul class="replies">
						<!-- no per-card links: the whole stack is one conversation, and the
						     top card already carries the one "View conversation" that matters -->
						{#each others as p (p.id)}
							<li class="post" class:remote={p.source === 'remote'}>
								<div class="byline">
									{#if p.sourceName}<strong>{p.sourceName}</strong>{/if}
									<a class="permalink" href="/post/{p.id}"><time datetime={p.publishedAt}>{p.publishedAt.slice(0, 10)}</time></a>
									<EditedMarker post={p} />
								</div>
								{#if p.title}<h3 class="title">{p.title}</h3>{/if}
								<PostBody post={p} />
								{#if p.source === 'local' && data.me?.user.id === p.author.id}
									<a class="edit" href="/post/{p.id}/edit">Edit</a>
								{/if}
							</li>
						{/each}
					</ul>
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
