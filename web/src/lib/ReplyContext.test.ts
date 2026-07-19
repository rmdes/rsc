import { test, expect } from 'vitest'
import { render } from 'svelte/server'
import ReplyContext from './ReplyContext.svelte'

test('author + snippet + url → text with an <a>, quoted snippet', () => {
  const { body } = render(ReplyContext, { props: { author: 'aaronpk', snippet: 'hi', url: 'https://a/1' } })
  expect(body).toContain('In reply to aaronpk')
  expect(body).toContain('“hi”')
  expect(body).toContain('href="https://a/1"')
})
test('author only → no colon, no quotes (F5/P9 — never “”)', () => {
  const { body } = render(ReplyContext, { props: { author: 'aaronpk' } })
  expect(body).toContain('In reply to aaronpk')
  expect(body).not.toContain('“')
})
test('author/snippet are escaped text, not HTML (security boundary)', () => {
  const { body } = render(ReplyContext, { props: { author: '<b>x</b>', snippet: '<i>y</i>' } })
  expect(body).not.toContain('<b>')
  // Svelte's text-node escaping (svelte/src/escaping.js) escapes '&' and '<'
  // only — a bare '>' can't open a tag, so it's left as-is. '&lt;b>' proves
  // the dangerous '<' was escaped without a raw <b> element ever appearing.
  expect(body).toContain('&lt;b>')
})
