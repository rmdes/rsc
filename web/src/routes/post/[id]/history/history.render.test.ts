import { test, expect } from 'vitest'
import { render } from 'svelte/server'
import Page from './+page.svelte'

// The maintainer's pin: "a local post with two revisions RENDERS."
// Under v2 the projector gives every non-current revision updatedAt: null, so the
// loader hands the component two versions with NO timestamp. Two failures used to
// live here: (1) both untimed rows keyed on '' -> Svelte duplicate-key crash on the
// client; (2) each untimed row emitted a dishonest <time datetime="">. This proves
// the SSR output is honest (no empty <time>) and carries an honest neutral label.
// NOTE: the duplicate-key throw is a CLIENT-side reconciliation check (svelte's
// internal/client validate_each_keys); pure svelte/server SSR never reconciles keys,
// so the unique-key root cause is pinned in history.load.test.ts as a data-shape
// assertion. This render test guards the honest-display half.
test('v2: two untimed revisions render — no dishonest <time datetime="">, honest label instead', () => {
	const data = {
		postId: 'p1',
		editedAt: null,
		currentHtml: '<p>now</p>',
		versions: [
			{ key: 0, seenAt: '', html: '<p>first</p>' },
			{ key: 1, seenAt: '', html: '<p>second</p>' }
		]
	}
	const { body } = render(Page, { props: { data } } as never)
	expect(body).not.toContain('datetime=""') // no fake empty <time>
	expect(body).toContain('earlier version') // honest neutral marker
	expect(body).toContain('first')
	expect(body).toContain('second')
	expect(body).toContain('now')
})

// The v1 legacy branch still carries a real seen_at; a real timestamp must keep its
// honest <time> element.
test('v1: a revision with a real timestamp still renders a real <time>', () => {
	const data = {
		postId: 'p1',
		editedAt: null,
		currentHtml: '<p>now</p>',
		versions: [{ key: 0, seenAt: '2026-07-20T10:00:00Z', html: '<p>old</p>' }]
	}
	const { body } = render(Page, { props: { data } } as never)
	expect(body).toContain('datetime="2026-07-20T10:00:00Z"')
})
