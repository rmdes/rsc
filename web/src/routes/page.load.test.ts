import { test, expect, vi } from 'vitest'
import { load } from './+page.server.ts'
import type { TimelineEntry } from '$lib/types'

test('load returns the timeline from the core API', async () => {
	const fetch = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					timeline: [
						{
							id: 'p1',
							title: null,
							content: 'hello',
							url: null,
							publishedAt: '',
							source: 'local',
							author: { handle: 'a', displayName: 'A', kind: 'local' }
						},
						{
							id: 'p2',
							title: 'A title',
							content: 'world',
							url: 'https://example.com/p2',
							publishedAt: '',
							source: 'remote',
							author: { handle: 'b', displayName: 'B', kind: 'remote' }
						}
					]
				}),
				{ status: 200 }
			)
	)
	const result = (await load({ fetch } as never)) as { timeline: TimelineEntry[] }
	expect(result.timeline[0].content).toBe('hello')
	expect(result.timeline[0].title).toBeNull()
	expect(result.timeline[1].title).toBe('A title')
})

test('load returns an empty timeline with coreDown when the core is unreachable', async () => {
	const fetch = vi.fn(async () => {
		throw new Error('fetch failed')
	})
	const result = await load({ fetch } as never)
	expect(result).toEqual({ timeline: [], coreDown: true })
})
