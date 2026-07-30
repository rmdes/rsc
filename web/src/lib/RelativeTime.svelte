<script lang="ts">
	import { relativeLabel, absoluteLabel, nextDelayMs } from './relative-time.ts'

	let { datetime }: { datetime: string } = $props()

	// Derived, not assigned from the effect: a reused instance handed a new
	// `datetime` recomputes at once instead of waiting out the pending
	// timeout, which can be 5 minutes off.
	let now = $state(Date.now())
	const label = $derived(relativeLabel(datetime, now))

	// Client-side ticking only — $effect never runs during SSR, so the
	// $derived above is the entire no-JS render; this effect is pure
	// progressive enhancement. Self-rescheduling setTimeout (not a fixed
	// setInterval) because the ideal cadence changes as the item ages
	// (see nextDelayMs) — a fixed interval can't adapt its own period.
	$effect(() => {
		const iso = datetime
		let timeoutId: ReturnType<typeof setTimeout> | undefined

		function schedule(): void {
			const delay = nextDelayMs(iso, Date.now())
			if (delay === null) return
			timeoutId = setTimeout(() => {
				now = Date.now()
				schedule()
			}, delay)
		}

		schedule()

		return () => {
			if (timeoutId !== undefined) clearTimeout(timeoutId)
		}
	})
</script>

<time {datetime} title={absoluteLabel(datetime)}>{label}</time>
