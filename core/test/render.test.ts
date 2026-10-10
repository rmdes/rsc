import { test, expect } from 'vitest'
import { renderMarkdown, sanitize } from '@rsc/render/src/render.ts'

// The XSS gate's own suite (render/src/render.ts, @rsc/render). It runs in
// core's suite because render/ has no runner of its own: vitest does not hoist
// in this repo, so a runner would install into render/node_modules on the dev
// bind mount. Consumer contracts stay with their consumers —
// core/test/rich-content.test.ts (feeds) and web/src/lib/server/render.test.ts
// (display precedence).
//
// The gate has TWO entry points that are deliberately NOT equivalent: same
// SANITIZE_CONFIG, different paths. renderMarkdown parses as markdown, so a
// raw-HTML BLOCK is dropped wholesale by remark before the sanitizer runs;
// sanitize() cleans untrusted HTML directly, so benign text survives. Same
// input, two correct answers — measured (2026-08-07), not assumed.

test('SEC-4: renderMarkdown renders markdown and sanitizes raw HTML a member typed', () => {
  const html = renderMarkdown('**bold** then <script>alert(1)</script> and https://a.ex/1')
  expect(html).toContain('<strong>bold</strong>')
  expect(html).toContain('<a href="https://a.ex/1" rel="noreferrer">') // GFM autolink + forced rel
  expect(html).not.toContain('<script>')
})

