<script lang="ts">
	import { relativeLabel, absoluteLabel, nextDelayMs } from './relative-time.ts'

	let { datetime }: { datetime: string } = $props()

	let label = $state(relativeLabel(datetime, Date.now()))

	// Client-side ticking only — $effect never runs during SSR, so the
	// $state initializer above is the entire no-JS render; this effect is
	// pure progressive enhancement. Self-rescheduling setTimeout (not a
	// fixed setInterval) because the ideal cadence changes as the item
	// ages (see nextDelayMs) — a fixed interval can't adapt its own period.
	$effect(() => {
		const iso = datetime
		let timeoutId: ReturnType<typeof setTimeout> | undefined

		function tick(): void {
			label = relativeLabel(iso, Date.now())
			const delay = nextDelayMs(iso, Date.now())
			if (delay !== null) timeoutId = setTimeout(tick, delay)
		}

		const firstDelay = nextDelayMs(iso, Date.now())
		if (firstDelay !== null) timeoutId = setTimeout(tick, firstDelay)

		return () => {
			if (timeoutId !== undefined) clearTimeout(timeoutId)
		}
	})
</script>

<time {datetime} title={absoluteLabel(datetime)}>{label}</time>
