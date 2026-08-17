import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

function formRequest(fields: Record<string, string>): Request {
	return new Request('http://x/?/deletePost', { method: 'POST', body: new URLSearchParams(fields) })
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

// Drives the real actions.deletePost, not $lib/api's deletePost directly, so a
// field-name typo in the action's `form.get('asAdmin')` parse would fail these.

// The Critical this pins: core's DELETE /admin/posts/:id REQUIRES a JSON body
// ({category, note?}) — sending none 400s "category invalid" and every admin
// removal silently no-ops.
test('actions.deletePost: asAdmin=1 hits the admin route WITH the chosen category', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }))
	const event = sessionedEvent({ id: 'p1', asAdmin: '1', category: 'abuse' }, fetch)
	await actions.deletePost(event as never)
	const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
	expect(url).toContain('/admin/posts/p1')
	expect(JSON.parse(String(init.body))).toEqual({ category: 'abuse' })
})

test('actions.deletePost: an admin removal with no category is refused before calling core', async () => {
	const fetch = vi.fn()
	const event = sessionedEvent({ id: 'p1', asAdmin: '1' }, fetch)
	const res = await actions.deletePost(event as never)
	expect(res).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('actions.deletePost: asAdmin="" hits the self-serve route with NO body', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }))
	const event = sessionedEvent({ id: 'p1', asAdmin: '' }, fetch)
	await actions.deletePost(event as never)
	const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
	expect(url).toContain('/posts/p1')
	expect(url).not.toContain('/admin/')
	expect(init.body).toBeUndefined()
})

test('actions.deletePost: asAdmin field absent falls back to the self-serve route', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }))
	const event = sessionedEvent({ id: 'p1' }, fetch)
	await actions.deletePost(event as never)
	expect(fetch.mock.calls[0][0]).not.toContain('/admin/')
})
