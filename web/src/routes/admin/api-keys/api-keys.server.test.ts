import { test, expect, vi } from 'vitest'
import { load, actions } from './+page.server.ts'

// No guard()/hasSession here (unlike settings/api-keys) — this route lives
// under /admin/, so web/src/routes/admin/+layout.server.ts's own
// `if (!me?.isAdmin) throw error(404, 'Not found')` already keeps a
// non-admin from ever reaching this page's load/actions. Matches the other
// admin sub-routes (admin/users, admin/settings): plain load, no extra
// guard.
function ctx(over: Record<string, unknown> = {}) {
	return {
		fetch: vi.fn(),
		cookies: { getAll: () => [{ name: 'rsc.session_token', value: 's' }], set: vi.fn(), delete: vi.fn() },
		url: new URL('http://x/admin/api-keys'),
		...over
	}
}

test('load lists keys via /api/auth/api-key/list?configId=admin, never the key value', async () => {
	const keys = [{ id: 'k1', name: 'ops script', prefix: 'rsc_ab', start: 'rsc_Nx7f', createdAt: '2026-01-01T00:00:00Z', permissions: { 'admin.read': ['read'] } }]
	const fetch = vi.fn(async (url: string) => {
		expect(url).toContain('/api/auth/api-key/list?configId=admin')
		return new Response(JSON.stringify({ apiKeys: keys }), { status: 200 })
	})
	const out = await load(ctx({ fetch }) as never)
	expect(out.keys).toEqual(keys)
})

test('create action requires at least one permission checked', async () => {
	const fetch = vi.fn()
	const form = new URLSearchParams({ name: 'ops' })
	const event = ctx({ fetch, request: new Request('http://x/admin/api-keys?/create', { method: 'POST', body: form }) })
	const out = await actions.create(event as never)
	expect(out).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('create action requires a name', async () => {
	const fetch = vi.fn()
	const form = new URLSearchParams({ 'admin.read:read': 'on' })
	const event = ctx({ fetch, request: new Request('http://x/admin/api-keys?/create', { method: 'POST', body: form }) })
	const out = await actions.create(event as never)
	expect(out).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('create action posts the selected permissions to POST /admin/api-keys and returns the plaintext key ONCE in `form`, never `data`', async () => {
	const created = { id: 'k1', key: 'rsc_admin_secret_plaintext', name: 'ops', prefix: 'rsc_ab' }
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		expect(url).toContain('/admin/api-keys')
		expect(JSON.parse(String(init?.body))).toEqual({ name: 'ops', permissions: { 'admin.read': ['read'] } })
		return new Response(JSON.stringify(created), { status: 201 })
	})
	const form = new URLSearchParams({ name: 'ops', 'admin.read:read': 'on' })
	const event = ctx({ fetch, request: new Request('http://x/admin/api-keys?/create', { method: 'POST', body: form }) })
	const out = await actions.create(event as never)
	expect(out).toEqual({ createdKey: 'rsc_admin_secret_plaintext', createdName: 'ops' })
})

// The accumulation fix phase 3's Task 4 made in settings/api-keys must be
// present here from the start, not reintroduced as an overwrite bug — this
// panel's own permissions don't currently overlap on the same resource
// (admin.read/admin.sources/admin.moderation are each single-action), but
// the loop itself must still accumulate rather than overwrite so a future
// resource with two checkboxes works correctly without revisiting this file.
test('create action accumulates checked permissions across distinct resources', async () => {
	let capturedBody: { permissions: Record<string, string[]> } | undefined
	const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
		capturedBody = JSON.parse(String(init?.body))
		return new Response(JSON.stringify({ id: 'k1', key: 'rsc_admin_x', name: 'ops' }), { status: 201 })
	})
	const form = new URLSearchParams({ name: 'ops', 'admin.read:read': 'on', 'admin.sources:write': 'on' })
	const event = ctx({ fetch, request: new Request('http://x/admin/api-keys?/create', { method: 'POST', body: form }) })
	await actions.create(event as never)
	expect(capturedBody?.permissions).toEqual({ 'admin.read': ['read'], 'admin.sources': ['write'] })
})

