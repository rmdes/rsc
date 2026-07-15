import { test, expect, vi } from 'vitest'
import { getTimeline } from './api.ts'

test('getTimeline calls the core /timeline and returns entries', async () => {
	const f = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					timeline: [
						{
							id: 'p1',
							title: null,
							content: 'hi',
							url: null,
							publishedAt: '',
							source: 'local',
							author: { handle: 'a', displayName: 'A', kind: 'local' }
						}
					]
				}),
				{ status: 200 }
			)
	)
	const tl = await getTimeline(f as unknown as typeof fetch)
	expect(tl[0].content).toBe('hi')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/timeline')
})
