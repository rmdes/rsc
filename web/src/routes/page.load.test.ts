import { test, expect, vi } from 'vitest'
import { load } from './+page.server.ts'
import type { TimelineEntry } from '$lib/types'

// A minimal valid LogicalItemDto — the only item shape the home river accepts.
const item = (over: Record<string, unknown> = {}) => ({
	kind: 'logical_item',
	id: 'i1',
	origin: 'remote',
	parentResolutionState: 'none',
	parentLogicalItemId: null,
	threadRootId: null,
	selectedAuthor: { kind: 'remote_publisher', id: 'pub1', displayName: 'Pub One', canonicalFeedUrl: 'https://ex.com/f.xml', profileAvailable: true, attributionLevel: 'bound_single_publisher' },
	title: null,
	content: '<p>hi</p>',
	contentMarkdown: null,
	permalink: 'https://ex.com/i1',
	sourceLink: 'https://ex.com/i1',
	replyContext: null,
	enclosures: [],
	publishedAt: '2026-07-20T00:00:00.000Z',
	updatedAt: null,
	updatedAtProvenance: null,
	directReplyCount: 0,
	conversationReplyCount: 2,
	classification: { personal: false, federated: true },
	...over
})

// The logical-v2 timeline envelope core answers /timeline with.
const river = (timeline: unknown[] = [], nextCursor: string | null = null) =>
	new Response(JSON.stringify({ model: 'logical-v2', lens: { kind: 'public' }, timeline, nextCursor, journalCursor: 'jc' }), { status: 200 })

const meOf = (handle: string, isAnonymous = false) => ({
	user: { id: 'me1', handle, displayName: handle, kind: 'local' as const },
	isAnonymous
})

test('load returns the first timeline page with isFirstPage, nextCursor and a journal cursor', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => river([item()], 'ts~i1'))
	const result = (await load({ fetch, url: new URL('http://x/'), parent: async () => ({ me: null }) } as never)) as {
		timeline: TimelineEntry[]
		nextCursor: string | null
		isFirstPage: boolean
		tab: string
		journalCursor: string
		subscribeCommandId: string
	}
	expect(result.timeline[0].id).toBe('i1')
	expect(result.nextCursor).toBe('ts~i1')
	expect(result.isFirstPage).toBe(true)
	expect(result.tab).toBe('public')
	expect(result.journalCursor).toBe('jc')
	// One id per rendered subscribe form, always minted.
	expect(result.subscribeCommandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
	// The public lens carries no selector — and never a legacy one.
	expect(String(fetch.mock.calls[0][0])).not.toContain('top_level')
})

test('the v2 envelope maps onto the render shape through the ONE server sanitizer', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => river([item()], 'c1'))
	const result = (await load({ fetch, url: new URL('http://x/'), parent: async () => ({ me: null }) } as never)) as {
		timeline: Array<{ id: string; author: { displayName: string }; contentHtml?: string; publisherId?: string }>
		coreDown?: boolean
	}
	expect(result.coreDown).toBeUndefined()
	expect(result.timeline[0].author.displayName).toBe('Pub One')
	expect(result.timeline[0].publisherId).toBe('pub1')
	expect(result.timeline[0].contentHtml).toContain('<p>hi</p>')
})

test('load passes ?before= through to the core call and clears isFirstPage', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => river())
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

test('registered default resolves to personal: followed_by lens, self-first followIds, sources excluded', async () => {
	const fetch = vi.fn(async (url: string | URL) =>
		String(url).includes('/follows')
			? new Response(
					JSON.stringify({
						following: [
							{ kind: 'local', id: 'f1', handle: 'w', displayName: 'W' },
							{ kind: 'source', sourceId: 's1', url: 'https://ex.com/f.xml', displayName: 'Ex' }
						]
					}),
					{ status: 200 }
				)
			: river()
	)
	const result = (await load({ fetch, url: new URL('http://x/'), parent: async () => ({ me: meOf('alice') }) } as never)) as {
		tab: string
		followIds?: string[]
	}
	const calls = fetch.mock.calls.map((c) => String(c[0]))
	expect(calls.some((s) => s.includes('followed_by=alice'))).toBe(true)
	expect(result.tab).toBe('personal')
	expect(result.followIds).toEqual(['me1', 'f1']) // a source follow carries no local user id
})

