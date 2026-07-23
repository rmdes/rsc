<script lang="ts">
	import type { HTMLAnchorAttributes } from 'svelte/elements'
	import { replyToggleLabel, replyToggleClick } from './reply-toggle'

	// Compact reply count. It is a real anchor to the conversation first: with
	// no JS the click navigates to /post/<id>; with JS `onactivate` expands the
	// thread inline instead. `count` is whatever the server last said — the
	// caller never increments it.
	// `rest` exists so the caller can make the name row-unique with
	// aria-describedby (the label alone repeats across rows); the five pinned
	// props are the contract. `{...rest}` is spread FIRST on the <a> below so a
	// caller-supplied class/aria-expanded/aria-busy/aria-label in rest can never
	// clobber the computed value — the pinned attributes always win.
	let {
		count,
		href,
		expanded,
		busy = false,
		onactivate,
		...rest
	}: {
		count: number
		href: string
		expanded: boolean
		busy?: boolean
		onactivate: () => void
	} & HTMLAnchorAttributes = $props()
</script>

<a
	{...rest}
	class="reply-toggle"
	{href}
	aria-expanded={expanded}
	aria-busy={busy || undefined}
	aria-label={replyToggleLabel(count, expanded, busy)}
	onclick={(e) => replyToggleClick(e, busy, onactivate)}
>
	<svg
		aria-hidden="true"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		><path
			d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.5 8.5z"
		/></svg
	>
	<span aria-hidden="true">{count}</span>
</a>
