import { test, expect, vi } from 'vitest'
import { load } from './+page.server.ts'

const isCap = (u: unknown) => String(u).includes('/capabilities')
const capOn = () => new Response(JSON.stringify({ sourceModelV2: true }), { status: 200 })

test('load renders current + each revision through the sanitize twin, oldest-first', async () => {
	const f = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					post: { content: 'now', source: 'local', editedAt: 'x' },
					revisions: [
						{ content: 'first', seenAt: '1' },
						{ content: 'second', seenAt: '2' }
					]
				}),
				{ status: 200 }
			)
	)
	const out = (await load({ fetch: f, params: { id: 'p1' } } as never)) as {
		currentHtml: string
		versions: { seenAt: string; html: string }[]
	}
	expect(out.currentHtml).toContain('now')
	expect(out.versions.map((v) => v.seenAt)).toEqual(['1', '2'])
	expect(out.versions[0].html).toContain('first')
})

test('load throws 404 when getRevisions fails', async () => {
	const f = vi.fn(async () => new Response(null, { status: 404 }))
	await expect(load({ fetch: f, params: { id: 'nope' } } as never)).rejects.toMatchObject({ status: 404 })
})

// --- v2 history (RSC_SOURCE_MODEL_V2) ---------------------------------------
// The v2 branch reads LogicalHistoryEnvelope on a sanitizer-bearing REMOTE path.
// Fresh import per case so the memoized capability reading is v2, not the false
// cached by the v1 cases above.

test('v2: a malformed history envelope fails CLOSED to 404, never a v1 revisions cast', async () => {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	const f = vi.fn(async (u: string | URL) =>
		isCap(u) ? capOn() : new Response(JSON.stringify({ logicalItemId: 'p1', origin: 'remote', entries: [] }), { status: 200 }) // no model discriminant
	)
	await expect(load({ fetch: f, params: { id: 'p1' } } as never)).rejects.toMatchObject({ status: 404 })
})

test('v2: remote history content is rendered through the sanitize twin (script stripped)', async () => {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	const entry = (over: object) => ({ sequence: 0, title: null, content: null, markdown: null, permalink: null, enclosures: [], updatedAt: 'x', updatedAtProvenance: null, current: false, ...over })
	const f = vi.fn(async (u: string | URL) =>
		isCap(u)
			? capOn()
			: new Response(
					JSON.stringify({
						model: 'logical-v2',
						logicalItemId: 'p1',
						origin: 'remote',
						currentSequence: 1,
						journalCursor: 'jc',
						entries: [
							entry({ sequence: 1, content: '<script>alert(1)</script>current ok', current: true }),
							entry({ sequence: 0, content: '<img src=x onerror="p()">old', updatedAt: '1' })
						]
					}),
					{ status: 200 }
				)
	)
	const out = (await load({ fetch: f, params: { id: 'p1' } } as never)) as { currentHtml: string; versions: { html: string }[] }
	expect(out.currentHtml).toContain('current ok')
	expect(out.currentHtml).not.toContain('script') // remote path still sanitized
	expect(out.versions[0].html).not.toContain('onerror')
})

// The crash root cause (D14): the projector gives EVERY non-current local revision
// updatedAt: null, so two revisions collapse to seenAt '' — a duplicate {#each} key.
// The loader must carry a genuinely unique key (the sequence) so the render never
// keys two rows on the same value.
test('v2: local revisions carry a unique key even when every updatedAt is null', async () => {
	vi.resetModules()
	const { load } = await import('./+page.server.ts')
	const entry = (over: object) => ({ sequence: 0, title: null, content: null, markdown: null, permalink: null, enclosures: [], updatedAt: null, updatedAtProvenance: null, current: false, ...over })
	const f = vi.fn(async (u: string | URL) =>
		isCap(u)
			? capOn()
			: new Response(
					JSON.stringify({
						model: 'logical-v2',
						logicalItemId: 'p1',
						origin: 'local',
						currentSequence: 2,
						journalCursor: 'jc',
						entries: [
							entry({ sequence: 2, content: 'now', current: true, updatedAt: 'x' }),
							entry({ sequence: 1, content: 'second' }),
							entry({ sequence: 0, content: 'first' })
						]
					}),
					{ status: 200 }
				)
	)
	const out = (await load({ fetch: f, params: { id: 'p1' } } as never)) as { versions: { key: number; seenAt: string }[] }
	expect(out.versions.map((v) => v.seenAt)).toEqual(['', '']) // both untimed — the collision source
	const keys = out.versions.map((v) => v.key)
	expect(new Set(keys).size).toBe(keys.length) // yet the keys are all distinct
	expect(keys).toEqual([0, 1]) // oldest-first sequence
})