test('create action surfaces a core validation error (e.g. name too long) as a 400', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'name invalid' }), { status: 400 }))
	const form = new URLSearchParams({ name: 'a'.repeat(40), 'admin.read:read': 'on' })
	const event = ctx({ fetch, request: new Request('http://x/admin/api-keys?/create', { method: 'POST', body: form }) })
	const out = await actions.create(event as never)
	expect(out).toMatchObject({ status: 400, data: { error: 'name invalid' } })
})

test('create action surfaces a genuine core server error as a 500', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
	const form = new URLSearchParams({ name: 'ops', 'admin.read:read': 'on' })
	const event = ctx({ fetch, request: new Request('http://x/admin/api-keys?/create', { method: 'POST', body: form }) })
	const out = await actions.create(event as never)
	expect(out).toMatchObject({ status: 500, data: { error: 'boom' } })
})

test('create action redirects to / on a 401 (session expired mid-flow)', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'authentication required' }), { status: 401 }))
	const form = new URLSearchParams({ name: 'ops', 'admin.read:read': 'on' })
	const event = ctx({ fetch, request: new Request('http://x/admin/api-keys?/create', { method: 'POST', body: form }) })
	await expect(actions.create(event as never)).rejects.toMatchObject({ status: 303, location: '/' })
})

// revokeApiKey is reused verbatim from $lib/api, but it MUST be called with
// configId:'admin' here — the plugin's delete handler 404s a keyId looked up
// under the wrong configId (confirmed against @better-auth/api-key's
// installed source: configIdMatches(apiKey.configId, lookupOpts.configId)).
test('revoke action posts configId:admin + the key id, and redirects back to the list', async () => {
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		expect(url).toContain('/api/auth/api-key/delete')
		expect(JSON.parse(String(init?.body))).toEqual({ configId: 'admin', keyId: 'k1' })
		return new Response(JSON.stringify({ success: true }), { status: 200 })
	})
	const form = new URLSearchParams({ id: 'k1' })
	const event = ctx({ fetch, request: new Request('http://x/admin/api-keys?/revoke', { method: 'POST', body: form }) })
	await expect(actions.revoke(event as never)).rejects.toMatchObject({ status: 303, location: '/admin/api-keys' })
})

test('revoke action with no id fails without calling fetch', async () => {
	const fetch = vi.fn()
	const form = new URLSearchParams()
	const event = ctx({ fetch, request: new Request('http://x/admin/api-keys?/revoke', { method: 'POST', body: form }) })
	const out = await actions.revoke(event as never)
	expect(out).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('revoke action surfaces a core 404 (e.g. an already-revoked key) as a 404, not a 500', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'key not found' }), { status: 404 }))
	const form = new URLSearchParams({ id: 'gone' })
	const event = ctx({ fetch, request: new Request('http://x/admin/api-keys?/revoke', { method: 'POST', body: form }) })
	const out = await actions.revoke(event as never)
	expect(out).toMatchObject({ status: 404, data: { error: 'key not found' } })
})

test('revoke action surfaces a genuine core server error as a 500', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
	const form = new URLSearchParams({ id: 'k1' })
	const event = ctx({ fetch, request: new Request('http://x/admin/api-keys?/revoke', { method: 'POST', body: form }) })
	const out = await actions.revoke(event as never)
	expect(out).toMatchObject({ status: 500, data: { error: 'boom' } })
})

test('revoke action redirects to / on a 401 (session expired mid-flow)', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'authentication required' }), { status: 401 }))
	const form = new URLSearchParams({ id: 'k1' })
	const event = ctx({ fetch, request: new Request('http://x/admin/api-keys?/revoke', { method: 'POST', body: form }) })
	await expect(actions.revoke(event as never)).rejects.toMatchObject({ status: 303, location: '/' })
})
