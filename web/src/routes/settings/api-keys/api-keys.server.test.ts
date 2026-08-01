import { test, expect, vi } from 'vitest'
import { load, actions } from './+page.server.ts'

function ctx(over: Record<string, unknown> = {}) {
	return {
		fetch: vi.fn(),
		cookies: { getAll: () => [{ name: 'rsc.session_token', value: 's' }], set: vi.fn(), delete: vi.fn() },
		url: new URL('http://x/settings/api-keys'),
		...over
	}
}

test('load redirects to / when there is no session', async () => {
	const event = ctx({ cookies: { getAll: () => [], set: vi.fn(), delete: vi.fn() } })
	await expect(load(event as never)).rejects.toMatchObject({ status: 303, location: '/' })
})

test('load lists keys via /api/auth/api-key/list?configId=user, never the key value', async () => {
	const keys = [{ id: 'k1', name: 'script', prefix: 'rsc_ab', createdAt: '2026-01-01T00:00:00Z', permissions: { timeline: ['read'] } }]
	const fetch = vi.fn(async (url: string) => {
		expect(url).toContain('/api/auth/api-key/list?configId=user')
		return new Response(JSON.stringify({ apiKeys: keys }), { status: 200 })
	})
	const out = await load(ctx({ fetch }) as never)
	expect(out.keys).toEqual(keys)
})

test('create action requires at least one permission checked', async () => {
	const fetch = vi.fn()
	const form = new URLSearchParams({ name: 'script' })
	const event = ctx({ fetch, request: new Request('http://x/settings/api-keys?/create', { method: 'POST', body: form }) })
	const out = await actions.create(event as never)
	expect(out).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('create action requires a name', async () => {
	const fetch = vi.fn()
	const form = new URLSearchParams({ 'timeline:read': 'on' })
	const event = ctx({ fetch, request: new Request('http://x/settings/api-keys?/create', { method: 'POST', body: form }) })
	const out = await actions.create(event as never)
	expect(out).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('create action posts the selected permissions and returns the plaintext key ONCE in `form`, never `data`', async () => {
	const created = { id: 'k1', key: 'rsc_secret_plaintext', name: 'script', prefix: 'rsc_ab' }
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		expect(url).toContain('/me/api-keys')
		expect(JSON.parse(String(init?.body))).toEqual({ name: 'script', permissions: { timeline: ['read'], posts: ['read'] } })
		return new Response(JSON.stringify(created), { status: 201 })
	})
	const form = new URLSearchParams({ name: 'script', 'timeline:read': 'on', 'posts:read': 'on' })
	const event = ctx({ fetch, request: new Request('http://x/settings/api-keys?/create', { method: 'POST', body: form }) })
	const out = await actions.create(event as never)
	expect(out).toEqual({ createdKey: 'rsc_secret_plaintext', createdName: 'script', createdPrefix: 'rsc_ab' })
})

test('create action surfaces a core error (e.g. name too long) as a 400', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'invalid name length' }), { status: 400 }))
	const form = new URLSearchParams({ name: 'script', 'timeline:read': 'on' })
	const event = ctx({ fetch, request: new Request('http://x/settings/api-keys?/create', { method: 'POST', body: form }) })
	const out = await actions.create(event as never)
	expect(out).toMatchObject({ status: 500 })
})

test('revoke action posts the key id and redirects back to the list', async () => {
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		expect(url).toContain('/api/auth/api-key/delete')
		expect(JSON.parse(String(init?.body))).toEqual({ configId: 'user', keyId: 'k1' })
		return new Response(JSON.stringify({ success: true }), { status: 200 })
	})
	const form = new URLSearchParams({ id: 'k1' })
	const event = ctx({ fetch, request: new Request('http://x/settings/api-keys?/revoke', { method: 'POST', body: form }) })
	await expect(actions.revoke(event as never)).rejects.toMatchObject({ status: 303, location: '/settings/api-keys' })
})

test('revoke action with no id fails without calling fetch', async () => {
	const fetch = vi.fn()
	const form = new URLSearchParams()
	const event = ctx({ fetch, request: new Request('http://x/settings/api-keys?/revoke', { method: 'POST', body: form }) })
	const out = await actions.revoke(event as never)
	expect(out).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})
