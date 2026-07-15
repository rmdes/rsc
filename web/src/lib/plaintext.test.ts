import { test, expect } from 'vitest'
import { plaintext } from './plaintext'

test('strips tags, keeps text', () => {
	expect(plaintext('<div><a href="https://x.com"><img src="y.jpg" alt="z" /></a></div>Hello <b>world</b>')).toBe(
		'Hello world'
	)
})

test('decodes numeric and common named entities', () => {
	expect(plaintext('I&#8217;ve read &quot;this&quot; &amp; &#x2764; it')).toBe('I’ve read "this" & ❤ it')
})

test('collapses whitespace left by block tags', () => {
	expect(plaintext('<p>one</p>\n<p>two</p>')).toBe('one two')
})

test('plain text passes through untouched', () => {
	expect(plaintext('à lire…malheureusement…')).toBe('à lire…malheureusement…')
})
