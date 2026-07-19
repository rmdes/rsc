import { test, expect, vi } from 'vitest'
import { actions } from './admin/settings/+page.server.ts'

function saveEvent(fields: Record<string, string>, fetch: ReturnType<typeof vi.fn>) {
	return {
		request: new Request('http://x/admin/settings?/save', { method: 'POST', body: new URLSearchParams(fields) }),
		fetch,
		url: new URL('http://x/admin/settings'),
		cookies: { getAll: () => [{ name: 'textcaster.session_token', value: 's1' }] }
	}
}

test('save PATCHes a valid integer cap', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ maxSubsPerUser: 250 }), { status: 200 }))
	const res = await actions.save(saveEvent({ maxSubsPerUser: '250' }, fetch) as never)
	expect(res).toEqual({ saved: true })
	expect(fetch).toHaveBeenCalled()
	const init = (fetch.mock.calls[0] as unknown[])?.[1] as RequestInit | undefined
	expect(init?.method).toBe('PATCH')
	expect(JSON.parse(String(init?.body))).toEqual({ maxSubsPerUser: 250 })
})

test('save rejects non-integer and negative values without calling core', async () => {
	const fetch = vi.fn()
	expect(await actions.save(saveEvent({ maxSubsPerUser: 'abc' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(await actions.save(saveEvent({ maxSubsPerUser: '-1' }, fetch) as never)).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})
