<script lang="ts">
	import type { PageData } from './$types'
	import type { TimelineEntry } from '$lib/types'
	import ReplyTree from '$lib/ReplyTree.svelte'
	import ReplyToggle from '$lib/ReplyToggle.svelte'
	import FeedIcon from '$lib/FeedIcon.svelte'
	import PostBody from '$lib/PostBody.svelte'
	import EditedMarker from '$lib/EditedMarker.svelte'
	import ReplyContext from '$lib/ReplyContext.svelte'
	import { fetchThread } from '$lib/wedge'

	let { data }: { data: PageData } = $props()
	const kind = $derived(data.timeline[0]?.author.kind ?? null)
	// P3 (backlog): this page never got the v2 journal live stream (see the home
	// page's $effect) — snapshot-only, reload to refresh.
	const posts = $derived(data.timeline)

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
	let loading = $state<Record<string, boolean>>({})
	async function toggleReplies(id: string) {
		if (expanded[id]) {
			delete expanded[id]
			return
		}
		if (loading[id]) return
		loading[id] = true
		try {
			expanded[id] = await fetchThread(id)
		} catch {
			// Leave it closed; the href is still a live link to the conversation.
		} finally {
			delete loading[id]
		}
	}
	// Folded own-cards unfold locally — they're already loaded, no fetch.
	let stackOpen = $state<Record<string, boolean>>({})
</script>

<svelte:head>
	<title>@{data.handle} — RSC</title>
	<!-- Readers pick the FIRST alternate link: on an author page that is the
	     author's feed (remote profiles proxy-redirect to their canonical one);
	     the layout's firehose link follows as the site-wide fallback. -->
	<link rel="alternate" type="application/rss+xml" title="@{data.handle}" href="/u/{data.handle}/feed.xml" />
</svelte:head>

<div class="lens">
	<header class="page-head">
		<span class="kicker">Author lens{#if kind} · {kind}{/if}</span>
		<h1>@{data.handle}</h1>
		<p class="subnav">
			<a href="/u/{data.handle}/following">Following &amp; followers</a>
			{#if data.timeline[0]}<FeedIcon author={data.timeline[0].author} />{/if}
		</p>
	</header>

	{#if data.stats}
		<dl class="lens-stats">
			<div><dd class="n">{data.stats.posts}</dd><dt class="k">Posts</dt></div>
			<div><dd class="n">{data.stats.following}</dd><dt class="k">Following</dt></div>
			<div><dd class="n">{data.stats.followers}</dd><dt class="k">Followers</dt></div>
		</dl>
	{/if}

	{#if data.coreDown}<p class="notice" role="alert">Can't load this page right now — try again shortly.</p>{/if}

	<ul class="timeline">
		{#each groups as { top: post, others } (post.threadRootId ?? post.id)}
			<li class="post" class:remote={post.source === 'remote'} class:stacked={others.length > 0}>
				<!-- aggregate lenses (e.g. @rsschat) carry a per-item author; the date
				     permalink lives top-right like every byline, not in the action row -->
				<div class="byline">
					{#if post.sourceName}<strong>{post.sourceName}</strong>{/if}
					<a class="permalink" id="by-{post.id}" href="/post/{post.id}"><time datetime={post.publishedAt}>{post.publishedAt.slice(0, 10)}</time></a>
					<EditedMarker {post} />
				</div>
				{#if post.title}<h2 class="title">{post.title}</h2>{/if}
				<PostBody {post} />
				{#if post.replyCount}
					<ReplyToggle
						count={post.replyCount}
						href="/post/{post.id}"
						expanded={!!expanded[post.id]}
						busy={!!loading[post.id]}
						aria-describedby="by-{post.id}"
						onactivate={() => toggleReplies(post.id)}
					/>
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
						{#each others as p (p.id)}
							<li>
								<span class="k"><time datetime={p.publishedAt}>{p.publishedAt.slice(5, 10)}</time></span>
								<div>
									{#if p.title}<h3 class="title">{p.title}</h3>{/if}
									<PostBody post={p} />
									{#if p.source === 'local' && data.me?.user.id === p.author.id}
										<a class="edit" href="/post/{p.id}/edit">Edit</a>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</li>
		{:else}
			<li class="timeline-empty">Nothing to show — @{data.handle} hasn't posted yet, or the timeline couldn't load.</li>
		{/each}
	</ul>

	{#if data.nextCursor}
		<a class="older" href="/u/{data.handle}?before={encodeURIComponent(data.nextCursor)}">Older posts</a>
	{/if}
</div>
