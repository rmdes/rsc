import { test, expect } from 'vitest'
import { relativeLabel, absoluteLabel, nextDelayMs } from './relative-time.ts'

const NOW = Date.parse('2026-07-30T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

test('relativeLabel: under 5 seconds reads "now"', () => {
	expect(relativeLabel(iso(2_000), NOW)).toBe('now')
})

test('relativeLabel: seconds bucket', () => {
	expect(relativeLabel(iso(30_000), NOW)).toBe('30 seconds ago')
})

test('relativeLabel: minutes bucket', () => {
	expect(relativeLabel(iso(2 * 60_000), NOW)).toBe('2 minutes ago')
	expect(relativeLabel(iso(59 * 60_000), NOW)).toBe('59 minutes ago')
})

test('relativeLabel: hours bucket', () => {
	expect(relativeLabel(iso(3 * 3_600_000), NOW)).toBe('3 hours ago')
	expect(relativeLabel(iso(23 * 3_600_000), NOW)).toBe('23 hours ago')
})

test('relativeLabel: days bucket, "yesterday" for exactly 1 day', () => {
	expect(relativeLabel(iso(24 * 3_600_000), NOW)).toBe('yesterday')
	expect(relativeLabel(iso(6 * 24 * 3_600_000), NOW)).toBe('6 days ago')
})

test('relativeLabel: 7 days or more falls back to an absolute date', () => {
	const sevenDaysAgo = iso(7 * 24 * 3_600_000)
	expect(relativeLabel(sevenDaysAgo, NOW)).toBe(absoluteLabel(sevenDaysAgo))
	expect(relativeLabel(sevenDaysAgo, NOW)).not.toContain('ago')
})

test('absoluteLabel: full date + time', () => {
	expect(absoluteLabel('2026-07-30T12:00:00.000Z')).toBe(absoluteLabel('2026-07-30T12:00:00.000Z'))
	expect(absoluteLabel('2026-07-30T12:00:00.000Z')).toMatch(/2026/)
})

test('nextDelayMs: 15s cadence under 2 minutes old', () => {
	expect(nextDelayMs(iso(30_000), NOW)).toBe(15_000)
})

test('nextDelayMs: 60s cadence under 1 hour old', () => {
	expect(nextDelayMs(iso(10 * 60_000), NOW)).toBe(60_000)
})

test('nextDelayMs: 5 minute cadence under 1 day old', () => {
	expect(nextDelayMs(iso(5 * 3_600_000), NOW)).toBe(5 * 60_000)
})

test('nextDelayMs: null (stop ticking) at 7 days or more', () => {
	expect(nextDelayMs(iso(7 * 24 * 3_600_000), NOW)).toBeNull()
})
