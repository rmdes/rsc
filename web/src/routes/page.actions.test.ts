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
		cookies: { getAll: () => [{ name: 'textcaster.session_token', value: 's1' }] }
	}
}

test('compose posts content and redirects (session already present, no mint)', async () => {
	const fetch = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 201 }))
	await expect(actions.compose(sessionedEvent(formRequest('compose', { content: 'hi' }), fetch) as never)).rejects.toMatchObject({
		status: 303
	}) // redirect throws
	expect(fetch).toHaveBeenCalledTimes(1) // no mint call — the session cookie already exists
	const init = fetch.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('cookie')).toBe('textcaster.session_token=s1')
	expect(JSON.parse(String(init.body))).toEqual({ content: 'hi' })
})

test('compose mints an anonymous session first when there is none yet', async () => {
	const mintRes = new Response(null, {
		headers: { 'set-cookie': 'textcaster.session_token=minted; Path=/; HttpOnly; Max-Age=600' }
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
	expect(new Headers(postInit.headers).get('cookie')).toBe('textcaster.session_token=minted')
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


test('subscribe follows a feed and redirects to the personal river', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ user: { id: 'r1', handle: 'blog', displayName: 'B', kind: 'remote', feedType: 'webfeed' }, followed: true }), { status: 201 }))
	const event = sessionedEvent(formRequest('subscribe', { url: 'https://ex.com/f.xml', type: 'webfeed' }), fetch)
	await expect(actions.subscribe(event as never)).rejects.toMatchObject({ status: 303, location: '/?tab=personal&feed=blog' })
})

test('subscribe to an instance URL lands on federated with no flash', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ user: { id: 'i1', handle: 'peer', displayName: 'P', kind: 'remote', feedType: 'instance' }, followed: false }), { status: 200 }))
	const event = sessionedEvent(formRequest('subscribe', { url: 'https://peer.ex/f.xml', type: 'webfeed' }), fetch)
	await expect(actions.subscribe(event as never)).rejects.toMatchObject({ status: 303, location: '/?tab=federated' })
})

test('subscribe to your own feed URL lands on personal with no flash', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ user: { id: 'me1', handle: 'me', displayName: 'Me', kind: 'local' }, followed: false }), { status: 200 }))
	const event = sessionedEvent(formRequest('subscribe', { url: 'https://x/users/me/feed.xml', type: 'webfeed' }), fetch)
	await expect(actions.subscribe(event as never)).rejects.toMatchObject({ status: 303, location: '/?tab=personal' })
})

test('subscribe surfaces the cap error and rejects a bad type', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'subscription limit reached' }), { status: 429 }))
	const capped = await actions.subscribe(sessionedEvent(formRequest('subscribe', { url: 'https://ex.com/f.xml', type: 'webfeed' }), fetch) as never)
	expect(capped).toMatchObject({ status: 400 })
	expect((capped as { data: { error: string } }).data.error).toMatch(/subscription limit reached/)
	const bad = await actions.subscribe(sessionedEvent(formRequest('subscribe', { url: 'https://ex.com/f.xml', type: 'nope' }), fetch) as never)
	expect(bad).toMatchObject({ status: 400 })
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

