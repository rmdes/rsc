import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

const cookies = { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }

function formEvent(fields: Record<string, string[] | string>, fetch: ReturnType<typeof vi.fn>) {
	const form = new URLSearchParams()
	for (const [k, v] of Object.entries(fields)) for (const val of Array.isArray(v) ? v : [v]) form.append(k, val)
	return {
		request: new Request('http://x/admin/users?/bulkDelete', { method: 'POST', body: form }),
		fetch,
		url: new URL('http://x/admin/users'),
		cookies
	}
}

test('bulkDelete deletes each selected handle independently and reports per-row outcomes', async () => {
	const fetch = vi.fn(async (url: string | URL) => {
		const u = String(url)
		if (u.includes('/users/alice')) return new Response(null, { status: 204 })
		if (u.includes('/users/bob')) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
		throw new Error(`unexpected fetch ${u}`)
	})
	const res = (await actions.bulkDelete(formEvent({ handle: ['alice', 'bob'] }, fetch) as never)) as { bulkDeleteResults: { handle: string; ok: boolean; error?: string }[] }
	expect(res.bulkDeleteResults).toEqual([
		{ handle: 'alice', ok: true },
		{ handle: 'bob', ok: false, error: 'not found' }
	])
})

test('bulkDelete with zero selected handles is a no-op', async () => {
	const fetch = vi.fn()
	const res = (await actions.bulkDelete(formEvent({}, fetch) as never)) as { bulkDeleteResults: unknown[] }
	expect(res.bulkDeleteResults).toEqual([])
	expect(fetch).not.toHaveBeenCalled()
})