test('renderMarkdown: hostile fixtures never survive', () => {
  // Every assertion here is negative, so ALL of them pass if renderMarkdown
  // returns '' — proven by mutation probe (2026-08-07), which made this test
  // green against a completely broken sanitizer. The paired positive assertions
  // are what make it bite: the benign payload must SURVIVE while the hostile
  // part dies. Keep both halves.
  // LIVENESS: without this, a renderMarkdown that just returned '' would satisfy
  // every negative assertion below. Ordinary markdown must still render.
  expect(renderMarkdown('plain **bold** text')).toContain('<strong>bold</strong>')
  // THE SANITIZER-GATE FIXTURES. Every raw-HTML fixture below is dropped by remark
  // BEFORE the sanitizer ever runs, so on their own they test the parser, not the
  // XSS gate: deleting sanitizeHtml entirely left this test green (measured).
  // These two are markdown-NATIVE — the pipeline itself emits the href, so only
  // the sanitizer can remove it. They are what makes this a gate test.
  expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('javascript:')
  expect(renderMarkdown('[x](//evil.com)')).not.toContain('//evil.com') // allowProtocolRelative: false
  // Measured behaviour (probed 2026-08-07), NOT assumed: a raw-HTML BLOCK is
  // dropped wholesale by remark, so these two legitimately render to '' — the
  // benign text does not survive, and that is stronger, not weaker.
  expect(renderMarkdown('<script>alert(1)</script>ok')).toBe('')
  expect(renderMarkdown('<p class="x" style="y">attrs stripped</p>')).toBe('')
  // INLINE html in a paragraph is different: the tag dies, the text survives.
  // This is the one fixture that proves "hostile stripped, benign kept".
  const link = renderMarkdown('<a href="//evil.com">x</a>')
  expect(link).not.toContain('href=')
  expect(link).toContain('x')
  expect(renderMarkdown('<img src="x" onerror="p()">')).not.toContain('onerror')
  expect(renderMarkdown('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:')
  expect(renderMarkdown('<img src="data:image/png;base64,xx">')).not.toContain('data:')
  expect(renderMarkdown('<svg onload="p()"></svg>')).not.toContain('svg')
  // From web's former suite (union, nothing dropped): markdown that EMBEDS raw
  // HTML — the parser drops the raw HTML (remark-rehype never sets
  // allowDangerousHtml) and the sanitizer still runs after, while the markdown
  // around it still renders.
  const embedded = renderMarkdown('safe **md**\n\n<script>alert(1)</script>')
  expect(embedded).not.toContain('script')
  expect(embedded).toContain('<strong>md</strong>')
})

test('sanitize: hostile HTML dies, benign text survives', () => {
  // No parser stands in front of the sanitizer on this path, so EVERY fixture
  // here tests the gate itself. The positive assertions keep it live: a
  // sanitize() that returned '' would satisfy every negative one
  // (mutation-proven 2026-08-07).
  const script = sanitize('<script>alert(1)</script>ok')
  expect(script).not.toContain('script')
  expect(script).toContain('ok')
  const attrs = sanitize('<p class="x" style="y">attrs stripped</p>')
  expect(attrs).not.toContain('class=')
  expect(attrs).toContain('attrs stripped')
  const link = sanitize('<a href="//evil.com">x</a>')
  expect(link).not.toContain('href=')
  expect(link).toContain('x')
  expect(sanitize('<img src="x" onerror="p()">')).not.toContain('onerror')
  expect(sanitize('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:')
  expect(sanitize('<img src="data:image/png;base64,xx">')).not.toContain('data:')
  expect(sanitize('<svg onload="p()"></svg>')).not.toContain('svg')
  // Allowed structure passes through: web shows remote posts through this path.
  expect(sanitize('<blockquote>quoted</blockquote>')).toContain('<blockquote>quoted</blockquote>')
})

test('GFM parity: tables and strikethrough survive; task-list checkboxes never do', () => {
  const table = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |')
  expect(table).toContain('<table>')
  expect(table).toContain('<td>1</td>')
  expect(renderMarkdown('~~gone~~')).toContain('<del>gone</del>')
  const task = renderMarkdown('- [ ] never a checkbox')
  expect(task).not.toContain('<input')
  expect(task).toContain('never a checkbox') // degrades to text, not silence
})

test('transform-added attributes survive in the OUTPUT (allowedAttributes gotcha)', () => {
  const out = renderMarkdown('[x](https://a.ex) and ![i](https://a.ex/i.png)')
  expect(out).toContain('rel="noreferrer"')
  expect(out).toContain('loading="lazy"')
})

// CANONICAL FIXTURE. Input and expected output copied UNEDITED from the former
// twin suites (core/test/rich-content.test.ts and
// web/src/lib/server/render.test.ts), where they were duplicated
// byte-identically. Passing unchanged after the move is the proof the move
// changed no output. Never edit the expected string to make a refactor pass.
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

test('canonical fixture renders byte-identically', () => {
  expect(renderMarkdown(CANONICAL_INPUT)).toBe(CANONICAL_OUTPUT)
})

test('single newline becomes <br> (remark-breaks)', () => {
  expect(renderMarkdown('a\nb')).toBe('<p>a<br />\nb</p>')
})

test('emoji shortcode renders as bare unicode text, never a span wrapper', () => {
  const html = renderMarkdown('hi :tada:')
  expect(html).toBe('<p>hi 🎉</p>')
  expect(html).not.toContain('<span')
})

test('hljs classes survive on code/span only; arbitrary classes die', () => {
  // Also the "guard does not over-trigger" check: a small fence sits far under
  // HIGHLIGHT_MAX_CHARS and must still be highlighted.
  const html = renderMarkdown('```js\nconst x = 1\n```')
  expect(html).toContain('<code class="hljs language-js">')
  expect(html).toContain('<span class="hljs-keyword">const</span>')
})

test('unlabeled fence gets no hljs markup (detect stays off)', () => {
  const html = renderMarkdown('```\nplain\n```')
  expect(html).toBe('<pre><code>plain\n</code></pre>')
})

test('raw inline HTML in markdown dies at the parser (allowDangerousHtml never set)', () => {
  const html = renderMarkdown('before\n\n<script>alert(1)</script>\n\nafter')
  expect(html).not.toContain('script')
  expect(html).not.toContain('alert(1)')
})

test('hljs sub-scope classes strip to the hljs- part (expected, do not fix)', () => {
  const html = renderMarkdown('```js\nfunction f() {}\n```')
  expect(html).toContain('class="hljs-title"')
  expect(html).not.toContain('function_')
})

test('fence over HIGHLIGHT_MAX_CHARS skips highlighting; no hljs, no no-highlight leak (I1)', () => {
  const oversized = '```js\n' + 'x'.repeat(10001) + '\n```'
  const html = renderMarkdown(oversized)
  expect(html).toContain('<pre><code class="language-js">') // plain: remark-rehype's own lang class, no hljs tokens
  expect(html).not.toContain('hljs')
  expect(html).not.toContain('no-highlight')
})

test('highlight budget is per DOCUMENT: two 6KB fences highlight exactly once (I1 many-fences vector)', () => {
  const fence = '```js\n' + 'const y = 2\n'.repeat(500) + '```'
  const html = renderMarkdown(fence + '\n\n' + fence)
  expect(html.match(/class="hljs language-js"/g)?.length ?? 0).toBe(1) // first fence fits the budget
  expect(html).toContain('<pre><code class="language-js">') // second renders plain
  expect(html).not.toContain('no-highlight')
})
