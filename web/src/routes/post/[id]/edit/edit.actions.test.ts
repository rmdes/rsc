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
		cookies: { getAll: () => [{ name: 'textcaster.session_token', value: 's1' }] }
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
