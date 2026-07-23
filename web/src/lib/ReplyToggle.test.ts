import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { render } from 'svelte/server'
import ReplyToggle from './ReplyToggle.svelte'

const props = { count: 2, href: '/post/abc', expanded: false, onactivate: () => {} }

test('server HTML is a real anchor to the conversation (the no-JS fallback)', () => {
  const { body } = render(ReplyToggle, { props })
  expect(body).toContain('<a ')
  expect(body).toContain('href="/post/abc"')
  expect(body).toContain('class="reply-toggle"')
})

test('count is visible, the icon is not announced, and the name is unambiguous', () => {
  const { body } = render(ReplyToggle, { props })
  expect(body).toContain('>2<') // visible numeric count, not an icon-only control
  expect(body).toMatch(/<svg[^>]*aria-hidden="true"/)
  expect(body).toContain('aria-label="Show 2 replies"')
})

test('collapsed and not loading: aria-expanded false, no aria-busy', () => {
  const { body } = render(ReplyToggle, { props })
  expect(body).toContain('aria-expanded="false"')
  expect(body).not.toContain('aria-busy')
})

test('expanded + busy surface in ARIA and in the accessible name', () => {
  const { body } = render(ReplyToggle, { props: { ...props, expanded: true, busy: true } })
  expect(body).toContain('aria-expanded="true"')
  expect(body).toContain('aria-busy="true"')
  expect(body).toContain('aria-label="Loading 2 replies"')
})

test('none of the oversized wedge pill survives', () => {
  const { body } = render(ReplyToggle, { props })
  expect(body).not.toContain('wedge')
  expect(body).not.toContain('▸')
})

// Row-unique accessible name: every row's control is "Show 2 replies" on its
// own, so the parent points it at that post's byline handle. The component
// must forward unknown attributes instead of swallowing them.
test('unknown attributes reach the anchor (aria-describedby makes the name row-unique)', () => {
  const { body } = render(ReplyToggle, { props: { ...props, 'aria-describedby': 'by-abc' } })
  expect(body).toContain('aria-describedby="by-abc"')
})

// The 44x44 floor is a plan Global Constraint living in a 1100-line shared
// stylesheet later tasks edit. Trimming it must fail CI, not a design review.
test('the 44x44 touch target survives in app.css', () => {
  const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8')
  const block = css.slice(css.indexOf('.reply-toggle {'))
  const rules = block.slice(0, block.indexOf('}'))
  expect(rules).toContain('min-height: 44px')
  expect(rules).toContain('min-width: 44px')
})
