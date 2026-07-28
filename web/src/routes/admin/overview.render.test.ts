import { test, expect } from 'vitest'
import { render } from 'svelte/server'

const { default: Page } = await import('./+page.svelte')

function overview(over: Record<string, unknown> = {}) {
	return {
		counts: { registeredUsers: 3, guests: 1, remoteFeeds: 5, posts: 42 },
		federation: { websub: 'subscriber', rssCloud: true, pushIn: true, publicUrl: 'https://example.test' },
		mailEnabled: true,
		adminEmails: [],
		scheduler: { catalogSize: 12, mostOverdueSeconds: 340, attemptedLastWindow: 8, windowSpanSeconds: 610 },
		...over
	}
}

test('populated scheduler stats render with human-readable durations', () => {
	const { body } = render(Page, { props: { data: { overview: overview() } } } as never)

	expect(body).toContain('Poll scheduler')
	expect(body).toContain('12') // catalogSize
	expect(body).toContain('6m') // 340s -> 5.67m rounds to 6m
	expect(body).toContain('8') // attemptedLastWindow
	expect(body).toContain('10m') // 610s -> 10.17m rounds to 10m
})

test('null scheduler fields render human copy, not "null" or "NaN"', () => {
	const { body } = render(Page, {
		props: {
			data: {
				overview: overview({
					scheduler: { catalogSize: 0, mostOverdueSeconds: null, attemptedLastWindow: 0, windowSpanSeconds: null }
				})
			}
		}
	} as never)

	expect(body).toContain('never polled')
	expect(body).toContain('no data yet')
	expect(body).not.toContain('null')
	expect(body).not.toContain('NaN')
})
