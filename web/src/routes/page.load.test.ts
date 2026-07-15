import { test, expect, vi } from 'vitest'
import { load } from './+page.server.ts'
import type { TimelineEntry } from '$lib/types'

const entry = (id: string, content: string) => ({
	id,
	title: null,
	content,
	url: null,
	publishedAt: '',
	source: 'local',
	author: { handle: 'a', displayName: 'A', kind: 'local' }
})

test('load returns the first timeline page with isFirstPage and nextCursor', async () => {
	const fetch = vi.fn(
		async () => new Response(JSON.stringify({ timeline: [entry('p1', 'hello')], nextCursor: 'ts~p1' }), { status: 200 })
	)
	const result = (await load({ fetch, url: new URL('http://x/') } as never)) as {
		timeline: TimelineEntry[]
		nextCursor: string | null
		isFirstPage: boolean
	}
	expect(result.timeline[0].content).toBe('hello')
	expect(result.nextCursor).toBe('ts~p1')
	expect(result.isFirstPage).toBe(true)
})

test('load passes ?before= through to the core call and clears isFirstPage', async () => {
	const fetch = vi.fn(
		async (..._args: unknown[]) => new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 })
	)
	const result = (await load({ fetch, url: new URL('http://x/?before=ts~p9') } as never)) as {
		isFirstPage: boolean
		nextCursor: string | null
	}
	expect(String(fetch.mock.calls[0][0])).toContain('before=ts~p9')
	expect(result.isFirstPage).toBe(false)
	expect(result.nextCursor).toBeNull()
})

test('load returns an empty timeline with coreDown when the core is unreachable', async () => {
	const fetch = vi.fn(async () => {
		throw new Error('fetch failed')
	})
	const result = await load({ fetch, url: new URL('http://x/') } as never)
	expect(result).toEqual({ timeline: [], nextCursor: null, isFirstPage: true, coreDown: true })
})
