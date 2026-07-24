import { describe, expect, test, vi } from 'vitest'
import { load } from './+page.server'

// The cold-pod crash loop (found deploying with RUNNING.md, 2026-07-24): on a
// pod with no memoized capability reading, the home load fires the legacy
// timeline call alongside the capability probe. Against a v2 core the legacy
// selectors 400 DURING the probe await — and if the discard handler is not yet
// attached, that rejection is unhandled and kills the process before the memo
// can warm, so every restart is cold again. The load must complete (coreDown at
// worst) with ZERO unhandled rejections.
describe('cold pod against a v2 core', () => {
	test('the first load survives: the discarded legacy rejection is handled at creation', async () => {
		const unhandled: unknown[] = []
		const handler = (reason: unknown): void => {
			unhandled.push(reason)
		}
		process.on('unhandledRejection', handler)
		try {
			const fetch = vi.fn(async (input: unknown) => {
				const url = String(input)
				if (url.includes('/capabilities')) {
					// Resolve on a MACROTASK boundary so the legacy 400 rejection has a
					// real window to go unhandled before the v2 branch is reached.
					await new Promise((r) => setImmediate(r))
					return new Response(
						JSON.stringify({ sourceModelV2: true, model: 'logical-v2', journalCursorVersion: 1, streamProtocolVersion: 1 }),
						{ status: 200 }
					)
				}
				return new Response(JSON.stringify({ error: 'invalid lens' }), { status: 400 })
			})
			const result = (await load({
				fetch,
				url: new URL('http://x/'),
				parent: async () => ({ me: null })
			} as never)) as { coreDown?: boolean }
			// The v2 envelope fetch also 400s here, so the page degrades to coreDown —
			// the point is the process SURVIVED to serve it.
			expect(result.coreDown).toBe(true)
			await new Promise((r) => setImmediate(r))
			expect(unhandled).toEqual([])
		} finally {
			process.off('unhandledRejection', handler)
		}
	})
})
