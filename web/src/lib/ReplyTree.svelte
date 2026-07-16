<script lang="ts">
	import type { TimelineEntry } from './types'
	import { childrenOf } from './wedge'
	import { plaintext } from './plaintext'
	import { toggleClamp } from './expand'
	import Linkified from './Linkified.svelte'
	import ReplyTree from './ReplyTree.svelte'

	let { thread, parentId }: { thread: TimelineEntry[]; parentId: string } = $props()
	let open = $state<Record<string, boolean>>({})
	const kids = $derived(childrenOf(thread, parentId))
</script>

<ul class="replies">
	{#each kids as reply (reply.id)}
		<li class="post" class:remote={reply.source === 'remote'}>
			<div class="byline">
				{#if childrenOf(thread, reply.id).length > 0}
					<a
						class="wedge"
						class:light={open[reply.id]}
						href="/post/{reply.id}"
						role="button"
						aria-expanded={!!open[reply.id]}
						aria-label="{open[reply.id] ? 'Hide' : 'Show'} replies"
						onclick={(e) => {
							e.preventDefault()
							open[reply.id] = !open[reply.id]
						}}>▸</a
					>
				{:else}
					<span class="wedge light" aria-hidden="true">▸</span>
				{/if}
				<strong>{reply.author.displayName}</strong>
				<a class="handle" href="/u/{reply.author.handle}">@{reply.author.handle}</a> {#if reply.sourceName}<span class="via">from {reply.sourceName}</span>{/if}
			</div>
			{#if reply.title}<h3 class="title">{reply.title}</h3>{/if}
			<!-- click-to-expand is a pointer convenience; keyboard/AT users reach the full text via the conversation link -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<p class="body" onclick={toggleClamp}><Linkified text={plaintext(reply.content)} /></p>
			<a class="source" href="/post/{reply.id}">Reply</a>
			{#if reply.url}<a class="source" href={reply.url} rel="noreferrer">source</a>{/if}
			{#if open[reply.id]}
				<ReplyTree {thread} parentId={reply.id} />
			{/if}
		</li>
	{/each}
</ul>
