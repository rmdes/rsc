import { test, expect, vi } from 'vitest'
import { load } from './+page.server.ts'

// V4 §3.5 — the permanent reserved-handle redirect. /u is local accounts only;
// a legacy remote handle converted from a single_publisher source is reserved
// at conversion and redirects to its publisher page (an aggregate source's
// handle is never reserved, so it just 404s as any unreserved handle would).

const isHandle = (u: unknown) => String(u).includes('/handles/')
const isStats = (u: unknown) => String(u).includes('/stats')
const reserved = (publisherId: string) =>
	new Response(JSON.stringify({ model: 'logical-v2', handle: 'alice', reserved: true, publisherId }), { status: 200 })
const notReserved = () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
const stats = () => new Response(JSON.stringify({ posts: 0, followers: 0, following: 0, kind: 'local' }), { status: 200 })

const item = {
	kind: 'logical_item',
	id: 'i1',
	origin: 'local',
	parentResolutionState: 'none',
	parentLogicalItemId: null,
	threadRootId: null,
	selectedAuthor: { kind: 'local', id: 'l1', handle: 'alice', displayName: 'Alice' },
	title: null,
	content: 'hello from alice',
	contentMarkdown: null,
	permalink: '/post/i1',
	sourceLink: null,
	replyContext: null,
	enclosures: [],
	publishedAt: '2026-07-20T00:00:00.000Z',
	updatedAt: null,
	updatedAtProvenance: null,
	directReplyCount: 0,
	conversationReplyCount: 0,
	classification: { personal: false, federated: false }
}
const river = () =>
	new Response(
		JSON.stringify({
			model: 'logical-v2',
			lens: { kind: 'local_author', account: { id: 'l1', handle: 'alice', displayName: 'Alice' } },
			timeline: [item],
			nextCursor: null,
			journalCursor: 'jc'
		}),
		{ status: 200 }
	)

const call = (load: unknown, fetch: unknown) =>
	(load as (e: never) => Promise<unknown>)({ fetch, params: { handle: 'alice' }, url: new URL('http://x/u/alice') } as never)

test('a reserved handle 308-redirects to its publisher page', async () => {
	const fetch = vi.fn(async (u: string | URL) => (isHandle(u) ? reserved('pub1') : isStats(u) ? stats() : river()))
	await expect(call(load, fetch)).rejects.toMatchObject({ status: 308, location: '/p/pub1' })
	// the lookup is asked before the river — a page we are about to leave is never fetched
	expect(fetch.mock.calls.some((c) => String(c[0]).includes('/handles/alice'))).toBe(true)
})

test('a live local handle renders as today — no redirect', async () => {
	const fetch = vi.fn(async (u: string | URL) => (isHandle(u) ? notReserved() : isStats(u) ? stats() : river()))
	const out = (await call(load, fetch)) as {
		handle: string
		timeline: Array<{ id: string; contentHtml?: string }>
		coreDown?: boolean
	}
	expect(out.coreDown).toBeUndefined()
	expect(out.handle).toBe('alice')
	expect(out.timeline[0].id).toBe('i1')
	expect(out.timeline[0].contentHtml).toContain('hello from alice') // enriched through the sanitize twin
	expect(fetch.mock.calls.some((c) => String(c[0]).includes('author=alice'))).toBe(true)
})

test('the redirect still fires after the target is purged — no post-purge branch (spec WP5)', async () => {
	// The reservation outlives source removal and purge; core keeps answering the
	// lookup, and /p/:publisherId 404s through the ordinary not-found path.
	const fetch = vi.fn(async (u: string | URL) => (isHandle(u) ? reserved('gone1') : isStats(u) ? stats() : river()))
	await expect(call(load, fetch)).rejects.toMatchObject({ status: 308, location: '/p/gone1' })
})

test('a lookup failure degrades to the ordinary page instead of a redirect', async () => {
	const fetch = vi.fn(async (u: string | URL) => (isHandle(u) ? new Response('boom', { status: 500 }) : isStats(u) ? stats() : river()))
	const out = (await call(load, fetch)) as { timeline: unknown[]; coreDown?: boolean }
	expect(out.coreDown).toBeUndefined()
	expect(out.timeline).toHaveLength(1)
})
