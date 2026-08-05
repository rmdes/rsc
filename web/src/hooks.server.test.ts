import { describe, test, expect, vi } from 'vitest'
import { handle } from './hooks.server.ts'

// Matches the raw-fetch-mock convention this codebase's *.server.test.ts
// files already use for $lib/api calls (e.g. admin/api-keys/api-keys.server.test.ts,
// routes/layout.load.test.ts) — no vi.mock('$lib/api'), just a fetch stub
// returning a real Response for getMe to parse.
function makeEvent(overrides: { pathname: string; method?: string; adminResponse?: { isAdmin?: boolean } | undefined }) {
	const fetchMock = vi.fn(async () =>
		overrides.adminResponse === undefined
			? new Response(null, { status: 401 })
			: new Response(JSON.stringify(overrides.adminResponse), { status: 200 })
	)
	const event = {
		url: new URL(`http://localhost${overrides.pathname}`),
		request: new Request(`http://localhost${overrides.pathname}`, { method: overrides.method ?? 'POST' }),
		fetch: fetchMock,
		cookies: { getAll: () => [] }
	}
	return { event, fetchMock }
}

describe('hooks.server handle — admin gate', () => {
	test('a non-GET request under /admin/ with no session is rejected before resolve runs', async () => {
		const { event } = makeEvent({ pathname: '/admin/api-keys', adminResponse: undefined })
		const resolve = vi.fn()
		await expect(handle({ event, resolve } as never)).rejects.toMatchObject({ status: 404 })
		expect(resolve).not.toHaveBeenCalled()
	})

	test('a non-GET request under /admin/ from a non-admin session is rejected', async () => {
		const { event } = makeEvent({ pathname: '/admin/sources/xyz', adminResponse: { isAdmin: false } })
		const resolve = vi.fn()
		await expect(handle({ event, resolve } as never)).rejects.toMatchObject({ status: 404 })
	})

	test('a non-GET request under /admin/ from an admin session resolves normally', async () => {
		const { event } = makeEvent({ pathname: '/admin/api-keys', adminResponse: { isAdmin: true } })
		const resolve = vi.fn(async () => new Response('ok'))
		const res = await handle({ event, resolve } as never)
		expect(resolve).toHaveBeenCalledOnce()
		expect(res.status).toBe(200)
	})

	test('a GET request under /admin/ is NOT intercepted by this hook (the existing layout gate already covers navigation; this hook only closes the action gap)', async () => {
		const { event, fetchMock } = makeEvent({ pathname: '/admin/api-keys', method: 'GET', adminResponse: undefined })
		const resolve = vi.fn(async () => new Response('ok'))
		await handle({ event, resolve } as never)
		expect(resolve).toHaveBeenCalledOnce()
		expect(fetchMock).not.toHaveBeenCalled() // no redundant getMe round-trip for GETs
	})

	test('a HEAD request under /admin/ is NOT intercepted either', async () => {
		const { event, fetchMock } = makeEvent({ pathname: '/admin/api-keys', method: 'HEAD', adminResponse: undefined })
		const resolve = vi.fn(async () => new Response('ok'))
		await handle({ event, resolve } as never)
		expect(resolve).toHaveBeenCalledOnce()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('a request outside /admin/ is never checked', async () => {
		const { event, fetchMock } = makeEvent({ pathname: '/settings/api-keys', adminResponse: undefined })
		const resolve = vi.fn(async () => new Response('ok'))
		await handle({ event, resolve } as never)
		expect(resolve).toHaveBeenCalledOnce()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('exactly /admin (no trailing segment) is still gated for non-GET', async () => {
		const { event } = makeEvent({ pathname: '/admin', adminResponse: undefined })
		const resolve = vi.fn()
		await expect(handle({ event, resolve } as never)).rejects.toMatchObject({ status: 404 })
	})
})
