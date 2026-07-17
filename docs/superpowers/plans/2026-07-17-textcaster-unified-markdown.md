# Unified Markdown Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace marked with the unified/remark pipeline in both render twins so preview == published and the remark plugin ecosystem is usable; ship breaks, emoji, code highlight, and editor slash/emoji UX on it.

**Architecture:** Two byte-identical sync pipelines (`core/src/domain/markdown.ts` for feeds, `web/src/lib/server/render.ts` for display) feed the existing sanitize-html gate; the Carta editor mounts the SAME remark/rehype plugins through its probed `extensions[].transformers` API, so preview and published output share one parser, one highlighter (highlight.js — NOT shiki; the server path must be sync), and one emoji map.

**Tech Stack:** unified@11.0.5 stack (exact pins below), sanitize-html (existing), carta-md 4.11.2 + @cartamd/plugin-slash@4.2.0 + @cartamd/plugin-emoji@4.3.0, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-textcaster-unified-markdown-design.md` (rev 2). Read it if a decision seems ambiguous — it wins.
- **Sync is mandatory**: `renderPostHtml` runs inside the SSE frame transformer (`web/src/routes/stream/+server.ts:41`) with no await path. Everything goes through `processSync`. Never introduce an async plugin server-side.
- **Exact identical version pins in BOTH package.json files** (this is what makes byte-identity real; web already hoists most of these via carta-md): `unified@11.0.5`, `remark-parse@11.0.0`, `remark-gfm@4.0.1`, `remark-breaks@4.0.0`, `remark-emoji@5.0.2`, `remark-rehype@11.1.2`, `rehype-highlight@7.0.2`, `rehype-stringify@10.0.1`. Pin EXACT (no `^`).
- **Sanitizer**: the ONLY widening is `span` joining `allowedTags` plus one `allowedClasses` line (probed: without `span` in allowedTags, allowedClasses is moot — the token spans are stripped bodily). `class` MUST NOT be added to `allowedAttributes`. Never set `allowDangerousHtml`. Never set remark-emoji `accessible: true`.
- The two SANITIZE_CONFIGs and the two pipeline chains stay hand-duplicated twins — byte-identical content, both suites carry the same canonical fixture with the same expected string.
- Shared checkout with a parallel session: stage EXPLICIT paths only (never `git add -A`). Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Expected stripping, do NOT "fix": highlight.js sub-scope classes (`hljs-title function_` → `hljs-title`); task-list `<input>` and `contains-task-list` classes die everywhere.
- carta and every `@cartamd/*` plugin reach the app ONLY via dynamic import (bundle gate).
- No raw hex in components; new code-token colors are `--color-*` variables added to BOTH `web/src/app.css` and `design-system/textcaster/MASTER.md`.

---

### Task 1: Core twin — engine swap + full fixture suite

**Files:**
- Modify: `core/package.json` (deps)
- Modify: `core/src/domain/markdown.ts` (whole file)
- Test: `core/test/rich-content.test.ts` (extend; existing tests must pass UNMODIFIED)

**Interfaces:**
- Consumes: nothing new.
- Produces: `renderLocalHtml(markdown: string): string` — signature UNCHANGED (feed code depends on it). The canonical fixture input/output strings (Step 2) that Task 2 must duplicate verbatim.

- [ ] **Step 1: Swap dependencies**

```bash
cd /home/rmdes/textcaster
npm uninstall marked -w core
npm install -w core --save-exact unified@11.0.5 remark-parse@11.0.0 remark-gfm@4.0.1 remark-breaks@4.0.0 remark-emoji@5.0.2 remark-rehype@11.1.2 rehype-highlight@7.0.2 rehype-stringify@10.0.1
```

Verify: `core/package.json` lists the eight exact versions, no `^`, and no `marked`.

- [ ] **Step 2: Add the failing tests**

Append to `core/test/rich-content.test.ts` (do not modify existing tests):

```ts
// ── unified pipeline milestone ──────────────────────────────────────────
// CANONICAL DRIFT-CANARY FIXTURE: this exact input and this exact expected
// output are duplicated byte-identically in web/src/lib/server/render.test.ts.
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

test('canonical fixture renders byte-identically (twin: web render.test.ts)', () => {
  expect(renderLocalHtml(CANONICAL_INPUT)).toBe(CANONICAL_OUTPUT)
})

test('single newline becomes <br> (remark-breaks)', () => {
  expect(renderLocalHtml('a\nb')).toBe('<p>a<br />\nb</p>')
})

test('emoji shortcode renders as bare unicode text, never a span wrapper', () => {
  const html = renderLocalHtml('hi :tada:')
  expect(html).toBe('<p>hi 🎉</p>')
  expect(html).not.toContain('<span')
})

test('hljs classes survive on code/span only; arbitrary classes die', () => {
  const html = renderLocalHtml('```js\nconst x = 1\n```')
  expect(html).toContain('<code class="hljs language-js">')
  expect(html).toContain('<span class="hljs-keyword">const</span>')
})

test('unlabeled fence gets no hljs markup (detect stays off)', () => {
  const html = renderLocalHtml('```\nplain\n```')
  expect(html).toBe('<pre><code>plain\n</code></pre>')
})

test('raw inline HTML in markdown dies at the parser (allowDangerousHtml never set)', () => {
  const html = renderLocalHtml('before\n\n<script>alert(1)</script>\n\nafter')
  expect(html).not.toContain('script')
  expect(html).not.toContain('alert(1)')
})

test('hljs sub-scope classes strip to the hljs- part (expected, do not fix)', () => {
  const html = renderLocalHtml('```js\nfunction f() {}\n```')
  expect(html).toContain('class="hljs-title"')
  expect(html).not.toContain('function_')
})
```

The exact expected strings above were computed by executing this plan's
pinned chain + sanitize config (probe, 2026-07-17). If an assertion fails
on a DIFFERENT stable string, STOP and report — do not adjust the fixture
to whatever the code produces without flagging it.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w core -- rich-content`
Expected: FAIL — `renderLocalHtml` still renders via marked (no `<br />` for single newline, `:rocket:` stays literal, no hljs classes).

- [ ] **Step 4: Replace `core/src/domain/markdown.ts` entirely**

```ts
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkEmoji from 'remark-emoji'
import remarkRehype from 'remark-rehype'
import rehypeHighlight from 'rehype-highlight'
import rehypeStringify from 'rehype-stringify'
import sanitizeHtml from 'sanitize-html'

// SEC-4: HTML we GENERATE from local composes never ships dirty. Raw HTML
// written in markdown dies at the parser (remark-rehype default drops it —
// never set allowDangerousHtml) AND the sanitizer still runs after: defense
// in depth. Remote content is never routed through this: pass-through
// applies to OTHERS' content, not to HTML we author ourselves.
const SANITIZE_CONFIG: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'a', 'em', 'strong', 'b', 'i', 'blockquote', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'del', 'span'],
  allowedAttributes: { a: ['href', 'rel'], img: ['src', 'loading'] },
  // The ONLY class surface: highlight.js tokens. allowedClasses is the whole
  // mechanism — `class` must never join allowedAttributes (that would open
  // arbitrary class values). Bare `hljs*` on code is deliberate: rehype-
  // highlight emits a bare class="hljs" there that `hljs-*` would miss.
  allowedClasses: { code: ['hljs*', 'language-*'], span: ['hljs-*'] },
  allowedSchemes: ['http', 'https'],
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noreferrer' }),
    img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' }),
  },
}

// The twin of web/src/lib/server/render.ts — same chain, same order, same
// versions (exact-pinned in both package.json). The canonical fixture in
// both test suites asserts byte-identity. Everything here is sync:
// renderPostHtml's SSE path cannot await, so an async plugin is a defect.
const pipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkEmoji) // accessible stays default-off: emoji must be bare text
  .use(remarkRehype)
  .use(rehypeHighlight) // detect stays default-off: unlabeled fences render plain
  .use(rehypeStringify)

export function renderLocalHtml(markdown: string): string {
  return sanitizeHtml(String(pipeline.processSync(markdown)), SANITIZE_CONFIG)
}
```

- [ ] **Step 5: Run the full core suite**

Run: `npm test -w core`
Expected: ALL PASS — including every pre-existing hostile fixture and GFM-parity test UNMODIFIED. If any existing test needed editing, that is a spec violation: stop and report.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck -w core` (if that script is missing, use the script named in `core/package.json` that runs `tsc`)
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add core/package.json package-lock.json core/src/domain/markdown.ts core/test/rich-content.test.ts
git commit -m "core: swap marked for unified pipeline (breaks, emoji, highlight)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Web twin — engine swap, canonical fixture duplicated verbatim

**Files:**
- Modify: `web/package.json` (deps)
- Modify: `web/src/lib/server/render.ts` (imports, config, pipeline; `renderPostHtml`/`enrichEntries` signatures unchanged)
- Test: `web/src/lib/server/render.test.ts` (extend; existing tests must pass UNMODIFIED)

**Interfaces:**
- Consumes: the canonical fixture strings from Task 1 — copy CANONICAL_INPUT and CANONICAL_OUTPUT byte-for-byte from `core/test/rich-content.test.ts`.
- Produces: `renderPostHtml(post): string` and `enrichEntries(entries)` — signatures UNCHANGED (three ingress points depend on them).

- [ ] **Step 1: Swap dependencies**

```bash
cd /home/rmdes/textcaster
npm uninstall marked -w web
npm install -w web --save-exact unified@11.0.5 remark-parse@11.0.0 remark-gfm@4.0.1 remark-breaks@4.0.0 remark-emoji@5.0.2 remark-rehype@11.1.2 rehype-highlight@7.0.2 rehype-stringify@10.0.1
```

Then verify dedupe: `npm ls unified remark-gfm remark-rehype` must show ONE version of each (11.0.5 / 4.0.1 / 11.1.2), everything deduped against carta-md's transitive copies. Two copies of unified = wrong pins, stop.

- [ ] **Step 2: Add the failing tests**

Append to `web/src/lib/server/render.test.ts` the SAME block as Task 1 Step 2 — copy `CANONICAL_INPUT`, `CANONICAL_OUTPUT`, and all seven `test(...)` blocks byte-for-byte from `core/test/rich-content.test.ts`, with exactly two mechanical adaptations:
1. The render call: core's `renderLocalHtml(md)` becomes `renderPostHtml({ content: md, source: 'local' })`.
2. The canonical test name says `(twin: core rich-content.test.ts)`.

The comment header, fixture strings, and every expected value stay identical — that is the point of the canary.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w web -- render`
Expected: FAIL — same failure shape as Task 1 Step 3.

- [ ] **Step 4: Swap the engine in `web/src/lib/server/render.ts`**

Replace the `marked` import with the same eight imports as Task 1 Step 4, replace `SANITIZE_CONFIG` with the same object (tab-indented per this file's existing style), add the same `const pipeline = ...` (same comments), and change only the render line inside `renderPostHtml`:

```ts
export function renderPostHtml(post: { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }): string {
	const md = post.contentMarkdown ?? (post.source === 'local' ? post.content : null)
	const html = md !== null ? String(pipeline.processSync(md)) : post.content
	return sanitizeHtml(html, SANITIZE_CONFIG)
}
```

Keep the existing "one render path / precedence" comment; update its second sentence to say raw HTML in markdown dies at the parser AND the sanitizer (it previously justified sanitize-after-marked).

`enrichEntries` is untouched.

- [ ] **Step 5: Run the full web suite + typecheck**

Run: `npm test -w web` then `cd web && npm run check`
Expected: ALL PASS / 0 errors 0 warnings. The stream server tests (`web/src/routes/stream/server.test.ts`) exercise the SSE sync path through `renderPostHtml` — if anything throws about async, the pin discipline was violated.

- [ ] **Step 6: Commit**

```bash
git add web/package.json package-lock.json web/src/lib/server/render.ts web/src/lib/server/render.test.ts
git commit -m "web: swap marked for unified pipeline (twin of core, canonical canary)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: hljs token CSS (both themes) + docs

**Files:**
- Modify: `web/src/app.css` (tokens + hljs rules)
- Modify: `design-system/textcaster/MASTER.md` (the two new color tokens)
- Modify: `docs/superpowers/documentation/RUNNING.md` (composer feature lines)

**Interfaces:**
- Consumes: the sanitized output shape from Tasks 1–2 (`code.hljs`, `span.hljs-*`).
- Produces: nothing code-level; visual layer only.

- [ ] **Step 1: Add the two code tokens to `:root` in `web/src/app.css`** (after `--color-ring`, same block):

```css
	--color-code-string: light-dark(#15803d, #4ade80);
	--color-code-value: light-dark(#1d4ed8, #93c5fd);
```

- [ ] **Step 2: Add the hljs rules to `web/src/app.css`**, immediately after the `.post .body pre code` block (find it around line 585; it scopes code display inside posts):

```css
/* highlight.js tokens (server-side rehype-highlight output). Only hljs-*
   classes survive the sanitizer; everything maps to theme tokens. */
