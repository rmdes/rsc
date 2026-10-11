<script lang="ts">
	import type { TimelineEntry } from './types'

	// Letter avatar — rss.chat's populateAvatar fallback (theme.js:349): an image
	// when one exists, else the initial. Feeds carry no avatar today (the channel
	// <image> is empty, no per-item element), so the initial IS the avatar; when
	// feeds start carrying one, this component grows an <img> branch.
	let { author }: { author: TimelineEntry['author'] } = $props()
	const name = $derived(author.displayName)
	const initial = $derived((Array.from(name.trim())[0] ?? '?').toUpperCase())
</script>

<span class="avatar" aria-hidden="true">{initial}</span>
