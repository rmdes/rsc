<script lang="ts">
	import type { TimelineEntry } from './types.ts'

	let { onPost }: { onPost: (entry: TimelineEntry) => void } = $props()

	$effect(() => {
		const es = new EventSource('/stream')
		es.addEventListener('post', (ev) => {
			try {
				onPost(JSON.parse((ev as MessageEvent).data))
			} catch {
				// ignore malformed frames
			}
		})
		return () => es.close()
	})
</script>
