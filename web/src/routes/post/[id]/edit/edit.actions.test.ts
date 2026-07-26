import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

function formRequest(fields: Record<string, string>): Request {
	return new Request('http://x/?/edit', { method: 'POST', body: new URLSearchParams(fields) })
}
function sessionedEvent(fields: Record<string, string>, fetch: ReturnType<typeof vi.fn>, id = 'p1') {
	return {
		request: formRequest(fields),
		fetch,
		params: { id },
		url: new URL('http://x/'),
		cookies: { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }
	}
}

test('edit PATCHes /posts/:id with the content then redirects', async () => {
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }))
	await expect(actions.edit(sessionedEvent({ content: 'updated' }, fetch) as never)).rejects.toMatchObject({ status: 303 })
	const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
	expect(String(url)).toContain('/posts/p1')
	expect(init.method).toBe('PATCH')
	expect(JSON.parse(String(init.body)).content).toBe('updated')
})

test('empty content → fail(400), no fetch', async () => {
	const fetch = vi.fn()
	expect(await actions.edit(sessionedEvent({}, fetch) as never)).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

// --- the edit load reads the logical thread envelope ------------------------

import { load } from './+page.server.ts'

const localDto = (id: string) => ({
	kind: 'logical_item',
	id,
	origin: 'local',
	parentResolutionState: 'none',
	parentLogicalItemId: null,
	threadRootId: null,
	selectedAuthor: { kind: 'local', id: 'u1', handle: 'rick', displayName: 'Rick' },
	title: null,
	content: '<p>hi</p>',
	contentMarkdown: 'hi',
	permalink: 'http://x/post/' + id,
	sourceLink: null,
	replyContext: null,
	enclosures: [],
	publishedAt: '2026-07-20T00:00:00.000Z',
	updatedAt: null,
	updatedAtProvenance: null,
	directReplyCount: 0,
	conversationReplyCount: 0,
	classification: { personal: true, federated: false }
})

test('the edit load finds the OWN local post through the logical thread envelope (500 regression)', async () => {
	const fetch = vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					model: 'logical-v2',
					requestedLogicalItemId: 'p1',
					rootId: 'p1',
					nodes: [{ kind: 'item', item: localDto('p1') }],
					truncated: { depth: false, nodes: false, cycle: false },
					journalCursor: 'x'
				}),
				{ status: 200 }
			)
	)
	const result = (await load({
		fetch,
		params: { id: 'p1' },
		parent: async () => ({ me: { user: { id: 'u1', handle: 'rick' } } })
	} as never)) as { post: { id: string; source: string } }
	expect(result.post.id).toBe('p1')
	expect(result.post.source).toBe('local')
})
