import { test, expect, vi } from 'vitest'
import { actions } from './admin/settings/+page.server.ts'

function saveEvent(fields: Record<string, string>, fetch: ReturnType<typeof vi.fn>) {
	return {
		request: new Request('http://x/admin/settings?/save', { method: 'POST', body: new URLSearchParams(fields) }),
		fetch,
		url: new URL('http://x/admin/settings'),
		cookies: { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }
	}
}

test('save PATCHes valid integer caps', async () => {
	const fetch = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ maxSubsPerUser: 250, maxRemoteItemsPerSource: 100, maxRemoteItemAgeDays: 30, feedItemLimit: 50 }),
				{ status: 200 }
			)
	)
	const res = await actions.save(
		saveEvent(
			{ maxSubsPerUser: '250', maxRemoteItemsPerSource: '100', maxRemoteItemAgeDays: '30', feedItemLimit: '50' },
			fetch
		) as never
	)
	expect(res).toEqual({ saved: true })
	expect(fetch).toHaveBeenCalled()
	const init = (fetch.mock.calls[0] as unknown[])?.[1] as RequestInit | undefined
	expect(init?.method).toBe('PATCH')
	expect(JSON.parse(String(init?.body))).toEqual({
		maxSubsPerUser: 250,
		maxRemoteItemsPerSource: 100,
		maxRemoteItemAgeDays: 30,
		feedItemLimit: 50
	})
})

test('save accepts 0 for maxRemoteItemsPerSource and maxRemoteItemAgeDays (unlimited)', async () => {
	const fetch = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ maxSubsPerUser: 250, maxRemoteItemsPerSource: 0, maxRemoteItemAgeDays: 0, feedItemLimit: 50 }),
				{ status: 200 }
			)
	)
	const res = await actions.save(
		saveEvent(
			{ maxSubsPerUser: '250', maxRemoteItemsPerSource: '0', maxRemoteItemAgeDays: '0', feedItemLimit: '50' },
			fetch
		) as never
	)
	expect(res).toEqual({ saved: true })
	const init = (fetch.mock.calls[0] as unknown[])?.[1] as RequestInit | undefined
	expect(JSON.parse(String(init?.body))).toEqual({
		maxSubsPerUser: 250,
		maxRemoteItemsPerSource: 0,
		maxRemoteItemAgeDays: 0,
		feedItemLimit: 50
	})
})

test('save forwards feedItemLimit', async () => {
	const fetch = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ maxSubsPerUser: 250, maxRemoteItemsPerSource: 100, maxRemoteItemAgeDays: 30, feedItemLimit: 25 }),
				{ status: 200 }
			)
	)
	const res = await actions.save(
		saveEvent(
			{ maxSubsPerUser: '250', maxRemoteItemsPerSource: '100', maxRemoteItemAgeDays: '30', feedItemLimit: '25' },
			fetch
		) as never
	)
	expect(res).toEqual({ saved: true })
	const init = (fetch.mock.calls[0] as unknown[])?.[1] as RequestInit | undefined
	expect(JSON.parse(String(init?.body))).toEqual({
		maxSubsPerUser: 250,
		maxRemoteItemsPerSource: 100,
		maxRemoteItemAgeDays: 30,
		feedItemLimit: 25
	})
})

test('save rejects a feedItemLimit below 1', async () => {
	const fetch = vi.fn()
	const res = await actions.save(
		saveEvent(
			{ maxSubsPerUser: '250', maxRemoteItemsPerSource: '100', maxRemoteItemAgeDays: '30', feedItemLimit: '0' },
			fetch
		) as never
	)
	expect(res).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})

test('save rejects non-integer and negative values without calling core', async () => {
	const fetch = vi.fn()
	const valid = { maxSubsPerUser: '250', maxRemoteItemsPerSource: '100', maxRemoteItemAgeDays: '30', feedItemLimit: '25' }
	expect(await actions.save(saveEvent({ ...valid, maxSubsPerUser: 'abc' }, fetch) as never)).toMatchObject({
		status: 400
	})
	expect(await actions.save(saveEvent({ ...valid, maxSubsPerUser: '-1' }, fetch) as never)).toMatchObject({
		status: 400
	})
	expect(
		await actions.save(saveEvent({ ...valid, maxRemoteItemsPerSource: 'abc' }, fetch) as never)
	).toMatchObject({ status: 400 })
	expect(
		await actions.save(saveEvent({ ...valid, maxRemoteItemsPerSource: '-1' }, fetch) as never)
	).toMatchObject({ status: 400 })
	expect(
		await actions.save(saveEvent({ ...valid, maxRemoteItemAgeDays: 'abc' }, fetch) as never)
	).toMatchObject({ status: 400 })
	expect(
		await actions.save(saveEvent({ ...valid, maxRemoteItemAgeDays: '-1' }, fetch) as never)
	).toMatchObject({ status: 400 })
	expect(fetch).not.toHaveBeenCalled()
})
