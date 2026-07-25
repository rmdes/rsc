import { test, expect, vi, describe } from 'vitest'
import {
	asLogicalTimeline,
	asLogicalSingleItem,
	asLogicalThread,
	asLogicalHistory,
	asStreamEvent,
	logicalToEntry,
	LogicalContractError,
	type LogicalItemDto
} from './logical-types.ts'
import { getLogicalTimeline, getLogicalItem, getLogicalThread, getLogicalRiverOrEmpty } from './logical-api.ts'

// A minimal but valid remote logical item.
const dto = (over: Partial<LogicalItemDto> = {}): LogicalItemDto => ({
	kind: 'logical_item',
	id: 'i1',
	origin: 'remote',
	parentResolutionState: 'none',
	parentLogicalItemId: null,
	threadRootId: null,
	selectedAuthor: {
		kind: 'remote_publisher',
		id: 'pub1',
		displayName: 'Pub One',
		canonicalFeedUrl: 'https://ex.com/f.xml',
		profileAvailable: true,
		attributionLevel: 'bound_single_publisher'
	},
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

const env = (model: 'logical-v2' | 'wrong', over = {}) => ({
	model,
	lens: { kind: 'public' },
	timeline: [dto()],
	nextCursor: null,
	journalCursor: 'jc-1',
	...over
})

describe('envelope validators fail closed (carve 2 — never cast to v1)', () => {
	test('asLogicalTimeline throws on a missing model discriminant', () => {
		expect(() => asLogicalTimeline({ lens: { kind: 'public' }, timeline: [], nextCursor: null, journalCursor: 'x' })).toThrow(
			LogicalContractError
		)
	})
	test('asLogicalTimeline throws on a mismatched model', () => {
		expect(() => asLogicalTimeline(env('wrong'))).toThrow(LogicalContractError)
	})
	test('asLogicalTimeline throws when timeline is not an array', () => {
		expect(() => asLogicalTimeline({ model: 'logical-v2', lens: { kind: 'public' }, timeline: 'nope', journalCursor: 'x', nextCursor: null })).toThrow(
			LogicalContractError
		)
	})
	test('asLogicalTimeline throws on a malformed item (missing kind)', () => {
		expect(() => asLogicalTimeline(env('logical-v2', { timeline: [{ id: 'x' }] }))).toThrow(LogicalContractError)
	})
	test('asLogicalTimeline accepts a well-formed envelope', () => {
		const e = asLogicalTimeline(env('logical-v2'))
		expect(e.journalCursor).toBe('jc-1')
		expect(e.timeline[0].id).toBe('i1')
	})
	test('asLogicalSingleItem throws on a missing model, accepts a valid one', () => {
		expect(() => asLogicalSingleItem({ item: dto(), journalCursor: 'x' })).toThrow(LogicalContractError)
		expect(asLogicalSingleItem({ model: 'logical-v2', item: dto(), journalCursor: 'x' }).item.id).toBe('i1')
	})
	test('asLogicalThread throws on a mismatched model, accepts a valid one', () => {
		expect(() => asLogicalThread({ model: 'v1', nodes: [] })).toThrow(LogicalContractError)
		const t = asLogicalThread({ model: 'logical-v2', requestedLogicalItemId: 'i1', rootId: 'i1', nodes: [{ kind: 'item', item: dto() }], truncated: { depth: false, nodes: false, cycle: false }, journalCursor: 'x' })
		expect(t.nodes.length).toBe(1)
	})
	test('asLogicalHistory validates the discriminant', () => {
		expect(() => asLogicalHistory({ entries: [] })).toThrow(LogicalContractError)
		expect(asLogicalHistory({ model: 'logical-v2', logicalItemId: 'i1', origin: 'local', entries: [], currentSequence: 0, journalCursor: 'x' }).logicalItemId).toBe('i1')
	})
	test('asStreamEvent validates the discriminant and kind', () => {
		expect(() => asStreamEvent({ kind: 'upsert', logicalItemId: 'i1' })).toThrow(LogicalContractError)
		expect(() => asStreamEvent({ model: 'logical-v2', kind: 'weird' })).toThrow(LogicalContractError)
		expect(asStreamEvent({ model: 'logical-v2', kind: 'reset' }).kind).toBe('reset')
		expect(asStreamEvent({ model: 'logical-v2', kind: 'remove', logicalItemId: 'i1' }).kind).toBe('remove')
	})
})

describe('logicalToEntry maps the DTO onto the render shape (reuse the TimelineEntry components)', () => {
	test('a navigable remote publisher becomes a remote entry linkable to its /p page', () => {
		const e = logicalToEntry(dto())
		expect(e.source).toBe('remote')
		expect(e.author.displayName).toBe('Pub One')
		expect(e.author.feedUrl).toBe('https://ex.com/f.xml')
		expect(e.publisherId).toBe('pub1')
		expect(e.url).toBe('https://ex.com/i1')
		expect(e.replyCount).toBe(2) // conversation count drives the root affordance
	})
	test('a non-navigable publisher (source-scoped fallback) exposes no /p link', () => {
		const e = logicalToEntry(
			dto({
				selectedAuthor: { kind: 'remote_publisher', id: 'p2', displayName: 'X', canonicalFeedUrl: null, profileAvailable: false, attributionLevel: 'source_scoped_fallback' }
			})
		)
		expect(e.publisherId).toBeUndefined()
	})
	test('a local author becomes a /u-linkable local entry', () => {
		const e = logicalToEntry(dto({ origin: 'local', selectedAuthor: { kind: 'local', id: 'u1', handle: 'alice', displayName: 'Alice' } }))
		expect(e.source).toBe('local')
		expect(e.author.handle).toBe('alice')
		expect(e.publisherId).toBeUndefined()
	})
	test('a resolved reply carries the parent id and no external reply context', () => {
		const e = logicalToEntry(dto({ parentResolutionState: 'resolved', parentLogicalItemId: 'root', threadRootId: 'root' }))
		expect(e.inReplyToPostId).toBe('root')
		expect(e.threadRootId).toBe('root')
	})
	test('an unresolved reply exposes its external reply context, not a parent id', () => {
		const e = logicalToEntry(
			dto({ parentResolutionState: 'missing', replyContext: { kind: 'asserted_external', authorLabel: 'Bob', snippet: 'earlier', url: 'https://x/1' } })
		)
		expect(e.inReplyToPostId).toBeNull()
		expect(e.replyContextAuthor).toBe('Bob')
		expect(e.inReplyTo).toBe('https://x/1')
	})
})

describe('getLogicalTimeline builds the v2 lens query and maps entries', () => {
	const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

	test('none lens: no selector params, mapped entries + cursors', async () => {
		const f = vi.fn(async (_u: string | URL) => ok(env('logical-v2', { nextCursor: 'c1' })))
		const page = await getLogicalTimeline(f as never, {})
		const url = String(f.mock.calls[0][0])
		expect(url).toContain('/timeline')
		expect(url).not.toContain('origin=')
		expect(url).not.toContain('top_level')
		expect(page.entries[0].id).toBe('i1')
		expect(page.nextCursor).toBe('c1')
		expect(page.journalCursor).toBe('jc-1')
	})
	test('local lens uses origin=local (never the v1 source=local)', async () => {
		const f = vi.fn(async (_u: string | URL) => ok(env('logical-v2')))
		await getLogicalTimeline(f as never, { origin: 'local' })
		const url = String(f.mock.calls[0][0])
		expect(url).toContain('origin=local')
		expect(url).not.toContain('source=local')
	})
	test('federated lens uses federated=true (never the v1 feed_type)', async () => {
		const f = vi.fn(async (_u: string | URL) => ok(env('logical-v2')))
		await getLogicalTimeline(f as never, { federated: true })
		expect(String(f.mock.calls[0][0])).toContain('federated=true')
	})
	test('personal lens uses followed_by=<handle>', async () => {
		const f = vi.fn(async (_u: string | URL) => ok(env('logical-v2')))
		await getLogicalTimeline(f as never, { followedBy: 'alice' })
		expect(String(f.mock.calls[0][0])).toContain('followed_by=alice')
	})
	test('publisher lens URL-encodes the opaque stable id', async () => {
		const f = vi.fn(async (_u: string | URL) => ok(env('logical-v2')))
		await getLogicalTimeline(f as never, { publisher: 'a b/c' })
		expect(String(f.mock.calls[0][0])).toContain('publisher=a%20b%2Fc')
	})
	test('a malformed envelope fails closed (throws, never a v1 cast)', async () => {
		const f = vi.fn(async () => ok({ timeline: [], nextCursor: null })) // no model
		await expect(getLogicalTimeline(f as never, {})).rejects.toBeInstanceOf(LogicalContractError)
	})
	test('a non-200 throws (the caller degrades, it never silently empties)', async () => {
		const f = vi.fn(async () => new Response('bad', { status: 400 }))
		await expect(getLogicalTimeline(f as never, {})).rejects.toThrow()
	})
})

describe('getLogicalRiverOrEmpty — secondary rivers discard a contract violation, never a v1 cast', () => {
	test('a malformed envelope becomes an empty river with no snapshot cursor (not an exception, not v1)', async () => {
		const f = vi.fn(async () => new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 }))
		expect(await getLogicalRiverOrEmpty(f as never, { author: 'a' })).toEqual({ entries: [], nextCursor: null, journalCursor: null })
	})
	test('a valid envelope returns mapped entries and the snapshot cursor', async () => {
		const f = vi.fn(async () => new Response(JSON.stringify(env('logical-v2', { nextCursor: 'c' })), { status: 200 }))
		const r = await getLogicalRiverOrEmpty(f as never, { author: 'a' })
		expect(r.entries[0].id).toBe('i1')
		expect(r.nextCursor).toBe('c')
		expect(r.journalCursor).toBe('jc-1')
	})
	test('a network failure (non-200) still propagates so the page can degrade to coreDown', async () => {
		const f = vi.fn(async () => new Response('boom', { status: 500 }))
		await expect(getLogicalRiverOrEmpty(f as never, { author: 'a' })).rejects.toThrow()
	})
})

