import { test, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { actions } from './+page.server.ts'

function formRequest(action: string, fields: Record<string, string>): Request {
	const body = new URLSearchParams(fields)
	return new Request(`http://x/?/${action}`, { method: 'POST', body })
}

// A session cookie already present → no mint path runs; ensureSessionFetch
// just wraps `fetch` with the Cookie/Origin headers.
function sessionedEvent(request: Request, fetch: ReturnType<typeof vi.fn>) {
	return {
		request,
		fetch,
		url: new URL('http://x/'),
		cookies: { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }
	}
}

test('compose posts content and redirects (session already present, no mint)', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 201 }))
	await expect(actions.compose(sessionedEvent(formRequest('compose', { content: 'hi' }), fetch) as never)).rejects.toMatchObject({
		status: 303
	}) // redirect throws
	expect(fetch).toHaveBeenCalledTimes(1) // no mint call — the session cookie already exists
	const init = fetch.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('cookie')).toBe('rsc.session_token=s1')
	expect(JSON.parse(String(init.body))).toEqual({ content: 'hi' })
})

test('compose mints an anonymous session first when there is none yet', async () => {
	const mintRes = new Response(null, {
		headers: { 'set-cookie': 'rsc.session_token=minted; Path=/; HttpOnly; Max-Age=600' }
	})
	const fetch = vi.fn(async (url: string | URL | Request, ..._rest: unknown[]) =>
		String(url).includes('/sign-in/anonymous') ? mintRes : new Response(null, { status: 201 })
	)
	const event = {
		request: formRequest('compose', { content: 'hi' }),
		fetch,
		url: new URL('http://x/'),
		cookies: { getAll: () => [], set: vi.fn(), delete: vi.fn() },
		getClientAddress: () => '203.0.113.5'
	}
	await expect(actions.compose(event as never)).rejects.toMatchObject({ status: 303 })
	expect(fetch).toHaveBeenCalledTimes(2) // mint, then the sessioned createPost call
	const postInit = fetch.mock.calls[1][1] as RequestInit
	expect(new Headers(postInit.headers).get('cookie')).toBe('rsc.session_token=minted')
})

test('compose fails without content', async () => {
	const fetch = vi.fn()
	const res = await actions.compose(sessionedEvent(formRequest('compose', {}), fetch) as never)
	expect(res).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('compose returns fail(400) when the core rejects the request', async () => {
	const fetch = vi.fn(async () => new Response(null, { status: 400 }))
	const res = await actions.compose(sessionedEvent(formRequest('compose', { content: 'hi' }), fetch) as never)
	expect(res).toMatchObject({ status: 400 })
	expect((res as { data: { error: string } }).data.error).toMatch(/createPost/)
})


test('subscribe surfaces the cap error from the source endpoint', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'subscription limit reached' }), { status: 429 }))
	const capped = await actions.subscribe(sessionedEvent(formRequest('subscribe', { url: 'https://ex.com/f.xml', commandId: 'cmd-1' }), fetch) as never)
	expect(capped).toMatchObject({ status: 400 })
	expect((capped as { data: { error: string } }).data.error).toMatch(/subscription limit reached/)
})

test('SvelteKit CSRF origin check stays on (SEC-2: it is the real browser-boundary defense)', () => {
	// No svelte.config.js exists in this repo — the sveltekit() vite plugin
	// (web/vite.config.ts) is the only place kit config could disable it.
	const cfg = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8')
	expect(cfg).not.toMatch(/checkOrigin\s*:\s*false/)
	expect(cfg).not.toMatch(/csrf\s*:\s*false/)
})

test('compose redirects back to the active tab; invalid tab params are dropped', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 201 }))
	const good = sessionedEvent(formRequest('compose', { content: 'hi' }), fetch)
	good.url = new URL('http://x/?tab=local&/compose')
	await expect(actions.compose(good as never)).rejects.toMatchObject({ status: 303, location: '/?tab=local' })
	const bad = sessionedEvent(formRequest('compose', { content: 'hi' }), fetch)
	bad.url = new URL('http://x/?tab=evil&/compose')
	await expect(actions.compose(bad as never)).rejects.toMatchObject({ status: 303, location: '/' })
})


// --- v2 source registry -------------------------------------------------------

test('subscribe posts url+commandId to the v2 source endpoint', async () => {
	const fetch = vi.fn(
		async (..._a: unknown[]) =>
			new Response(
				JSON.stringify({ subscription: { sourceId: 's1', url: 'https://ex.com/f.xml', attributionMode: 'single_publisher', subscriptionState: 'active', availability: 'available' } }),
				{ status: 201 }
			)
	)
	const event = sessionedEvent(formRequest('subscribe', { url: 'https://ex.com/f.xml', commandId: 'cmd-1' }), fetch)
	await expect(actions.subscribe(event as never)).rejects.toMatchObject({ status: 303, location: '/?tab=personal&sub=added' })
	const post = fetch.mock.calls.find((c) => String(c[0]).includes('/me/subscriptions')) as unknown as [string, RequestInit]
	expect(JSON.parse(String(post[1].body))).toEqual({ url: 'https://ex.com/f.xml', commandId: 'cmd-1' }) // no `type` under v2
})

test('a pending v2 subscription lands on the neutral awaiting-review flash', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ subscription: 'pending', message: 'This source is awaiting review.' }), { status: 202 }))
	const event = sessionedEvent(formRequest('subscribe', { url: 'https://ex.com/f.xml', commandId: 'cmd-2' }), fetch)
	await expect(actions.subscribe(event as never)).rejects.toMatchObject({ status: 303, location: '/?tab=personal&sub=pending' })
})

test('a v2 subscribe that resolves to a local account still lands on the personal river flash', async () => {
	const fetch = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ follow: { kind: 'local', id: 'u1', handle: 'bob', displayName: 'Bob' } }), { status: 201 }))
	const event = sessionedEvent(formRequest('subscribe', { url: 'https://x/users/bob/feed.xml', commandId: 'cmd-3' }), fetch)
	await expect(actions.subscribe(event as never)).rejects.toMatchObject({ status: 303, location: '/?tab=personal&feed=bob' })
})
