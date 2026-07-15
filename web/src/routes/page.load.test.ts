import { test, expect, vi } from 'vitest'
import { load } from './+page.server.ts'

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
	const result = await load({ fetch } as never)
	expect(result.timeline[0].content).toBe('hello')
	expect(result.timeline[0].title).toBeNull()
	expect(result.timeline[1].title).toBe('A title')
})