describe('getLogicalItem / getLogicalThread', () => {
	test('getLogicalItem returns null on the neutral 404', async () => {
		const f = vi.fn(async () => new Response('nope', { status: 404 }))
		expect(await getLogicalItem(f as never, 'x')).toBeNull()
	})
	test('getLogicalItem maps a valid single-item envelope', async () => {
		const f = vi.fn(async () => new Response(JSON.stringify({ model: 'logical-v2', item: dto(), journalCursor: 'jc' }), { status: 200 }))
		const r = await getLogicalItem(f as never, 'i1')
		expect(r?.entry.id).toBe('i1')
		expect(r?.journalCursor).toBe('jc')
	})
	test('getLogicalItem fails closed on a malformed 200', async () => {
		const f = vi.fn(async () => new Response(JSON.stringify({ item: dto() }), { status: 200 }))
		await expect(getLogicalItem(f as never, 'i1')).rejects.toBeInstanceOf(LogicalContractError)
	})
	test('getLogicalThread returns null on 404 and passes placeholders through as connective markers (D11)', async () => {
		const f404 = vi.fn(async () => new Response('nope', { status: 404 }))
		expect(await getLogicalThread(f404 as never, 'x')).toBeNull()
		const body = { model: 'logical-v2', requestedLogicalItemId: 'i1', rootId: 'i1', nodes: [{ kind: 'item', item: dto() }, { kind: 'placeholder', logicalItemId: 'gap', parentLogicalItemId: 'i1', timelineSortAt: 't', placeholderKind: 'unavailable' }], truncated: { depth: false, nodes: false, cycle: false }, journalCursor: 'x' }
		const f = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
		const r = await getLogicalThread(f as never, 'i1')
		expect(r?.rootId).toBe('i1')
		// The placeholder is no longer dropped: it flows through as a marker entry
		// keyed off its parent id so the flat tree can nest its reply subtree (D11).
		expect(r?.entries.map((e) => e.id)).toEqual(['i1', 'gap'])
		const ph = r?.entries.find((e) => e.id === 'gap')
		expect(ph?.placeholder).toBe(true)
		expect(ph?.inReplyToPostId).toBe('i1')
		expect(ph?.publishedAt).toBe('t')
	})
})