.hljs-keyword,
.hljs-built_in,
.hljs-literal,
.hljs-type {
	color: var(--color-accent);
}

.hljs-string,
.hljs-regexp,
.hljs-addition {
	color: var(--color-code-string);
}

.hljs-number,
.hljs-attr,
.hljs-title,
.hljs-symbol {
	color: var(--color-code-value);
}

.hljs-comment,
.hljs-quote,
.hljs-meta,
.hljs-deletion {
	color: var(--color-secondary);
}
```

These selectors are global on purpose: the same classes appear in post bodies AND in the Carta preview (Task 4), and both must color identically — that is the palette-parity property this milestone buys.

- [ ] **Step 3: Mirror the tokens in `design-system/textcaster/MASTER.md`**

Find the color-token table/section that lists `--color-ring` and add, following the exact formatting of neighboring entries:
- `--color-code-string`: light `#15803d`, dark `#4ade80` — code string/regexp tokens
- `--color-code-value`: light `#1d4ed8`, dark `#93c5fd` — code number/title/attr tokens

- [ ] **Step 4: Update RUNNING.md**

Locate the composing paragraph (mentions Markdown with live preview) and extend it with these facts, matching the file's tone:
- Single newlines are line breaks (like a chat/microblog, not classic Markdown).
- `:shortcode:` emoji work (e.g. `:tada:` → 🎉); type `:` in the editor for autocomplete.
- Fenced code blocks with a language tag are syntax-highlighted; without a tag they render plain.
- Typing literal HTML (e.g. `<div>x</div>`) is not supported: the tag vanishes and the text remains. This is deliberate.
- Type `/` in the editor for the slash command menu.

