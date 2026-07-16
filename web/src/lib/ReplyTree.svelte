<script lang="ts">
	import type { TimelineEntry } from './types'
	import { childrenOf } from './wedge'
	import { plaintext } from './plaintext'
	import { toggleClamp } from './expand'
	import Linkified from './Linkified.svelte'
	import Avatar from './Avatar.svelte'
	import ReplyTree from './ReplyTree.svelte'

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
		<li class="post" class:remote={reply.source === 'remote'} class:highlight={reply.id === highlightId}>
			<div class="byline">
				<Avatar author={reply.author} sourceName={reply.sourceName} />
				<strong>{reply.sourceName ?? reply.author.displayName}</strong>
				{#if !reply.sourceName}
					<a class="handle" href="/u/{reply.author.handle}">@{reply.author.handle}</a>
				{/if}
			</div>
			{#if reply.title}<h3 class="title">{reply.title}</h3>{/if}
			<!-- click-to-expand is a pointer convenience; keyboard/AT users reach the full text via the conversation link -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<p class="body" onclick={toggleClamp}><Linkified text={plaintext(reply.content)} /></p>
			{#if childrenOf(thread, reply.id).length > 0}
				{@const n = childrenOf(thread, reply.id).length}
				<a
					class="wedge"
					class:light={isOpen(reply.id)}
					href="/post/{reply.id}"
					role="button"
					aria-expanded={isOpen(reply.id)}
					onclick={(e) => {
						e.preventDefault()
						open[reply.id] = !isOpen(reply.id)
					}}><span class="glyph" aria-hidden="true">▸</span>{isOpen(reply.id) ? 'Hide replies' : `${n} ${n === 1 ? 'reply' : 'replies'}`}</a>
			{/if}
			<a class="source" href="/post/{reply.id}">Reply</a>
			{#if reply.url}<a class="source" href={reply.url} rel="noreferrer">source</a>{/if}
			{#if isOpen(reply.id)}
				<ReplyTree {thread} parentId={reply.id} {openAll} {highlightId} />
			{/if}
		</li>
	{/each}
</ul>
