<script lang="ts">
	import type { PageData } from './$types'
	import Avatar from '$lib/Avatar.svelte'
	import PostBody from '$lib/PostBody.svelte'
	import EditedMarker from '$lib/EditedMarker.svelte'
	import ReplyContext from '$lib/ReplyContext.svelte'
	import RelativeTime from '$lib/RelativeTime.svelte'

	let { data }: { data: PageData } = $props()
	// Publisher activity is snapshot-only (no live stream, no follow, no feed
	// subscribe — the safe canonical feed URL is a plain external link). The
	// name is presentation evidence, never identity; Svelte HTML-escapes it.
</script>

<svelte:head><title>{data.publisher.displayName} — RSC</title></svelte:head>

<div class="lens">
	<div>
		<h1>{data.publisher.displayName} <span class="badge-kind">publisher</span></h1>
		<p class="subnav">
			<a href={data.publisher.canonicalFeedUrl} target="_blank" rel="noreferrer">canonical feed ↗</a>
		</p>
	</div>

	<ul class="timeline">
		{#each data.timeline as post (post.id)}
			<li class="post" class:remote={post.source === 'remote'}>
				<div class="byline">
					<Avatar author={post.author} sourceName={null} />
					<strong>{post.author.displayName}</strong>
					<a class="permalink" id="by-{post.id}" href="/post/{post.id}"><RelativeTime datetime={post.publishedAt} /></a>
					<EditedMarker {post} />
				</div>
				{#if post.title}<h2 class="title">{post.title}</h2>{/if}
				<PostBody {post} />
				{#if post.replyCount}
					<a class="source" href="/post/{post.id}">{post.replyCount} {post.replyCount === 1 ? 'reply' : 'replies'}</a>
				{/if}
				{#if !post.inReplyToPostId && post.replyContextAuthor}
					<ReplyContext author={post.replyContextAuthor} snippet={post.replyContextSnippet} url={post.inReplyTo?.startsWith('http') ? post.inReplyTo : null} />
				{/if}
				{#if post.source === 'remote' && post.url}<a class="source" href={post.url} rel="noreferrer">{URL.parse(post.url)?.hostname ?? 'source'}</a>{/if}
			</li>
		{:else}
			<li class="timeline-empty">No posts from this publisher yet.</li>
		{/each}
	</ul>

	{#if data.nextCursor}
		<a class="older" href="/p/{encodeURIComponent(data.publisher.id)}?before={encodeURIComponent(data.nextCursor)}">Older posts</a>
	{/if}
</div>
