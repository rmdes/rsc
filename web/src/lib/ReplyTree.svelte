<script lang="ts">
	import type { TimelineEntry } from './types'
	import { childrenOf } from './wedge'
	import PostBody from './PostBody.svelte'
	import Avatar from './Avatar.svelte'
	import ReplyTree from './ReplyTree.svelte'
	import ReplyToggle from './ReplyToggle.svelte'
	import EditedMarker from './EditedMarker.svelte'
	import ThreadPlaceholder from './ThreadPlaceholder.svelte'

	let {
		thread,
		parentId,
		openAll = false,
		highlightId = null
	}: {
		thread: TimelineEntry[]
		parentId: string
		openAll?: boolean // conversation page: the whole tree starts unfolded
		highlightId?: string | null
	} = $props()
	let open = $state<Record<string, boolean>>({})
	const isOpen = (id: string) => open[id] ?? openAll
	const kids = $derived(childrenOf(thread, parentId))
</script>

<ul class="replies">
	{#each kids as reply (reply.id)}
		{#if reply.placeholder}
			<!-- D11: an unavailable ancestor — a neutral marker, then its subtree -->
			<li class="post placeholder">
				<ThreadPlaceholder />
				<ReplyTree {thread} parentId={reply.id} {openAll} {highlightId} />
			</li>
		{:else}
		<li class="post" class:remote={reply.source === 'remote'} class:highlight={reply.id === highlightId}>
			<div class="byline">
				<Avatar author={reply.author} sourceName={reply.sourceName} />
				<strong>{reply.sourceName ?? reply.author.displayName}</strong>
				{#if reply.publisherId}
					<!-- v2 remote publisher: /p, not /u (which stays local-account only) -->
					<a class="handle" id="rt-by-{reply.id}" href="/p/{encodeURIComponent(reply.publisherId)}">{reply.author.displayName}</a>
				{:else if reply.author.handle}
					<a class="handle" id="rt-by-{reply.id}" href="/u/{reply.author.handle}">@{reply.author.handle}</a>
				{/if}
				<a class="permalink" href="/post/{reply.id}"><time datetime={reply.publishedAt}>{reply.publishedAt.slice(0, 10)}</time></a>
				<EditedMarker post={reply} />
			</div>
			{#if reply.title}<h3 class="title">{reply.title}</h3>{/if}
			<PostBody post={reply} />
			{#if childrenOf(thread, reply.id).length > 0}
				<ReplyToggle
					count={childrenOf(thread, reply.id).length}
					href="/post/{reply.id}"
					expanded={isOpen(reply.id)}
					busy={false}
					aria-describedby="rt-by-{reply.id}"
					onactivate={() => (open[reply.id] = !isOpen(reply.id))}
				/>
			{/if}
			<a class="source" href="/post/{reply.id}">Reply</a>
			{#if reply.source === 'remote' && reply.url}<a class="source" href={reply.url} rel="noreferrer">source</a>{/if}
			{#if isOpen(reply.id)}
				<ReplyTree {thread} parentId={reply.id} {openAll} {highlightId} />
			{/if}
		</li>
		{/if}
	{/each}
</ul>