test('paginated personal load skips the follows fetch', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => river())
	const result = (await load({
		fetch,
		url: new URL('http://x/?tab=personal&before=ts~p9'),
		parent: async () => ({ me: meOf('alice') })
	} as never)) as { tab: string; followIds?: string[] }
	const calls = fetch.mock.calls.map((c) => String(c[0]))
	expect(calls.some((s) => s.includes('/follows'))).toBe(false)
	expect(result.tab).toBe('personal')
	expect(result.followIds).toBeUndefined()
})

test('explicit ?tab=local selects the local origin lens; guest-on-personal keeps the public firehose', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => river())
	const local = (await load({ fetch, url: new URL('http://x/?tab=local'), parent: async () => ({ me: null }) } as never)) as { tab: string }
	expect(fetch.mock.calls.map((c) => String(c[0])).some((s) => s.includes('origin=local'))).toBe(true)
	expect(local.tab).toBe('local')
	const guest = (await load({ fetch, url: new URL('http://x/?tab=personal'), parent: async () => ({ me: null }) } as never)) as { tab: string }
	expect(guest.tab).toBe('public')
	expect(fetch.mock.calls.map((c) => String(c[0])).some((s) => s.includes('followed_by'))).toBe(false)
})

test('explicit ?tab=federated selects the federated lens', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => river())
	const result = (await load({ fetch, url: new URL('http://x/?tab=federated'), parent: async () => ({ me: null }) } as never)) as { tab: string }
	expect(fetch.mock.calls.map((c) => String(c[0])).some((s) => s.includes('federated=true'))).toBe(true)
	expect(result.tab).toBe('federated')
})

// Carve 2 (spec §5.6): a malformed envelope FAILS CLOSED on the PRIMARY home
// river — the LogicalContractError propagates to the load's catch and yields
// coreDown (the same "can't load this page" notice a core outage shows). It is
// NEVER rendered as an empty river (that would present a validation failure as
// "no posts").
test('a malformed timeline envelope fails the home river CLOSED to coreDown, never an empty river', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ timeline: [{ id: 'x' }], nextCursor: 'c9' }), { status: 200 })) // no model discriminant
	const result = (await load({ fetch, url: new URL('http://x/'), parent: async () => ({ me: null }) } as never)) as {
		coreDown?: boolean
		journalCursor?: string | null
		nextCursor: string | null
		timeline: unknown[]
	}
	expect(result.coreDown).toBe(true) // fail closed, not a misleading empty timeline
	expect(result.timeline).toEqual([])
	expect(result.nextCursor).toBeNull()
})

// The load starts the follows fetch BEFORE awaiting the river, so a river
// failure returns coreDown while the follows promise is still in flight. Its
// discard handler must already be attached or that later rejection is
// unhandled — fatal for the Node process (this is the surviving half of the
// cold-pod crash loop found deploying on 2026-07-24).
test('a follows rejection arriving after the river has already failed is never unhandled', async () => {
	const unhandled: unknown[] = []
	const handler = (reason: unknown): void => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', handler)
	try {
		const fetch = vi.fn(async (input: unknown) => {
			if (String(input).includes('/follows')) {
				// Reject on a MACROTASK boundary, after the river has already thrown.
				await new Promise((r) => setImmediate(r))
				throw new Error('follows failed')
			}
			throw new Error('river failed')
		})
		const result = (await load({
			fetch,
			url: new URL('http://x/?tab=personal'),
			parent: async () => ({ me: meOf('alice') })
		} as never)) as { coreDown?: boolean }
		expect(result.coreDown).toBe(true)
		await new Promise((r) => setImmediate(r))
		expect(unhandled).toEqual([])
	} finally {
		process.off('unhandledRejection', handler)
	}
})
