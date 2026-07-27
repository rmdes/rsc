import { test, expect, vi } from 'vitest'
import {
	createPost,
	getMe,
	getAdminOverview,
	listAdminUsers,
	editPost,
	deleteLocalAccount,
	deletePost,
	listDeviceSessions,
	getActiveAuthUserId,
	setActiveSession,
	revokeSession,
	getAdminSettings,
	patchAdminSettings,
	subscribeToSource,
	unsubscribeSource,
	getOwnerFollowing,
	importOpmlV2
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

test('createPost posts content (identity comes from the session, not the body)', async () => {
	const f = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 201 }))
	await createPost(f as unknown as typeof fetch, { content: 'x' })
	const init = f.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).has('authorization')).toBe(false)
	expect(JSON.parse(String(init.body))).toEqual({ content: 'x' })
})

test('createPost surfaces the core error message', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'content invalid' }), { status: 400 }))
	await expect(createPost(f as unknown as typeof fetch, { content: '' })).rejects.toThrow('content invalid')
})

test('getMe returns null on 401 instead of throwing', async () => {
	const f = vi.fn(async () => new Response(null, { status: 401 }))
	await expect(getMe(f as unknown as typeof fetch)).resolves.toBeNull()
})

test('getMe returns the session user', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ user: entry.author, isAnonymous: true }), { status: 200 }))
	await expect(getMe(f as unknown as typeof fetch)).resolves.toEqual({ user: entry.author, isAnonymous: true })
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

test('admin settings wrappers hit GET and PATCH', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ maxSubsPerUser: 500 }), { status: 200 }))
	expect(await getAdminSettings(f as unknown as typeof fetch)).toEqual({ maxSubsPerUser: 500 })
	await patchAdminSettings(f as unknown as typeof fetch, { maxSubsPerUser: 250 })
	const [, patchInit] = f.mock.calls[1] as unknown as [string, RequestInit]
	expect(patchInit.method).toBe('PATCH')
	expect(JSON.parse(String(patchInit.body))).toEqual({ maxSubsPerUser: 250 })
})

// --- v2 source registry ------------------------------------------------------

test('subscribeToSource posts url+commandId (no type) and reports source, pending and local outcomes', async () => {
	const source = vi.fn(async () => new Response(JSON.stringify({ subscription: { sourceId: 's1', url: 'https://ex.com/f.xml', attributionMode: 'single_publisher', subscriptionState: 'active', availability: 'available' } }), { status: 201 }))
	await expect(subscribeToSource(source as unknown as typeof fetch, { url: 'https://ex.com/f.xml', commandId: 'c1' })).resolves.toEqual({ kind: 'source', created: true })
	const [, init] = source.mock.calls[0] as unknown as [string, RequestInit]
	expect(JSON.parse(String(init.body))).toEqual({ url: 'https://ex.com/f.xml', commandId: 'c1' })

	const pending = vi.fn(async () => new Response(JSON.stringify({ subscription: 'pending', message: 'This source is awaiting review.' }), { status: 202 }))
	await expect(subscribeToSource(pending as unknown as typeof fetch, { url: 'https://ex.com/f.xml', commandId: 'c2' })).resolves.toEqual({ kind: 'pending' })

	const local = vi.fn(async () => new Response(JSON.stringify({ follow: { kind: 'local', id: 'u1', handle: 'bob', displayName: 'Bob' } }), { status: 200 }))
	await expect(subscribeToSource(local as unknown as typeof fetch, { url: 'https://x/users/bob/feed.xml', commandId: 'c3' })).resolves.toEqual({ kind: 'local', handle: 'bob', created: false })
})

test('subscribeToSource surfaces the neutral unavailable error', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'source unavailable' }), { status: 409 }))
	await expect(subscribeToSource(f as unknown as typeof fetch, { url: 'https://ex.com/f.xml', commandId: 'c1' })).rejects.toThrow('source unavailable')
})

test('unsubscribeSource DELETEs by stable source id and carries the command id', async () => {
	const f = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ ok: true }), { status: 200 }))
	await unsubscribeSource(f as unknown as typeof fetch, 'src 1', 'c9')
	const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
	expect(url).toBe('http://localhost:8787/me/subscriptions/src%201')
	expect(init.method).toBe('DELETE')
	expect(JSON.parse(String(init.body))).toEqual({ commandId: 'c9' })
})

test('getOwnerFollowing GETs /me/following and returns both projections', async () => {
	const view = {
		localFollows: [{ kind: 'local', id: 'u1', handle: 'bob', displayName: 'Bob' }],
		sourceSubscriptions: [{ sourceId: 's1', url: 'https://ex.com/f.xml', attributionMode: 'single_publisher', subscriptionState: 'pending', availability: 'awaiting_review' }]
	}
	const f = vi.fn(async () => new Response(JSON.stringify(view), { status: 200 }))
	await expect(getOwnerFollowing(f as unknown as typeof fetch)).resolves.toEqual(view)
	expect(f).toHaveBeenCalledWith('http://localhost:8787/me/following')
})

test('importOpmlV2 sends the command id as a header (the body is XML) and returns the v2 counts', async () => {
	const counts = { localFollowed: 1, active: 2, pending: 1, unavailable: 0, notSubscribable: 1, capSkipped: 0 }
	const f = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify(counts), { status: 200 }))
	await expect(importOpmlV2(f as unknown as typeof fetch, '<opml/>', 'c7')).resolves.toEqual(counts)
	const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
	expect(url).toBe('http://localhost:8787/me/follows/opml')
	expect(new Headers(init.headers).get('x-rsc-command-id')).toBe('c7')
	expect(String(init.body)).toBe('<opml/>')
})