- [ ] **Step 5: Visual verification**

Run the dev servers if not running, then with Playwright MCP (or a browser): create a post whose markdown is
` ```js\nconst x = 1 // comment\nconst s = "str"\n``` `
and confirm the timeline shows colored tokens in BOTH themes (toggle `data-theme`). Confirm contrast is legible in both.

- [ ] **Step 6: Commit**

```bash
git add web/src/app.css design-system/textcaster/MASTER.md docs/superpowers/documentation/RUNNING.md
git commit -m "web: hljs token colors (both themes) + composer feature docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Carta editor — same plugins in the preview (slash, emoji, breaks, highlight)

**Files:**
- Modify: `web/package.json` (two editor deps)
- Modify: `web/src/lib/MarkdownComposer.svelte` (the `$effect` import block + Carta construction)
- Test: `scripts/` bundle gate re-run + `web/src/routes/page.actions.test.ts` and `web/src/routes/post/[id]/reply.actions.test.ts` UNMODIFIED

**Interfaces:**
- Consumes: `PREVIEW_SANITIZE_OPTS` from `web/src/lib/preview-sanitize.ts` (unchanged).
- Produces: the enhanced composer; no API changes.

**Probed API facts (carta-md 4.11.2 installed source — do not re-derive from memory):**
- `new Carta(options)` takes `extensions?: Plugin[]`.
- A `Plugin` may carry `transformers?: UnifiedTransformer<'sync' | 'async'>[]`.
- `UnifiedTransformer` = `{ execution: 'sync', type: 'remark' | 'rehype', transform: ({ processor }) => void }`. Sync transformers run in BOTH carta processors; carta's own chain is `remarkParse → remarkGfm → [remark transformers] → remarkRehype → [rehype transformers] → rehypeStringify` — the same shape as the server twins.
- `@cartamd/plugin-emoji@4.3.0` DEPENDS ON `remark-emoji` (same node-emoji map as the server) and applies it itself — do NOT also add a remark-emoji transformer (double application is harmless but pointless). Its options forward to remark-emoji; NEVER pass `accessible: true`.
- Carta's preview does NOT highlight code blocks by itself (probed: no highlight plugin in its processor; shiki only styles the editor's input overlay). Adding `rehype-highlight` as a sync rehype transformer gives the preview the SAME hljs classes the server emits, colored by the SAME Task 3 CSS. This is why we do not use `@cartamd/plugin-code`.

- [ ] **Step 1: Install the editor plugins**

```bash
npm install -w web --save-exact @cartamd/plugin-slash@4.2.0 @cartamd/plugin-emoji@4.3.0
```

- [ ] **Step 2: Probe the two plugins' export names and CSS paths** (they are NOT in node_modules until Step 1):

```bash
cat node_modules/@cartamd/plugin-slash/dist/index.d.ts | head -40
cat node_modules/@cartamd/plugin-emoji/dist/index.d.ts | head -40
node -e "console.log(JSON.stringify(require('/home/rmdes/textcaster/node_modules/@cartamd/plugin-slash/package.json').exports, null, 1))"
node -e "console.log(JSON.stringify(require('/home/rmdes/textcaster/node_modules/@cartamd/plugin-emoji/package.json').exports, null, 1))"
```

Expected (verify, adjust Step 3 if reality differs): a named export `slash(options?)` / `emoji(options?)` returning `Plugin`, and a `./default.css` export path per plugin.

- [ ] **Step 3: Wire the plugins in `web/src/lib/MarkdownComposer.svelte`**

Replace the `$effect` dynamic-import block with (keep the surrounding cancelled-flag structure exactly as-is):

```ts
$effect(() => {
	let cancelled = false
	Promise.all([
		import('carta-md'),
		import('dompurify'),
		import('remark-breaks'),
		import('rehype-highlight'),
		import('@cartamd/plugin-slash'),
		import('@cartamd/plugin-emoji'),
		import('carta-md/default.css'),
		import('@cartamd/plugin-slash/default.css'),
		import('@cartamd/plugin-emoji/default.css')
	])
		.then(([cartaMod, dompurifyMod, breaksMod, highlightMod, slashMod, emojiMod]) => {
			if (cancelled) return
			const carta = new cartaMod.Carta({
				sanitizer: (html: string) => dompurifyMod.default.sanitize(html, PREVIEW_SANITIZE_OPTS),
				extensions: [
					slashMod.slash(),
					emojiMod.emoji(), // brings remark-emoji itself — same map as the server
					{
						// Preview parity with the server twins: same remark-breaks,
						// same rehype-highlight (NOT shiki/plugin-code — the server
						// is sync highlight.js, and Task 3's token CSS colors both).
						transformers: [
							{ execution: 'sync', type: 'remark', transform: ({ processor }) => void processor.use(breaksMod.default) },
							{ execution: 'sync', type: 'rehype', transform: ({ processor }) => void processor.use(highlightMod.default) }
						]
					}
				]
			})
			editor = { MarkdownEditor: cartaMod.MarkdownEditor as unknown as Component, carta }
		})
		.catch(() => {})
	return () => {
		cancelled = true
	}
})
```

TypeScript note: if the transformer literal needs a type, import it as `import type { UnifiedTransformer } from 'carta-md'` INSIDE the then-callback's module imports is not possible — instead use `satisfies` or cast the extensions entry; check what `svelte-check` accepts and keep it minimal.

- [ ] **Step 4: Theme the plugin popups in `web/src/app.css`**

The slash menu and emoji autocomplete ship their own default.css. Probe their class names (`grep -o 'carta-[a-z-]*' node_modules/@cartamd/plugin-slash/dist/default.css | sort -u`, same for plugin-emoji), then add token overrides in app.css following the established pattern — every selector prefixed `body ` to win the tie against the plugins' CSS (same rule as the carta skin block, same reason), surfaces from `--color-surface`/`--color-border`/`--color-foreground`/`--color-accent`, no raw hex.

- [ ] **Step 5: Gates**

```bash
npm test -w web            # all pass, action tests UNMODIFIED
cd web && npm run check    # 0 errors 0 warnings
cd .. && npm run build -w web
```

Then re-run the bundle gate assertion (no static app-chunk import of carta OR any @cartamd/* or the newly added remark/rehype modules used by the composer — the server render twins are server-only and never enter the client bundle):

```bash
node -e "
const m = require('./web/.svelte-kit/output/client/.vite/manifest.json')
let bad = []
for (const [key, chunk] of Object.entries(m)) {
  if (key.includes('carta') || key.includes('@cartamd')) continue
  for (const imp of chunk.imports ?? []) {
    if (imp.includes('carta') || imp.includes('@cartamd')) bad.push(key + ' -> ' + imp)
  }
}
console.log(bad.length ? bad.join('\n') : 'BUNDLE GATE PASS')
process.exit(bad.length ? 1 : 0)
"
```

- [ ] **Step 6: SSR baseline pins**

```bash
curl -s http://localhost:5173/ | grep -c '<textarea name="content"'          # expect 1
```
(and the same against a `/post/<id>` page — grab an id from the timeline HTML). The plain-textarea no-JS baseline must survive on both composer surfaces.

- [ ] **Step 7: Hydrated verification (Playwright MCP — it settles carta's dynamic import on this machine)**

Open the compose dialog, then verify: typing `:tad` pops emoji autocomplete; typing `/` pops the slash menu; a fenced ```js block in the Preview tab shows colored hljs tokens; `a⏎b` previews as two lines. Both themes.

