import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

function formRequest(fields: Record<string, string>): Request {
	const body = new URLSearchParams(fields)
	return new Request('http://x/?/reply', { method: 'POST', body })
}

test('reply posts content with the viewed post as target and redirects', async () => {
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 201 }))
	await expect(
		actions.reply({ request: formRequest({ handle: 'alice', content: 'a reply' }), fetch, params: { id: 'post-1' } } as never)
	).rejects.toMatchObject({ status: 303 })
	const body = JSON.parse(String(fetch.mock.calls[0][1]?.body))
	expect(body.content).toBe('a reply')
	expect(body.inReplyTo).toBe('post-1')
})

test('reply fails without content', async () => {
	const fetch = vi.fn()
	const res = await actions.reply({ request: formRequest({ handle: 'alice' }), fetch, params: { id: 'post-1' } } as never)
	expect(res).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})
