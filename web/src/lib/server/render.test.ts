import { test, expect } from 'vitest'
import { renderPostHtml } from './render'

const remote = (content: string, contentMarkdown: string | null = null) => ({ content, contentMarkdown, source: 'remote' as const })
const local = (content: string) => ({ content, contentMarkdown: null, source: 'local' as const })

test('precedence: contentMarkdown wins; local content is markdown; remote content is HTML', () => {
	expect(renderPostHtml(remote('<p>ignored</p>', '**md**'))).toContain('<strong>md</strong>')
	expect(renderPostHtml(local('**md**'))).toContain('<strong>md</strong>')
	expect(renderPostHtml(remote('<blockquote>quoted</blockquote>'))).toContain('<blockquote>quoted</blockquote>')
})

test('hostile fixtures never survive', () => {
	expect(renderPostHtml(remote('<script>alert(1)</script>ok'))).not.toContain('script')
	expect(renderPostHtml(remote('<img src="x" onerror="p()">'))).not.toContain('onerror')
	expect(renderPostHtml(remote('<a href="javascript:alert(1)">x</a>'))).not.toContain('javascript:')
	expect(renderPostHtml(remote('<img src="data:image/png;base64,xx">'))).not.toContain('data:')
	expect(renderPostHtml(remote('<svg onload="p()"></svg>'))).not.toContain('svg')
	// THE load-bearing one: markdown that embeds raw HTML — marked passes it through
	expect(renderPostHtml(remote('x', 'safe **md**\n\n<script>alert(1)</script>'))).not.toContain('script')
	expect(renderPostHtml(remote('<p class="x" style="y">attrs stripped</p>'))).not.toContain('class=')
})

test('transform-added attributes survive in the OUTPUT (allowedAttributes gotcha)', () => {
	const out = renderPostHtml(local('[x](https://a.ex) and ![i](https://a.ex/i.png)'))
	expect(out).toContain('rel="noreferrer"')
	expect(out).toContain('loading="lazy"')
})

test('GFM autolink on markdown paths', () => {
	expect(renderPostHtml(local('see https://a.ex/1'))).toContain('<a href="https://a.ex/1"')
})
