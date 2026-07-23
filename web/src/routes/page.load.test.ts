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
		async (..._args: unknown[]) => new Response(JSON.stringify({ timeline: [entry('p1', 'hello')], nextCursor: 'ts~p1' }), { status: 200 })
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
	expect(String(fetch.mock.calls[0][0])).toContain('top_level=1')
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
	expect(String(fetch.mock.calls[0][0])).toContain('top_level=1')
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
	expect(calls.some((s) => s.includes('top_level=1'))).toBe(true)
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
	const calls = fetch.mock.calls.map((c) => String(c[0]))
	expect(calls.some((s) => s.includes('/follows'))).toBe(false)
	expect(calls.some((s) => s.includes('top_level=1'))).toBe(true)
	expect(result.tab).toBe('personal')
	expect(result.followIds).toBeUndefined()
})

test('explicit ?tab=local filters by source; guest-on-personal keeps the public firehose', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 }))
	const local = (await load({ fetch, url: new URL('http://x/?tab=local'), parent: async () => ({ me: null }) } as never)) as { tab: string }
	const localCalls = fetch.mock.calls.map((c) => String(c[0]))
	expect(localCalls.some((s) => s.includes('source=local'))).toBe(true)
	expect(localCalls.some((s) => s.includes('top_level=1'))).toBe(true)
	expect(local.tab).toBe('local')
	const guest = (await load({ fetch, url: new URL('http://x/?tab=personal'), parent: async () => ({ me: null }) } as never)) as { tab: string }
	expect(guest.tab).toBe('public')
	const allCalls = fetch.mock.calls.map((c) => String(c[0]))
	expect(allCalls.some((s) => s.includes('followed_by'))).toBe(false)
	expect(allCalls.some((s) => s.includes('top_level=1'))).toBe(true)
})

test('explicit ?tab=federated filters by feed_type and requests top-level mode', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 }))
	const result = (await load({ fetch, url: new URL('http://x/?tab=federated'), parent: async () => ({ me: null }) } as never)) as { tab: string }
	const calls = fetch.mock.calls.map((c) => String(c[0]))
	expect(calls.some((s) => s.includes('feed_type=instance'))).toBe(true)
	expect(calls.some((s) => s.includes('top_level=1'))).toBe(true)
	expect(result.tab).toBe('federated')
})

// --- v2 source registry (RSC_SOURCE_MODEL_V2) -------------------------------
// The capability reading is memoized per module instance, so each case below
// imports a FRESH +page.server.ts rather than adding a production reset hook.

const isCap = (u: unknown) => String(u).includes('/capabilities')

test('with the capability on, home mints a subscribe command id and keeps only local follow ids', async () => {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	const fetch = vi.fn(async (url: string | URL) =>
		isCap(url)
			? new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
			: String(url).includes('/follows')
				? new Response(
						JSON.stringify({
							following: [
								{ kind: 'local', id: 'f1', handle: 'w', displayName: 'W' },
								{ kind: 'source', sourceId: 's1', url: 'https://ex.com/f.xml', displayName: 'Ex' }
							]
						}),
						{ status: 200 }
					)
				: new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 })
	)
	const result = (await load({ fetch, url: new URL('http://x/'), parent: async () => ({ me: meOf('alice') }) } as never)) as {
		sourceModelV2?: boolean
		subscribeCommandId?: string
		followIds?: string[]
		coreDown?: boolean
	}
	// The capability NEVER runs ahead of the legacy call it rides with.
	expect(String(fetch.mock.calls[0][0])).toContain('/timeline')
	expect(result.sourceModelV2).toBe(true)
	expect(result.subscribeCommandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
	expect(result.followIds).toEqual(['me1', 'f1']) // a v2 source carries no local user id
	expect(result.coreDown).toBeUndefined()
})

test('a capability failure degrades home to legacy — never coreDown — and is retried next request', async () => {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	const fetch = vi.fn(async (url: string | URL) => {
		if (isCap(url)) throw new Error('no /capabilities on this core')
		return new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 })
	})
	const event = { fetch, url: new URL('http://x/'), parent: async () => ({ me: null }) }
	const first = (await load(event as never)) as { coreDown?: boolean; sourceModelV2?: boolean; subscribeCommandId?: string }
	expect(first.coreDown).toBeUndefined() // legacy is exactly what OFF is
	expect(first.sourceModelV2).toBeUndefined()
	expect(first.subscribeCommandId).toBeUndefined()
	const capCalls = () => fetch.mock.calls.filter((c) => isCap(c[0])).length
	expect(capCalls()).toBe(1)
	await load(event as never)
	expect(capCalls()).toBe(2) // a failure is never cached as sticky state
})
