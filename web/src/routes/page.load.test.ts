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
	author: { id: 'u1', handle: 'a', displayName: 'A', kind: 'local' }
})

test('load returns the first timeline page with isFirstPage and nextCursor', async () => {
	const fetch = vi.fn(
		async () => new Response(JSON.stringify({ timeline: [entry('p1', 'hello')], nextCursor: 'ts~p1' }), { status: 200 })
	)
	const result = (await load({ fetch, url: new URL('http://x/'), parent: async () => ({ me: null }) } as never)) as {
		timeline: TimelineEntry[]
		nextCursor: string | null
		isFirstPage: boolean
		tab: string
	}
	expect(result.timeline[0].content).toBe('hello')
	expect(result.nextCursor).toBe('ts~p1')
	expect(result.isFirstPage).toBe(true)
	expect(result.tab).toBe('public')
})

test('load passes ?before= through to the core call and clears isFirstPage', async () => {
	const fetch = vi.fn(
		async (..._args: unknown[]) => new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 })
	)
	const result = (await load({ fetch, url: new URL('http://x/?before=ts~p9'), parent: async () => ({ me: null }) } as never)) as {
		isFirstPage: boolean
		nextCursor: string | null
		tab: string
	}
	expect(String(fetch.mock.calls[0][0])).toContain('before=ts~p9')
	expect(result.isFirstPage).toBe(false)
	expect(result.nextCursor).toBeNull()
	expect(result.tab).toBe('public')
})

test('load returns an empty timeline with coreDown when the core is unreachable', async () => {
	const fetch = vi.fn(async () => {
		throw new Error('fetch failed')
	})
	const result = await load({ fetch, url: new URL('http://x/'), parent: async () => ({ me: null }) } as never)
	expect(result).toEqual({ timeline: [], nextCursor: null, isFirstPage: true, coreDown: true, peers: [], tab: 'public' })
})

const meOf = (handle: string, isAnonymous = false) => ({
	user: { id: 'me1', handle, displayName: handle, kind: 'local' as const },
	isAnonymous
})

test('registered default resolves to personal: followed_by filter, self-first followIds, instances excluded', async () => {
	const fetch = vi.fn(async (url: string | URL) =>
		String(url).includes('/follows')
			? new Response(
					JSON.stringify({
						following: [
							{ id: 'f1', handle: 'w', displayName: 'W', kind: 'remote', feedType: 'webfeed' },
							{ id: 'f2', handle: 'i', displayName: 'I', kind: 'remote', feedType: 'instance' }
						]
					}),
					{ status: 200 }
				)
			: new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 })
	)
	const result = (await load({ fetch, url: new URL('http://x/'), parent: async () => ({ me: meOf('alice') }) } as never)) as {
		tab: string
		followIds?: string[]
	}
	const calls = fetch.mock.calls.map((c) => String(c[0]))
	expect(calls.some((s) => s.includes('followed_by=alice'))).toBe(true)
	expect(result.tab).toBe('personal')
	expect(result.followIds).toEqual(['me1', 'f1'])
})

test('paginated personal load skips the follows fetch', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 }))
	const result = (await load({
		fetch,
		url: new URL('http://x/?tab=personal&before=ts~p9'),
		parent: async () => ({ me: meOf('alice') })
	} as never)) as { tab: string; followIds?: string[] }
	expect(fetch.mock.calls.map((c) => String(c[0])).some((s) => s.includes('/follows'))).toBe(false)
	expect(result.tab).toBe('personal')
	expect(result.followIds).toBeUndefined()
})

test('explicit ?tab=local filters by source; guest-on-personal keeps the public firehose', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 }))
	const local = (await load({ fetch, url: new URL('http://x/?tab=local'), parent: async () => ({ me: null }) } as never)) as { tab: string }
	expect(fetch.mock.calls.map((c) => String(c[0])).some((s) => s.includes('source=local'))).toBe(true)
	expect(local.tab).toBe('local')
	const guest = (await load({ fetch, url: new URL('http://x/?tab=personal'), parent: async () => ({ me: null }) } as never)) as { tab: string }
	expect(guest.tab).toBe('public')
	expect(fetch.mock.calls.map((c) => String(c[0])).some((s) => s.includes('followed_by'))).toBe(false)
})
