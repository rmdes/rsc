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

test('actions.deletePost: asAdmin=1 hits the admin route', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }))
	const event = sessionedEvent({ id: 'p1', asAdmin: '1' }, fetch)
	await actions.deletePost(event as never)
	expect(fetch.mock.calls[0][0]).toContain('/admin/posts/p1')
})

test('actions.deletePost: asAdmin="" hits the self-serve route', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }))
	const event = sessionedEvent({ id: 'p1', asAdmin: '' }, fetch)
	await actions.deletePost(event as never)
	expect(fetch.mock.calls[0][0]).toContain('/posts/p1')
	expect(fetch.mock.calls[0][0]).not.toContain('/admin/')
})

test('actions.deletePost: asAdmin field absent falls back to the self-serve route', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }))
	const event = sessionedEvent({ id: 'p1' }, fetch)
	await actions.deletePost(event as never)
	expect(fetch.mock.calls[0][0]).not.toContain('/admin/')
})
