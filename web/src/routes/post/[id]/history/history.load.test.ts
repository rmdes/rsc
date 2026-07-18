import { test, expect, vi } from 'vitest'
import { load } from './+page.server.ts'

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
