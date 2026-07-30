import { test, expect } from 'vitest'
import { render } from 'svelte/server'
import RelativeTime from './RelativeTime.svelte'

test('renders a <time> element with the datetime attribute and a relative label', () => {
	const iso = new Date(Date.now() - 2 * 60_000).toISOString() // 2 minutes ago
	const { body } = render(RelativeTime, { props: { datetime: iso } } as never)

	expect(body).toContain(`datetime="${iso}"`)
	expect(body).toContain('minute')
})

test('an item older than 7 days renders an absolute date, not "ago"', () => {
	const iso = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString()
	const { body } = render(RelativeTime, { props: { datetime: iso } } as never)

	expect(body).not.toContain('ago')
	expect(body).toMatch(/\d{4}/) // a year, from the absolute date
})

test('the title attribute always carries the full absolute date/time', () => {
	const iso = new Date(Date.now() - 30_000).toISOString()
	const { body } = render(RelativeTime, { props: { datetime: iso } } as never)

	expect(body).toContain('title="')
	expect(body).toMatch(/title="[^"]*\d{4}[^"]*"/) // title contains a year
})
