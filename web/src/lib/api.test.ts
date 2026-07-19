import { test, expect, vi } from 'vitest'
import {
	getTimeline,
	createPost,
	addRemoteUser,
	getMe,
	listAdminFeeds,
	removeRemoteFeed,
	getAdminOverview,
	listAdminUsers,
	editPost,
	getRevisions,
	deleteLocalAccount,
	deletePost,
	listDeviceSessions,
	getActiveAuthUserId,
	setActiveSession,
	revokeSession
} from './api.ts'

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

test('getAdminOverview returns the snapshot and GETs /admin/overview', async () => {
	const snap = { counts: { registeredUsers: 1, guests: 0, remoteFeeds: 2, posts: 3 }, federation: { websub: 'self', rssCloud: true, pushIn: true, publicUrl: 'https://x' }, mailEnabled: true, adminEmails: ['a@x'] }
	const f = vi.fn(async () => new Response(JSON.stringify(snap), { status: 200 }))
	expect((await getAdminOverview(f as unknown as typeof fetch)).counts.remoteFeeds).toBe(2)
	expect(f).toHaveBeenCalledWith('http://localhost:8787/admin/overview')
})
test('listAdminUsers returns the users array', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ users: [{ handle: 'a', displayName: 'A', kind: 'local', emailVerified: true, createdAt: '', feedUrl: null }] }), { status: 200 }))
	expect((await listAdminUsers(f as unknown as typeof fetch))[0].handle).toBe('a')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/admin/users')
})
test('getAdminOverview surfaces the core error message', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'admin only' }), { status: 403 }))
	await expect(getAdminOverview(f as unknown as typeof fetch)).rejects.toThrow('admin only')
})

test('editPost PATCHes /posts/:id with the content', async () => {
	const f = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }))
	await editPost(f as unknown as typeof fetch, 'p1', 'new body')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/posts/p1', expect.objectContaining({ method: 'PATCH' }))
	expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toEqual({ content: 'new body' })
})

test('getRevisions GETs /posts/:id/revisions', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ post: { id: 'p1' }, revisions: [] }), { status: 200 }))
	const out = await getRevisions(f as unknown as typeof fetch, 'p1')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/posts/p1/revisions')
	expect(out.revisions).toEqual([])
})

test('deleteLocalAccount DELETEs the url-encoded handle', async () => {
	const f = vi.fn(async (..._a: unknown[]) => new Response(null, { status: 200 }))
	await deleteLocalAccount(f as unknown as typeof fetch, 'a b')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/admin/users/a%20b', { method: 'DELETE' })
})
test('deleteLocalAccount surfaces the core error', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'not a local account' }), { status: 409 }))
	await expect(deleteLocalAccount(f as unknown as typeof fetch, 'x')).rejects.toThrow('not a local account')
})
test('deletePost DELETEs /admin/posts/:id', async () => {
	const f = vi.fn(async (..._a: unknown[]) => new Response(null, { status: 200 }))
	await deletePost(f as unknown as typeof fetch, 'p1')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/admin/posts/p1', { method: 'DELETE' })
})
test('deletePost surfaces the core error', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'not a local post' }), { status: 409 }))
	await expect(deletePost(f as unknown as typeof fetch, 'p1')).rejects.toThrow('not a local post')
})

test('listDeviceSessions GETs the multi-session list endpoint', async () => {
	const rows = [{ session: { token: 't1' }, user: { id: 'u1', email: 'a@x', name: 'a@x' } }]
	const f = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }))
	const out = await listDeviceSessions(f as unknown as typeof fetch)
	expect(out).toEqual(rows)
	const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit | undefined]
	expect(url).toContain('/api/auth/multi-session/list-device-sessions')
	expect(init?.method ?? 'GET').toBe('GET')
})

test('getActiveAuthUserId reads /get-session user id, null when signed out', async () => {
	const f1 = vi.fn(async () => new Response(JSON.stringify({ session: {}, user: { id: 'u9' } }), { status: 200 }))
	await expect(getActiveAuthUserId(f1 as unknown as typeof fetch)).resolves.toBe('u9')
	const f2 = vi.fn(async () => new Response('null', { status: 200 }))
	await expect(getActiveAuthUserId(f2 as unknown as typeof fetch)).resolves.toBeNull()
})

test('setActiveSession POSTs the token as JSON and returns the response for cookie relay', async () => {
	const res = new Response('{}', { status: 200 })
	const f = vi.fn(async () => res)
	const out = await setActiveSession(f as unknown as typeof fetch, 'tok')
	expect(out).toBe(res)
	const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
	expect(url).toContain('/api/auth/multi-session/set-active')
	expect(init.method).toBe('POST')
	expect(new Headers(init.headers).get('content-type')).toBe('application/json')
	expect(JSON.parse(String(init.body))).toEqual({ sessionToken: 'tok' })
})

test('revokeSession POSTs the token to the revoke endpoint', async () => {
	const res = new Response('{}', { status: 200 })
	const f = vi.fn(async () => res)
	const out = await revokeSession(f as unknown as typeof fetch, 'old')
	expect(out).toBe(res)
	const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
	expect(url).toContain('/api/auth/multi-session/revoke')
	expect(JSON.parse(String(init.body))).toEqual({ sessionToken: 'old' })
})

test('getTimeline threads source and feed_type params', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ timeline: [], nextCursor: null }), { status: 200 }))
	await getTimeline(f as unknown as typeof fetch, { source: 'local' })
	expect(String((f.mock.calls[0] as unknown as [string])[0])).toContain('source=local')
	await getTimeline(f as unknown as typeof fetch, { feedType: 'instance' })
	expect(String((f.mock.calls[1] as unknown as [string])[0])).toContain('feed_type=instance')
})