- [ ] **Step 8: Commit**

```bash
git add web/package.json package-lock.json web/src/lib/MarkdownComposer.svelte web/src/app.css
git commit -m "web: carta preview shares the server plugin chain (slash, emoji, breaks, hljs)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Feed contract + marked-gone audit

**Files:**
- Test: `core/test/feed.test.ts` (extend)
- Verify-only: no source changes expected.

**Interfaces:**
- Consumes: `renderLocalHtml` output shape (Task 1); the existing feed dual-contract test as the pattern.

- [ ] **Step 1: Locate the dual-contract feed test**

Run: `grep -n "source:markdown\|contentMarkdown\|description" core/test/feed.test.ts | head -20` and read the surrounding test. It creates a local post with markdown content and asserts `description` (rendered+sanitized) and `source:markdown` (raw verbatim) on the feed output.

- [ ] **Step 2: Add the new-syntax feed test**

Copy that test's exact setup (same helpers, same feed-fetch flow) into a new test named `feed description renders breaks, emoji, and highlighted code (unified pipeline)`, with the post's markdown set to:

```ts
const md = 'line one\nline two :rocket:\n\n```js\nconst x = 1\n```'
```

and these assertions on the emitted feed:

```ts
// description = rendered + sanitized (SEC-4)
expect(description).toContain('line one<br />')
expect(description).toContain('🚀')
expect(description).toContain('<span class="hljs-keyword">const</span>')
// dual contract: the raw markdown travels verbatim beside it
expect(sourceMarkdown).toBe(md)
```

(Bind `description`/`sourceMarkdown` however the neighboring test extracts them — reuse its parsing, do not invent a new one. Note: `description` in RSS is typically CDATA/entity-wrapped; assert against the DECODED value the same way the neighboring test does.)

- [ ] **Step 3: Run the feed suite**

Run: `npm test -w core -- feed`
Expected: PASS (the pipeline from Task 1 is already live; this test pins the feed-level contract).

- [ ] **Step 4: marked is gone**

```bash
grep -rn "from 'marked'\|require('marked')" core/src web/src        # expect no output
npm ls marked                                                        # expect empty / not found
```

- [ ] **Step 5: Commit**

```bash
git add core/test/feed.test.ts
git commit -m "core: feed contract pins unified-pipeline output (breaks, emoji, hljs)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Plan self-review notes (done at write time)

