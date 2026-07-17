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
	// THE load-bearing one: markdown that embeds raw HTML — the unified parser drops
	// raw HTML (remark-rehype never sets allowDangerousHtml) and the sanitizer still runs after
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

// ── unified pipeline milestone ──────────────────────────────────────────
// CANONICAL DRIFT-CANARY FIXTURE: this exact input and this exact expected
// output are duplicated byte-identically in core/test/rich-content.test.ts.
// If you change either side, change both — that is the twin contract.
const CANONICAL_INPUT = [
	'line one',
	'line two :rocket:',
	'',
	'~~gone~~ and **kept**',
	'',
	'| a | b |',
	'| - | - |',
	'| 1 | 2 |',
	'',
	'```js',
	'const x = 1',
	'```',
	'',
	'- [ ] task',
	'',
	'<script>alert(1)</script>',
	'',
	'[link](javascript:alert(1)) [ok](https://example.com)',
].join('\n')

const CANONICAL_OUTPUT =
	'<p>line one<br />\nline two 🚀</p>\n<p><del>gone</del> and <strong>kept</strong></p>\n<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n<pre><code class="hljs language-js"><span class="hljs-keyword">const</span> x = <span class="hljs-number">1</span>\n</code></pre>\n<ul>\n<li> task</li>\n</ul>\n<p><a rel="noreferrer">link</a> <a href="https://example.com" rel="noreferrer">ok</a></p>'

test('canonical fixture renders byte-identically (twin: core rich-content.test.ts)', () => {
	expect(renderPostHtml({ content: CANONICAL_INPUT, source: 'local' })).toBe(CANONICAL_OUTPUT)
})

test('single newline becomes <br> (remark-breaks)', () => {
	expect(renderPostHtml({ content: 'a\nb', source: 'local' })).toBe('<p>a<br />\nb</p>')
})

test('emoji shortcode renders as bare unicode text, never a span wrapper', () => {
	const html = renderPostHtml({ content: 'hi :tada:', source: 'local' })
	expect(html).toBe('<p>hi 🎉</p>')
	expect(html).not.toContain('<span')
})

test('hljs classes survive on code/span only; arbitrary classes die', () => {
	const html = renderPostHtml({ content: '```js\nconst x = 1\n```', source: 'local' })
	expect(html).toContain('<code class="hljs language-js">')
	expect(html).toContain('<span class="hljs-keyword">const</span>')
})

test('unlabeled fence gets no hljs markup (detect stays off)', () => {
	const html = renderPostHtml({ content: '```\nplain\n```', source: 'local' })
	expect(html).toBe('<pre><code>plain\n</code></pre>')
})

test('raw inline HTML in markdown dies at the parser (allowDangerousHtml never set)', () => {
	const html = renderPostHtml({ content: 'before\n\n<script>alert(1)</script>\n\nafter', source: 'local' })
	expect(html).not.toContain('script')
	expect(html).not.toContain('alert(1)')
})

test('hljs sub-scope classes strip to the hljs- part (expected, do not fix)', () => {
	const html = renderPostHtml({ content: '```js\nfunction f() {}\n```', source: 'local' })
	expect(html).toContain('class="hljs-title"')
	expect(html).not.toContain('function_')
})

test('fence over HIGHLIGHT_MAX_CHARS skips highlighting; no hljs, no no-highlight leak (I1)', () => {
	const oversized = '```js\n' + 'x'.repeat(10001) + '\n```'
	const html = renderPostHtml({ content: oversized, source: 'local' })
	expect(html).toContain('<pre><code class="language-js">') // plain: remark-rehype's own lang class, no hljs tokens
	expect(html).not.toContain('hljs')
	expect(html).not.toContain('no-highlight')
})

test('small fence stays under HIGHLIGHT_MAX_CHARS and still gets hljs markup (guard does not over-trigger)', () => {
	const html = renderPostHtml({ content: '```js\nconst x = 1\n```', source: 'local' })
	expect(html).toContain('<code class="hljs language-js">')
})

test('highlight budget is per DOCUMENT: two 6KB fences highlight exactly once (I1 many-fences vector)', () => {
	const fence = '```js\n' + 'const y = 2\n'.repeat(500) + '```'
	const html = renderPostHtml({ content: fence + '\n\n' + fence, source: 'local' })
	expect(html.match(/class="hljs language-js"/g)?.length ?? 0).toBe(1) // first fence fits the budget
	expect(html).toContain('<pre><code class="language-js">') // second renders plain
	expect(html).not.toContain('no-highlight')
})
