import { test, expect, vi } from 'vitest'
import { load, actions } from './+page.server.ts'

function ctx(over: Record<string, unknown> = {}) {
	return {
		fetch: vi.fn(),
		cookies: { getAll: () => [{ name: 'rsc.session_token', value: 's' }], set: vi.fn(), delete: vi.fn() },
		url: new URL('http://x/settings/api-keys'),
		// Mirrors the parent layout's load return shape (+layout.server.ts):
		// `load` reads `me.isAnonymous` off it, same as accounts/+page.server.ts.
		// Registered by default; override per-test for the guest-redirect case.
		parent: async () => ({ me: { isAnonymous: false } }),
		...over
	}
}

test('load redirects to / when there is no session', async () => {
	const event = ctx({ cookies: { getAll: () => [], set: vi.fn(), delete: vi.fn() } })
	await expect(load(event as never)).rejects.toMatchObject({ status: 303, location: '/' })
})

// An anonymous guest's session sets the same cookie as a registered one
// (hasSession can't tell them apart) — the spec scopes self-serve keys to
// registered users, so `load` also checks isAnonymous off the parent layout's
// already-fetched /me before ever listing keys.
test('load redirects to / for an anonymous/guest session', async () => {
	const fetch = vi.fn()
	const event = ctx({ fetch, parent: async () => ({ me: { isAnonymous: true } }) })
	await expect(load(event as never)).rejects.toMatchObject({ status: 303, location: '/' })
	expect(fetch).not.toHaveBeenCalled()
})

test('load lists keys via /api/auth/api-key/list?configId=user, never the key value', async () => {
	const keys = [{ id: 'k1', name: 'script', prefix: 'rsc_ab', start: 'rsc_Nx7f', createdAt: '2026-01-01T00:00:00Z', permissions: { timeline: ['read'] } }]
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
	// No createdPrefix: the config-wide prefix constant is identical on every
	// key and was never rendered anywhere — dead field, dropped (Finding 2).
	expect(out).toEqual({ createdKey: 'rsc_secret_plaintext', createdName: 'script' })
})

// Core validates the name length itself now (matching the apiKey plugin's
// real 32-char limit), so a too-long name comes back as a clean 400 with
// {error: 'name invalid'} — not the plugin's raw 500 that motivated this
// test before that validation existed.
test('create action surfaces a core validation error (e.g. name too long) as a 400', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'name invalid' }), { status: 400 }))
	const form = new URLSearchParams({ name: 'a'.repeat(40), 'timeline:read': 'on' })
	const event = ctx({ fetch, request: new Request('http://x/settings/api-keys?/create', { method: 'POST', body: form }) })
	const out = await actions.create(event as never)
	expect(out).toMatchObject({ status: 400, data: { error: 'name invalid' } })
})

// A genuine core-side failure (not a clean 4xx rejection) still passes
// through as a 500 — the create action doesn't collapse every error to 400.
test('create action surfaces a genuine core server error as a 500', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
	const form = new URLSearchParams({ name: 'script', 'timeline:read': 'on' })
	const event = ctx({ fetch, request: new Request('http://x/settings/api-keys?/create', { method: 'POST', body: form }) })
	const out = await actions.create(event as never)
	expect(out).toMatchObject({ status: 500, data: { error: 'boom' } })
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