- Spec coverage: engine swap (T1/T2), breaks+emoji (T1/T2 fixtures, T4 preview), highlight + one-line sanitizer widening + `span` allowlisting (T1/T2) + token CSS (T3), slash/emoji editor UX (T4), feed==site (T5), marked removal (T1/T2 steps + T5 audit), RUNNING.md incl. literal-HTML note (T3), byte-identity canary as new work (T1 Step 2 + T2 Step 2), version pins (T1/T2 Step 1, dedupe check), residual divergences: palette and bare-fence divergences DISSOLVED by the rehype-highlight-in-preview probe result (stronger than spec promised — preview now uses the same highlighter; spec's residual list shrinks to nothing but PREVIEW_SANITIZE_OPTS scope, which predates this milestone); emoji map divergence dissolved (plugin-emoji embeds remark-emoji).
- Deviation from spec, deliberate and evidence-based: spec named shiki-vs-hljs palette divergence as residual; the probe showed carta's preview processor has NO code highlighter, so this plan wires rehype-highlight into the preview instead — strictly better parity at lower cost. The spec's `@cartamd/plugin-code` was never mentioned as required; nothing in the spec forbids this.
- `span` joining `allowedTags` was discovered by composing chain+sanitizer (the review probed them separately); without it the entire highlight feature silently no-ops. It is the minimal additional widening and carries no attributes beyond the class patterns.
