const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const ABSOLUTE = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

// The full absolute date/time — always available (the <time> element's
// title attribute), regardless of which relative bucket is shown.
export function absoluteLabel(iso: string): string {
	return ABSOLUTE.format(new Date(Date.parse(iso)))
}

// Bucketed relative text: "now" under 5s, then seconds/minutes/hours/days
// via Intl.RelativeTimeFormat (locale-correct pluralization, "yesterday"
// for exactly 1 day via numeric:'auto'), falling back to an absolute date
// at 7 days or more — "3 months ago" reads worse than a date for anything
// that old, and this threshold matches the common GitHub/Twitter convention.
export function relativeLabel(iso: string, nowMs: number): string {
	const diffMs = nowMs - Date.parse(iso)
	if (diffMs >= WEEK_MS) return absoluteLabel(iso)
	const sec = Math.round(diffMs / 1000)
	if (sec < 5) return 'now'
	if (sec < 60) return RTF.format(-sec, 'second')
	const min = Math.round(diffMs / MINUTE_MS)
	if (min < 60) return RTF.format(-min, 'minute')
	const hr = Math.round(diffMs / HOUR_MS)
	if (hr < 24) return RTF.format(-hr, 'hour')
	const day = Math.round(diffMs / DAY_MS)
	return RTF.format(-day, 'day')
}

// How long until this label next needs recomputing, in ms — null once it's
// showing an absolute date (7+ days old), since that label never changes.
// Cadence adapts to age so a stale tab left open for hours doesn't
// recompute every few seconds pointlessly.
export function nextDelayMs(iso: string, nowMs: number): number | null {
	const diffMs = nowMs - Date.parse(iso)
	if (diffMs >= WEEK_MS) return null
	if (diffMs < 2 * MINUTE_MS) return 15_000
	if (diffMs < HOUR_MS) return 60_000
	return 5 * MINUTE_MS
}
