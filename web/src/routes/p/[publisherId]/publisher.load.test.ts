import { test, expect, vi } from 'vitest'

// The publisher page is logical-v2 ONLY (spec §3.6). Every capability reading is
// memoized per module instance, so each v2 case imports a FRESH +page.server.ts
// (the page.load.test.ts pattern) rather than adding a production reset hook.

const isCap = (u: unknown) => String(u).includes('/capabilities')
const capOn = () => new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })
const publisherLens = { kind: 'publisher', publisher: { id: 'pub1', displayName: 'Pub One', canonicalFeedUrl: 'https://ex.com/f.xml', identityLevel: 'feed_anchored' } }

const load404 = (load: unknown, fetch: unknown) =>
	expect((load as (e: never) => unknown)({ fetch, params: { publisherId: 'pub1' }, url: new URL('http://x/p/pub1') } as never)).rejects.toMatchObject({ status: 404 })

test('capability off → neutral 404 (the page does not exist under v1)', async () => {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	const fetch = vi.fn(async () => new Response(JSON.stringify({ sourceModelV2: false }), { status: 200 }))
	await load404(load, fetch)
})

test('a core 404 / fail-closed throw from getLogicalTimeline → the same neutral 404', async () => {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	const fetch = vi.fn(async (u: string | URL) => (isCap(u) ? capOn() : new Response('nope', { status: 404 })))
	await load404(load, fetch)
})

test('a valid v2 envelope whose lens is NOT a publisher → 404 (never /u, never a cast)', async () => {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	const fetch = vi.fn(async (u: string | URL) =>
		isCap(u) ? capOn() : new Response(JSON.stringify({ model: 'logical-v2', lens: { kind: 'public' }, timeline: [], nextCursor: null, journalCursor: 'jc' }), { status: 200 })
	)
	await load404(load, fetch)
})

test('an empty descriptor (valid publisher lens, no items) still renders', async () => {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	const fetch = vi.fn(async (u: string | URL) =>
		isCap(u) ? capOn() : new Response(JSON.stringify({ model: 'logical-v2', lens: publisherLens, timeline: [], nextCursor: null, journalCursor: 'jc' }), { status: 200 })
	)
	const out = (await load({ fetch, params: { publisherId: 'pub1' }, url: new URL('http://x/p/pub1') } as never)) as {
		publisher: { id: string; displayName: string }
		timeline: unknown[]
		nextCursor: string | null
		isFirstPage: boolean
	}
	expect(out.publisher.id).toBe('pub1')
	expect(out.publisher.displayName).toBe('Pub One')
	expect(out.timeline).toEqual([])
	expect(out.nextCursor).toBeNull()
	expect(out.isFirstPage).toBe(true)
})
