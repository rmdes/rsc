import { test, expect, vi } from 'vitest'
import { getTimeline, createPost, addRemoteUser, getMe, listAdminFeeds, removeRemoteFeed } from './api.ts'

const entry = {
	id: 'p1',
	title: null,
	content: 'hi',
	url: null,
	publishedAt: '',
	source: 'local',
	author: { id: 'u1', handle: 'a', displayName: 'A', kind: 'local' }
}

test('getTimeline returns entries and the next cursor', async () => {
	const f = vi.fn(
		async () => new Response(JSON.stringify({ timeline: [entry], nextCursor: '2026~p1' }), { status: 200 })
	)
	const page = await getTimeline(f as unknown as typeof fetch)
	expect(page.timeline[0].content).toBe('hi')
	expect(page.nextCursor).toBe('2026~p1')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/timeline')
})

test('getTimeline passes the before cursor as a query param and defaults nextCursor to null', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ timeline: [] }), { status: 200 }))
	const page = await getTimeline(f as unknown as typeof fetch, { before: '2026-01-01T00:00:00.000Z~p9' })
	expect(f).toHaveBeenCalledWith('http://localhost:8787/timeline?before=2026-01-01T00%3A00%3A00.000Z~p9')
	expect(page.nextCursor).toBeNull()
})

test('createPost posts content (identity comes from the session, not the body)', async () => {
	const f = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 201 }))
	await createPost(f as unknown as typeof fetch, { content: 'x' })
	const init = f.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).has('authorization')).toBe(false)
	expect(JSON.parse(String(init.body))).toEqual({ content: 'x' })
})

test('addRemoteUser sends no authorization header (CORE_API_TOKEN is dead)', async () => {
	const f = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 201 }))
	await addRemoteUser(f as unknown as typeof fetch, { handle: 'a', displayName: 'A', feedUrl: 'https://x/f' })
	const init = f.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).has('authorization')).toBe(false)
})

test('createPost surfaces the core error message', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'content invalid' }), { status: 400 }))
	await expect(createPost(f as unknown as typeof fetch, { content: '' })).rejects.toThrow('content invalid')
})

test('addRemoteUser falls back to a status message when the body has no error field', async () => {
	const f = vi.fn(async () => new Response('nope', { status: 502 }))
	await expect(
		addRemoteUser(f as unknown as typeof fetch, { handle: 'a', displayName: 'A', feedUrl: 'https://x/f' })
	).rejects.toThrow('addRemoteUser 502')
})

test('getMe returns null on 401 instead of throwing', async () => {
	const f = vi.fn(async () => new Response(null, { status: 401 }))
	await expect(getMe(f as unknown as typeof fetch)).resolves.toBeNull()
})

test('getMe returns the session user', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ user: entry.author, isAnonymous: true }), { status: 200 }))
	await expect(getMe(f as unknown as typeof fetch)).resolves.toEqual({ user: entry.author, isAnonymous: true })
})

test('listAdminFeeds returns the feeds array and GETs /admin/feeds', async () => {
	const f = vi.fn(
		async () => new Response(JSON.stringify({ feeds: [{ handle: 'a', displayName: 'A', feedUrl: 'https://x/f' }] }), { status: 200 })
	)
	const feeds = await listAdminFeeds(f as unknown as typeof fetch)
	expect(feeds[0].handle).toBe('a')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/admin/feeds')
})

test('listAdminFeeds surfaces the core error message', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'admin only' }), { status: 403 }))
	await expect(listAdminFeeds(f as unknown as typeof fetch)).rejects.toThrow('admin only')
})

test('removeRemoteFeed DELETEs the url-encoded handle', async () => {
	const f = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }))
	await removeRemoteFeed(f as unknown as typeof fetch, 'a b')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/users/a%20b', { method: 'DELETE' })
})

test('removeRemoteFeed surfaces the core error message', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'not a remote feed' }), { status: 409 }))
	await expect(removeRemoteFeed(f as unknown as typeof fetch, 'x')).rejects.toThrow('not a remote feed')
})
