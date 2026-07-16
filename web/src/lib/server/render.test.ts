import { test, expect } from 'vitest'
import { renderPostHtml, enrichEntries } from './render'
import { PREVIEW_SANITIZE_OPTS } from '../preview-sanitize'

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
	expect(renderPostHtml(remote('<a href="//evil.com">x</a>'))).not.toContain('href=')
})

test('transform-added attributes survive in the OUTPUT (allowedAttributes gotcha)', () => {
	const out = renderPostHtml(local('[x](https://a.ex) and ![i](https://a.ex/i.png)'))
	expect(out).toContain('rel="noreferrer"')
	expect(out).toContain('loading="lazy"')
})

test('GFM autolink on markdown paths', () => {
	expect(renderPostHtml(local('see https://a.ex/1'))).toContain('<a href="https://a.ex/1"')
})

test('enrichEntries adds contentHtml per entry and leaves other fields untouched', () => {
	const entry = { id: 'p-1', content: '**md**', contentMarkdown: null, source: 'local' as const }
	const [out] = enrichEntries([entry])
	expect(out.contentHtml).toContain('<strong>md</strong>')
	expect(out.id).toBe('p-1')
	expect(out.content).toBe('**md**')
})

test('GFM parity: tables and strikethrough survive; task-list checkboxes never do', () => {
	const table = renderPostHtml(local('| a | b |\n| - | - |\n| 1 | 2 |'))
	expect(table).toContain('<table>')
	expect(table).toContain('<td>1</td>')
	expect(renderPostHtml(local('~~gone~~'))).toContain('<del>gone</del>')
	const task = renderPostHtml(local('- [ ] never a checkbox'))
	expect(task).not.toContain('<input')
	expect(task).toContain('never a checkbox') // degrades to text, not silence
})

test('preview sanitizer forbids what the server strips (parity pin)', () => {
	expect(PREVIEW_SANITIZE_OPTS.FORBID_TAGS).toContain('input')
	expect(PREVIEW_SANITIZE_OPTS.FORBID_ATTR).toContain('align')
})
