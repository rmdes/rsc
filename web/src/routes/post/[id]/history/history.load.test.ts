import { test, expect, vi } from 'vitest'
import { load } from './+page.server.ts'

// The history load reads LogicalHistoryEnvelope on a sanitizer-bearing REMOTE path.

test('a malformed history envelope fails CLOSED to 404, never a cast to some other shape', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ logicalItemId: 'p1', origin: 'remote', entries: [] }), { status: 200 })) // no model discriminant
	await expect(load({ fetch: f, params: { id: 'p1' } } as never)).rejects.toMatchObject({ status: 404 })
})

test('remote history content is rendered through the sanitize twin (script stripped)', async () => {
	const entry = (over: object) => ({ sequence: 0, title: null, content: null, markdown: null, permalink: null, enclosures: [], updatedAt: 'x', updatedAtProvenance: null, current: false, ...over })
	const f = vi.fn(
		async () =>
			new Response(
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
test('local revisions carry a unique key even when every updatedAt is null', async () => {
	const entry = (over: object) => ({ sequence: 0, title: null, content: null, markdown: null, permalink: null, enclosures: [], updatedAt: null, updatedAtProvenance: null, current: false, ...over })
	const f = vi.fn(
		async () =>
			new Response(
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

// D15/D16: core's envelope already carries per-version title + enclosures
// (projectHistory); the load must not drop them on the floor.
test('each version and the current entry carry their own title and enclosures — not dropped', async () => {
	const enc = { url: 'https://ex.com/a.mp3', mimeType: 'audio/mpeg', title: 'Episode 1', sizeBytes: null, durationSeconds: 90 }
	const entry = (over: object) => ({ sequence: 0, title: null, content: 'x', markdown: null, permalink: null, enclosures: [], updatedAt: 'x', updatedAtProvenance: null, current: false, ...over })
	const f = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					model: 'logical-v2',
					logicalItemId: 'p1',
					origin: 'remote',
					currentSequence: 1,
					journalCursor: 'jc',
					entries: [
						entry({ sequence: 1, title: 'New title', enclosures: [enc], current: true }),
						entry({ sequence: 0, title: 'Old title', enclosures: [], updatedAt: '1' })
					]
				}),
				{ status: 200 }
			)
	)
	const out = (await load({ fetch: f, params: { id: 'p1' } } as never)) as {
		currentTitle: string
		currentEnclosures: { url: string }[]
		versions: { title: string; enclosures: { url: string }[] }[]
	}
	expect(out.currentTitle).toBe('New title')
	expect(out.currentEnclosures).toEqual([enc])
	expect(out.versions[0].title).toBe('Old title')
	expect(out.versions[0].enclosures).toEqual([])
})
