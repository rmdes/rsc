import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

function formRequest(fields: Record<string, string>): Request {
	const body = new URLSearchParams(fields)
	return new Request('http://x/?/reply', { method: 'POST', body })
}

// A session cookie already present → no mint path runs; ensureSessionFetch
// just wraps `fetch` with the Cookie/Origin headers.
function sessionedEvent(fields: Record<string, string>, fetch: ReturnType<typeof vi.fn>, id = 'post-1') {
	return {
		request: formRequest(fields),
		fetch,
		params: { id },
		url: new URL('http://x/'),
		cookies: { getAll: () => [{ name: 'textcaster.session_token', value: 's1' }] }
	}
}

test('reply posts content with the viewed post as target and redirects', async () => {
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 201 }))
	await expect(actions.reply(sessionedEvent({ content: 'a reply' }, fetch) as never)).rejects.toMatchObject({ status: 303 })
	const body = JSON.parse(String(fetch.mock.calls[0][1]?.body))
	expect(body.content).toBe('a reply')
	expect(body.inReplyTo).toBe('post-1')
})

test('reply mints an anonymous session first when there is none yet', async () => {
	const mintRes = new Response(null, {
		headers: { 'set-cookie': 'textcaster.session_token=minted; Path=/; HttpOnly; Max-Age=600' }
	})
	const fetch = vi.fn(async (url: string | URL | Request, ..._rest: unknown[]) =>
		String(url).includes('/sign-in/anonymous') ? mintRes : new Response(null, { status: 201 })
	)
	const event = {
		request: formRequest({ content: 'a reply' }),
		fetch,
		params: { id: 'post-1' },
		url: new URL('http://x/'),
		cookies: { getAll: () => [], set: vi.fn(), delete: vi.fn() }
	}
	await expect(actions.reply(event as never)).rejects.toMatchObject({ status: 303 })
	expect(fetch).toHaveBeenCalledTimes(2)
	const postInit = fetch.mock.calls[1][1] as RequestInit
	expect(new Headers(postInit.headers).get('cookie')).toBe('textcaster.session_token=minted')
})

test('reply fails without content', async () => {
	const fetch = vi.fn()
	const res = await actions.reply(sessionedEvent({}, fetch) as never)
	expect(res).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})
