<script lang="ts">
	import type { TimelineEntry } from './types'

	// Letter avatar — rss.chat's populateAvatar fallback (theme.js:349): an image
	// when one exists, else the initial. Feeds carry no avatar today (the channel
	// <image> is empty, no per-item element), so the initial IS the avatar; when
	// feeds start carrying one, this component grows an <img> branch.
	let {
		author,
		sourceName = null
	}: { author: TimelineEntry['author']; sourceName?: string | null } = $props()
	const name = $derived(sourceName ?? author.displayName)
	const initial = $derived((Array.from(name.trim())[0] ?? '?').toUpperCase())
</script>

<span class="avatar" aria-hidden="true">{initial}</span>
