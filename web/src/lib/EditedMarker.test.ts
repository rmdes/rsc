import { test, expect } from 'vitest'
import { render } from 'svelte/server'
import EditedMarker from './EditedMarker.svelte'

// Task 3: /post/:id/history 404s for a removed post (Task 2) — the marker must
// degrade to plain text, not offer a dead link. Same class/label either way (no
// distinct visual treatment, per the brief: the words carry the meaning).

test('an ordinary edited post links "edited" to its history', () => {
	const { body } = render(EditedMarker, { props: { post: { id: 'p1', editedAt: '2026-08-01T00:00:00.000Z' } } })
	expect(body).toContain('href="/post/p1/history"')
	expect(body).toContain('edited')
})

test('a removed post renders "edited" as plain text, never a link to the 404ing history page', () => {
	const { body } = render(EditedMarker, { props: { post: { id: 'p1', editedAt: '2026-08-01T00:00:00.000Z', removed: true } } })
	expect(body).not.toContain('href="/post/p1/history"')
	expect(body).not.toContain('<a')
	expect(body).toContain('edited')
	expect(body).toContain('class="edited"') // same label style, just not interactive
})

test('an unedited post renders no "edited" marker, removed or not', () => {
	const { body } = render(EditedMarker, { props: { post: { id: 'p1' } } })
	expect(body).not.toContain('edited')
	const removed = render(EditedMarker, { props: { post: { id: 'p1', removed: true } } })
	expect(removed.body).not.toContain('edited')
})
