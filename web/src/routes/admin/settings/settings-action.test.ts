import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

const cookies = { getAll: () => [{ name: 'rsc.session_token', value: 's1' }] }

function saveEvent(fields: Record<string, string>, fetch: ReturnType<typeof vi.fn>) {
	return {
		request: new Request('http://x/admin/settings?/save', { method: 'POST', body: new URLSearchParams(fields) }),
		fetch,
		url: new URL('http://x/admin/settings'),
		cookies
	}
}

const numeric = { maxSubsPerUser: '500', maxRemoteItemsPerSource: '0', maxRemoteItemAgeDays: '0', feedItemLimit: '50' }

test('save forwards only the tab fields present on the form as tabLabels/tabSubtitles partials', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
	const res = await actions.save(
		saveEvent({ ...numeric, tab_label_personal: 'My feed', tab_subtitle_public: 'All of it' }, fetch) as never
	)
	expect(res).toEqual({ saved: true })
	const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
	const body = JSON.parse(String(init.body))
	expect(body.tabLabels).toEqual({ personal: 'My feed' })
	expect(body.tabSubtitles).toEqual({ public: 'All of it' })
})

test('save omits tabLabels/tabSubtitles entirely when no tab fields are on the form (numeric-only submit stays unchanged)', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
	await actions.save(saveEvent(numeric, fetch) as never)
	const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
	const body = JSON.parse(String(init.body))
	expect(body).not.toHaveProperty('tabLabels')
	expect(body).not.toHaveProperty('tabSubtitles')
})

test('save forwards an empty tab field as "" so core clears that override', async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
	await actions.save(saveEvent({ ...numeric, tab_label_local: '' }, fetch) as never)
	const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
	const body = JSON.parse(String(init.body))
	expect(body.tabLabels).toEqual({ local: '' })
})
