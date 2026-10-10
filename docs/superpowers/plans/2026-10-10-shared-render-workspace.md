# Shared Render Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the XSS gate (unified pipeline + sanitize-html config) out of the hand-duplicated twins `core/src/domain/markdown.ts` and `web/src/lib/server/render.ts` into one new npm workspace, `@rsc/render`, that both import — with zero change to rendered output.

**Architecture:** A fourth workspace `render/` containing only `package.json` + `src/render.ts`, exporting two deliberately non-equivalent entry points: `renderMarkdown(md)` and `sanitize(html)`. Core imports it from `feed.ts` and deletes its twin; web keeps `lib/server/render.ts` as a thin display-policy adapter (same path, same exports). The gate's tests live in core's suite; core's `tsc` type-checks it.

**Tech Stack:** npm workspaces · Node native type stripping (core, no build) · SvelteKit + adapter-node (web) · vitest 5 · unified/remark/rehype · sanitize-html · Cloudron image.

**Spec:** `docs/superpowers/specs/2026-10-10-shared-render-workspace-design.md` (rev 3).

**Plan rev 2** folds a clean-context review (READY WITH CHANGES). It fixes two expectations that would have stopped a correct implementation (Task 3 Step 6, Task 4 Step 4), restores spec criterion 5's pre-deploy feed check (Task 4 Step 5), adds timeouts and "run as ONE command" guards, and adds the TESTING.md map fix (spec rev 3).

## Global Constraints

- **Pure move.** No sanitizer option, pipeline plugin, plugin order, or dependency version changes. The canonical fixture's expected string is copied **unedited** and must pass.
- The 12 packages moved — `unified`, `remark-parse`, `remark-gfm`, `remark-breaks`, `remark-emoji`, `remark-rehype`, `rehype-highlight`, `rehype-stringify`, `sanitize-html`, `unist-util-visit`, `@types/hast`, `@types/sanitize-html` — keep their **current ranges verbatim**: `"rehype-highlight": "7.0.2"`, `"rehype-stringify": "10.0.1"`, `"remark-breaks": "4.0.0"`, `"remark-emoji": "5.0.2"`, `"remark-gfm": "4.0.1"`, `"remark-parse": "11.0.0"`, `"remark-rehype": "11.1.2"`, `"sanitize-html": "^2.18.0"`, `"unified": "11.0.5"`, `"unist-util-visit": "5.1.0"`, `"@types/hast": "3.0.5"`, `"@types/sanitize-html": "^2.16.1"`. Their **lockfile versions must not change** in any task.
- `core/package.json` loses all 12. **`web/package.json` is not edited at all** — adapter-node externalizes only `pkg.dependencies`, so undeclaring them would inline the sanitizer into the production bundle.
- `render/` has **no** tsconfig, vitest config, scripts, or tests of its own.
- Import specifier everywhere: `@rsc/render/src/render.ts` (deep path, no `exports` field) — matching `web/src/routes/mcp/+server.ts:2`.
- `render/src/render.ts` uses **2-space** indentation (node-side style, like core and mcp). Web files use **tabs**.
- Tests and typechecks run **in the dev containers** (`docker compose up` must be running). Never run `npm install` inside a container — it writes root-owned files onto the bind mount. Lockfile changes are made on the **host** with `npx -y npm@12 install --package-lock-only`.
- **Shared checkout:** a parallel session commits on `main`. Never `git add -A`; stage explicit paths. Never `git stash`.
- Every commit message ends with the line: `developed with the help of AI tools`
- **Expected test counts** (baseline at plan time: core 107 files / 1223 tests, web 56 files / 500 tests): after Task 1 core = 108 files / 1237; after Task 2 core = 108 / 1224; after Task 3 web = 56 / 487.
- **Multi-line shell blocks that use `$B`, `$F` or `$BASE` must be run as ONE command.** Shell variables do not survive between separate tool calls, and a lost `$B` leaves a planted error or mutation in an uncommitted file that `git checkout` cannot restore.
- The dev stack is **shared** with a parallel session. Restarting it (Task 1 Step 8, Task 2 Step 6) interrupts that session's stack — say so in your report when you do it.

---

### Task 1: The `@rsc/render` workspace and the gate's test suite

Introduces the workspace everywhere it must be declared (root `workspaces`, lockfile, Cloudron Dockerfile) and proves it with its own suite. Consumers are not switched yet — the twins still exist after this task, and that is fine.

**Files:**
- Create: `core/test/render.test.ts`
- Create: `render/package.json`
- Create: `render/src/render.ts`
- Modify: `package.json` (root `workspaces`)
- Modify: `package-lock.json` (regenerated)
- Modify: `cloudron/Dockerfile:21` (add a manifest COPY after the mcp line)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `renderMarkdown(md: string): string` — markdown → unified pipeline → sanitize. Identical to today's `core` `renderLocalHtml`.
  - `sanitize(html: string): string` — untrusted HTML → sanitize. Identical to today's `sanitizeHtml(html, SANITIZE_CONFIG)`.
  - Import path: `@rsc/render/src/render.ts`.

- [ ] **Step 1: Write the gate's test suite**

Create `core/test/render.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker compose exec -T core npm test -w core -- test/render.test.ts`
Expected: FAIL — the import `@rsc/render/src/render.ts` cannot be resolved (no such package yet).

- [ ] **Step 3: Create `render/package.json`**

```json
{
  "name": "@rsc/render",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "rehype-highlight": "7.0.2",
    "rehype-stringify": "10.0.1",
    "remark-breaks": "4.0.0",
    "remark-emoji": "5.0.2",
    "remark-gfm": "4.0.1",
    "remark-parse": "11.0.0",
    "remark-rehype": "11.1.2",
    "sanitize-html": "^2.18.0",
    "unified": "11.0.5",
    "unist-util-visit": "5.1.0"
  },
  "devDependencies": {
    "@types/hast": "3.0.5",
    "@types/sanitize-html": "^2.16.1"
  }
}
```

- [ ] **Step 4: Create `render/src/render.ts`**

Everything from `SANITIZE_CONFIG` through `pipeline` is copied from `core/src/domain/markdown.ts:18-79` with its comments unchanged, with three deliberate exceptions:

- one clarifying line is added after SEC-4;
- the pipeline's twin-contract comment (`markdown.ts:67-70`) is replaced, because there is no twin any more;
- its "everything here is sync" sentence is kept in substance but reworded, because `renderPostHtml` no longer lives in the same file.

Reviewers: these three are intended, not drift.

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
import { visit } from 'unist-util-visit'
import type { Element, Root, Text } from 'hast'

// THE XSS gate — the only one. core (domain/feed.ts) and web
// (lib/server/render.ts) both import this module; there is no second copy.
// Two exports, deliberately NOT equivalent: renderMarkdown parses as markdown
// (a raw-HTML block dies at the parser before the sanitizer runs); sanitize
// cleans untrusted HTML directly (benign text survives). SANITIZE_CONFIG is
// unexported on purpose: nothing outside the gate can read or alter it.

// SEC-4: HTML we GENERATE from local composes never ships dirty. Raw HTML
// written in markdown dies at the parser (remark-rehype default drops it —
// never set allowDangerousHtml) AND the sanitizer still runs after: defense
// in depth. Remote content is never routed through this: pass-through
// applies to OTHERS' content, not to HTML we author ourselves.
// (SEC-4 describes the renderMarkdown path. sanitize() below is the separate,
// deliberate path for remote HTML displayed by web.)
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

// I1 (final review): rehype-highlight is sync CPU work — a 1MB fenced block
// costs ~10s of sync CPU (measured), and this pipeline runs on every read
// (timeline load, SSE frame enrichment) over input a followed feed's
// source:markdown fully controls, with no size cap on local compose either.
// Ceiling picked well above any real code paste. This is a per-DOCUMENT
// budget, not per fence: many sub-limit fences sum linearly (~10ms/KB), so
// a 5MB remote item packed with 9.9k fences would otherwise still stall the
// loop for ~50s. Once the budget is spent, remaining fences render as plain
// <pre><code>, not highlighted.
const HIGHLIGHT_MAX_CHARS = 10_000

// Runs before rehypeHighlight so an over-budget fence never reaches lowlight.
// 'no-highlight' is the class rehype-highlight itself recognizes as skip
// (see language() in rehype-highlight/lib/index.js); sanitize-html then
// strips it since it's not in allowedClasses, so it never reaches output.
function skipOversizedFences() {
  return (tree: Root) => {
    let budget = HIGHLIGHT_MAX_CHARS
    visit(tree, 'element', (node: Element, _index, parent) => {
      if (node.tagName !== 'code' || !parent || parent.type !== 'element' || parent.tagName !== 'pre') return
      let length = 0
      visit(node, 'text', (text: Text) => {
        length += text.value.length
      })
      budget -= length
      if (budget < 0) {
        const className = Array.isArray(node.properties.className) ? node.properties.className : []
        node.properties.className = [...className, 'no-highlight']
      }
    })
  }
}

// Plugin order is load-bearing; the canonical fixture in
// core/test/render.test.ts pins the output. Everything here is sync: web's SSE
// path (renderPostHtml in web/src/lib/server/render.ts) cannot await, so an
// async plugin is a defect.
const pipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkEmoji) // accessible stays default-off: emoji must be bare text
  .use(remarkRehype)
  .use(skipOversizedFences)
  .use(rehypeHighlight) // detect stays default-off: unlabeled fences render plain
  .use(rehypeStringify)

// Markdown we render: local composes and any item's source:markdown.
export function renderMarkdown(markdown: string): string {
  return sanitizeHtml(String(pipeline.processSync(markdown)), SANITIZE_CONFIG)
}

// Untrusted HTML shown in web (remote posts with no markdown). Note feeds do
// NOT use this: core's feed.ts re-emits remote content untouched — a separate,
// deliberate pass-through contract.
export function sanitize(html: string): string {
  return sanitizeHtml(html, SANITIZE_CONFIG)
}
```

- [ ] **Step 5: Declare the workspace in the root `package.json`**

Change the `workspaces` line so the file reads:

```json
{
  "name": "rsc",
  "private": true,
  "type": "module",
  "workspaces": ["core", "web", "mcp", "render"],
  "engines": { "node": ">=22.18" }
}
```

- [ ] **Step 6: Declare the manifest in the Cloudron image**

In `cloudron/Dockerfile`, immediately after the line `COPY mcp/package.json mcp/package.json` (line 21), insert:

```dockerfile
# render/ is the XSS gate (@rsc/render), imported by core's domain/feed.ts and
# web's lib/server/render.ts. Same failure mode as mcp above: without this
# manifest `npm ci` silently under-installs — none of render's dependencies —
# and the build still succeeds, shipping an image that cannot load its
# sanitizer.
COPY render/package.json render/package.json
```

- [ ] **Step 7: Regenerate the lockfile on the host and prove no version moved**

Run (from the repo root, on the host):

```bash
npx -y npm@12 install --package-lock-only
```

Then run this check. It compares the 12 packages against the last commit and exits non-zero if any version changed or went missing:

```bash
python3 - <<'EOF'
import json, subprocess
pk = ['unified','remark-parse','remark-gfm','remark-breaks','remark-emoji','remark-rehype',
      'rehype-highlight','rehype-stringify','sanitize-html','unist-util-visit','@types/hast','@types/sanitize-html']
old = json.loads(subprocess.run(['git','show','HEAD:package-lock.json'],capture_output=True,text=True,check=True).stdout)['packages']
new = json.load(open('package-lock.json'))['packages']
bad = 0
for p in pk:
    o = old.get('node_modules/'+p,{}).get('version'); n = new.get('node_modules/'+p,{}).get('version')
    flag = '' if (o == n and n) else '   <== CHANGED OR MISSING'
    bad += bool(flag)
    print(f'{p:22} {o} -> {n}{flag}')
link = new.get('node_modules/@rsc/render', {})
print('@rsc/render link:', link)
raise SystemExit(bad or (0 if link.get('link') and link.get('resolved') == 'render' else 1))
EOF
```

Expected: all 12 lines show identical versions, `@rsc/render link: {'resolved': 'render', 'link': True}`, exit 0.

Then guard against unrelated churn — `--package-lock-only` must not re-resolve anything else:

```bash
git diff package-lock.json | grep -E '^[+-][[:space:]]+"version"'
```

Expected: exactly one line, `+      "version": "0.0.0",` (the new `render` package entry). Any other changed `version` line is unrelated churn — stop and report.

- [ ] **Step 8: Restart the dev stack so core's `npm ci` installs the workspace**

Run as ONE command:

```bash
docker compose down && docker compose up -d
for i in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Health.Status}}' rsc-core 2>/dev/null)" = "healthy" ] && break; sleep 5; done
[ "$(docker inspect -f '{{.State.Health.Status}}' rsc-core)" = "healthy" ] || { echo "core NOT healthy after 7.5 min"; docker compose logs core | tail -40; exit 1; }
docker compose exec -T core ls -la /app/node_modules/@rsc/
test ! -e render/node_modules && echo "OK: nothing installed into render/node_modules on the host"
```

Expected: the listing includes `render -> ../../render`, and the last line prints `OK: …`. If `render/node_modules` exists, stop and report — that is the root-owned bind-mount bug class the spec ruled out.

- [ ] **Step 9: Run the suite to confirm it passes**

Run: `docker compose exec -T core npm test -w core -- test/render.test.ts`
Expected: PASS — 1 file, **14 tests**.

- [ ] **Step 10: Prove core's `tsc` actually type-checks the new workspace**

The design relies on core's typecheck covering `render/src/render.ts` (it has no tsconfig of its own). Plant a type error, confirm it is caught, restore. Run as ONE command:

```bash
B=$(mktemp) && cp render/src/render.ts "$B"
echo "export const planted: number = 'not a number'" >> render/src/render.ts
docker compose exec -T core npm run typecheck -w core; echo "typecheck exit: $?"
cp "$B" render/src/render.ts && rm "$B"
grep -c "planted" render/src/render.ts
```

Expected: typecheck exit **non-zero**, with an error located in `render/src/render.ts` ("Type 'string' is not assignable to type 'number'"). The final `grep -c` prints `0` (the planted line is gone). If the typecheck exits 0, stop: the type-check coverage premise is false and the spec needs revisiting.

- [ ] **Step 11: Full core gates**

```bash
docker compose exec -T core npm run typecheck -w core; echo "tsc exit: $?"
docker compose exec -T core npm test -w core 2>&1 | grep -E "Test Files|Tests "
```

Expected: `tsc exit: 0`; **108 files, 1237 tests passed**.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json cloudron/Dockerfile render/package.json render/src/render.ts core/test/render.test.ts
git commit -F - <<'EOF'
feat(render): @rsc/render workspace — the XSS gate in one place

Adds a fourth npm workspace holding the unified pipeline + sanitize-html
config, with two deliberately non-equivalent entry points: renderMarkdown()
(raw-HTML blocks die at the parser) and sanitize() (untrusted HTML, benign
text survives). Source only — no tsconfig, runner, or scripts; its suite runs
in core (core/test/render.test.ts, 14 tests) and core's tsc type-checks it
(proven with a planted error).

Consumers are not switched yet; the twins still exist after this commit.
Declared in the root workspaces, the lockfile (all 12 package versions
unchanged), and the Cloudron Dockerfile.

developed with the help of AI tools
EOF
```

---

### Task 2: Core uses the gate; core's twin is deleted

**Files:**
- Modify: `core/src/domain/feed.ts:5`, `:132`, `:371`
- Delete: `core/src/domain/markdown.ts`
- Modify: `core/test/rich-content.test.ts` (keeps its 6 feed/ingest tests)
- Modify: `core/package.json` (remove all 12 packages)
- Modify: `package-lock.json` (regenerated)

**Interfaces:**
- Consumes: `renderMarkdown(md: string): string` from `@rsc/render/src/render.ts` (Task 1).
- Produces: nothing new. `renderLocalHtml` ceases to exist.

- [ ] **Step 1: Switch `feed.ts` to the gate**

In `core/src/domain/feed.ts`, replace line 5:

```ts
import { renderLocalHtml } from './markdown.ts'
```

with:

```ts
import { renderMarkdown } from '@rsc/render/src/render.ts'
```

Replace line 132:

```ts
    description: p.source === 'local' ? renderLocalHtml(p.content) : p.content,
```

with (the remote branch `: p.content` is the deliberate RSS pass-through — leave it exactly as is):

```ts
    description: p.source === 'local' ? renderMarkdown(p.content) : p.content,
```

Replace line 371:

```ts
          ? { content_html: renderLocalHtml(p.content), content_text: p.content }
```

with:

```ts
          ? { content_html: renderMarkdown(p.content), content_text: p.content }
```

- [ ] **Step 2: Delete core's twin**

```bash
git rm core/src/domain/markdown.ts
```

- [ ] **Step 3: Reduce `core/test/rich-content.test.ts` to its feed/ingest contracts**

Replace the whole file with (these six tests are unchanged from today; only the `renderLocalHtml` import and the gate tests — now in `core/test/render.test.ts` — are gone):

```ts
import { test, expect } from 'vitest'
import { parseFeedWithMeta } from '../src/domain/ingest.ts'
import { renderRssFeed, renderJsonFeed } from '../src/domain/feed.ts'
import type { User, Post } from '../src/domain/types.ts'

// Feed/ingest contracts for rich content. The XSS gate these feeds call is
// tested on its own in core/test/render.test.ts.

test('source:markdown is captured verbatim into ParsedItem.contentMarkdown', async () => {
  const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>t</title>
<item><guid>g1</guid><description>&lt;p&gt;html&lt;/p&gt;</description><source:markdown>**md** with [link](https://x.ex)</source:markdown></item>
<item><guid>g2</guid><description>plain</description></item>
</channel></rss>`
  const { items } = await parseFeedWithMeta(rss)
  expect(items[0].contentMarkdown).toBe('**md** with [link](https://x.ex)')
  expect(items[1].contentMarkdown).toBeNull()
})

const alice: User = { id: 'u1', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null }
const basePost: Post = { id: 'p1', authorId: 'u1', source: 'local', guid: 'g-1', title: null, content: '', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }
const ctx = { publicUrl: 'https://cast.example', hubUrl: null, rssCloud: false }

test('RSS dual contract: local posts emit rendered description + raw source:markdown', () => {
  const xml = renderRssFeed(alice, [{ ...basePost, content: '**hello** world' }], ctx)
  expect(xml).toContain('<strong>hello</strong>')
  expect(xml).toContain('<source:markdown>**hello** world</source:markdown>')
})

test('RSS pass-through: remote posts re-emit content untouched + stored markdown verbatim', () => {
  const remote = { ...basePost, id: 'p2', guid: 'g-2', source: 'remote' as const, content: '<p>as-authored &amp; untouched</p>', contentMarkdown: '**their** source' }
  const xml = renderRssFeed(alice, [remote], ctx)
  expect(xml).toContain('as-authored') // content not re-rendered/sanitized
  expect(xml).toContain('<source:markdown>**their** source</source:markdown>')
})

test('JSON Feed: local posts carry content_html (rendered) + content_text (raw markdown)', () => {
  const json = JSON.parse(renderJsonFeed(alice, [{ ...basePost, content: '**hello**' }], ctx))
  expect(json.items[0].content_html).toContain('<strong>hello</strong>')
  expect(json.items[0].content_text).toBe('**hello**')
})

test('JSON Feed ingest prefers content_html over content_text (our own feeds emit rendered HTML + raw markdown)', async () => {
  const json = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 't',
    items: [{ id: 'g1', content_html: '<p><strong>hi</strong></p>', content_text: '**hi**' }],
  })
  const { items } = await parseFeedWithMeta(json)
  expect(items[0].content).toBe('<p><strong>hi</strong></p>')
})

test('reply+markdown co-occurrence: a LOCAL reply carries inReplyTo AND source:markdown in the same item', () => {
  const reply = { ...basePost, content: '**re** body', inReplyTo: 'https://a.ex/1' }
  const xml = renderRssFeed(alice, [reply], ctx)
  expect(xml).toContain('<source:inReplyTo')
  expect(xml).toContain('<thr:in-reply-to')
  expect(xml).toContain('<source:markdown>**re** body</source:markdown>')
})
```

- [ ] **Step 4: Remove the 12 packages from `core/package.json`**

The `dependencies` and `devDependencies` blocks must read exactly:

```json
  "dependencies": {
    "@better-auth/api-key": "1.7.4",
    "@hono/node-server": "^2.0.0",
    "@paulrobertlloyd/mf2tojf2": "^3.0.0",
    "better-auth": "1.7.4",
    "better-sqlite3": "^13.0.0",
    "feedsmith": "^2.9.6",
    "hono": "^4.13.7",
    "kysely": "^0.29.3",
    "microformats-parser": "^2.0.6",
    "nodemailer": "10.0.9"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^9.0.0",
    "@types/node": "^24.13.3",
    "@types/nodemailer": "8.0.1",
    "typescript": "^6.0.3",
    "vitest": "^5.0.0"
  }
```

(Everything else in the file — `name`, `scripts`, etc. — is unchanged. If `hono`, `better-auth` or any other non-moved package has a different version in the file at execution time, keep the file's version: only the 12 listed packages are removed.)

- [ ] **Step 5: Regenerate the lockfile and prove no version moved**

```bash
npx -y npm@12 install --package-lock-only
python3 - <<'EOF'
import json, subprocess
pk = ['unified','remark-parse','remark-gfm','remark-breaks','remark-emoji','remark-rehype',
      'rehype-highlight','rehype-stringify','sanitize-html','unist-util-visit','@types/hast','@types/sanitize-html']
old = json.loads(subprocess.run(['git','show','HEAD:package-lock.json'],capture_output=True,text=True,check=True).stdout)['packages']
new = json.load(open('package-lock.json'))['packages']
bad = 0
for p in pk:
    o = old.get('node_modules/'+p,{}).get('version'); n = new.get('node_modules/'+p,{}).get('version')
    flag = '' if (o == n and n) else '   <== CHANGED OR MISSING'
    bad += bool(flag)
    print(f'{p:22} {o} -> {n}{flag}')
raise SystemExit(bad)
EOF
```

Expected: all 12 unchanged, still present at root (render and web still declare them), exit 0.

Guard against unrelated churn:

```bash
git diff package-lock.json | grep -E '^[+-][[:space:]]+"version"'
```

Expected: **no output** — removing declarations from core changes no resolved version. Any output is unrelated churn — stop and report.

- [ ] **Step 6: Restart the stack and confirm nothing in core still references the twin**

Run as ONE command:

```bash
docker compose down && docker compose up -d
for i in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Health.Status}}' rsc-core 2>/dev/null)" = "healthy" ] && break; sleep 5; done
[ "$(docker inspect -f '{{.State.Health.Status}}' rsc-core)" = "healthy" ] || { echo "core NOT healthy after 7.5 min"; docker compose logs core | tail -40; exit 1; }
grep -rn "renderLocalHtml\|domain/markdown" core/src core/test && echo "STALE REFERENCES FOUND" || echo "OK: no references to the deleted twin"
```

Expected: `OK: no references to the deleted twin`. Core reaching `healthy` also proves core boots with the gate loaded through `feed.ts`.

- [ ] **Step 7: Core and web gates**

```bash
docker compose exec -T core npm run typecheck -w core; echo "tsc exit: $?"
docker compose exec -T core npm test -w core 2>&1 | grep -E "Test Files|Tests "
docker compose exec -T web env -u CORE_API_URL npm test -w web 2>&1 | grep -E "Test Files|Tests "
```

Expected: `tsc exit: 0`; core **108 files, 1224 tests**; web unchanged at **56 files, 500 tests**.

- [ ] **Step 8: Commit**

```bash
git add core/src/domain/feed.ts core/test/rich-content.test.ts core/package.json package-lock.json
git commit -F - <<'EOF'
refactor(core): feeds render through @rsc/render; delete core's sanitizer twin

feed.ts's two local-content call sites now use renderMarkdown from the shared
gate; the remote RSS pass-through (`: p.content`) is untouched by design.
core/src/domain/markdown.ts is deleted, rich-content.test.ts keeps its six
feed/ingest contracts (its gate tests live in core/test/render.test.ts), and
core/package.json drops all 12 packages the gate owns — lockfile versions
unchanged.

developed with the help of AI tools
EOF
```

(`git rm` in Step 2 already staged the deletion.)

---

### Task 3: Web's adapter uses the gate; web's twin pipeline is deleted

**Files:**
- Modify: `web/src/lib/server/render.ts` (same path, same exports, body becomes policy only)
- Modify: `web/src/lib/server/render.test.ts` (keeps 4 tests)
- **Not modified:** `web/package.json` — see Global Constraints.

**Interfaces:**
- Consumes: `renderMarkdown(md: string): string` and `sanitize(html: string): string` from `@rsc/render/src/render.ts` (Task 1).
- Produces (unchanged signatures, still consumed by 8 route files):
  - `renderPostHtml(post: { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }): string`
  - `enrichEntries<T extends { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }>(entries: T[]): (T & { contentHtml: string })[]`

- [ ] **Step 1: Reduce web's tests to its display policy, including the adapter smoke test**

Replace the whole of `web/src/lib/server/render.test.ts` with:

```ts
import { test, expect } from 'vitest'
import { renderPostHtml, enrichEntries } from './render'
import { PREVIEW_SANITIZE_OPTS } from '../preview-sanitize'

// Web's display POLICY over the XSS gate. The gate itself — hostile fixtures,
// GFM, highlighting, the canonical fixture — is tested once, in
// core/test/render.test.ts.

const remote = (content: string, contentMarkdown: string | null = null) => ({ content, contentMarkdown, source: 'remote' as const })
const local = (content: string) => ({ content, contentMarkdown: null, source: 'local' as const })

test('precedence: contentMarkdown wins; local content is markdown; remote content is HTML', () => {
	expect(renderPostHtml(remote('<p>ignored</p>', '**md**'))).toContain('<strong>md</strong>')
	expect(renderPostHtml(local('**md**'))).toContain('<strong>md</strong>')
	expect(renderPostHtml(remote('<blockquote>quoted</blockquote>'))).toContain('<blockquote>quoted</blockquote>')
})

test('remote HTML is routed through the sanitizer, never passed through (adapter smoke)', () => {
	// LOAD-BEARING. The precedence test above still passes if the remote branch
	// returned post.content raw; this is the test that fails. Proven by mutation
	// when this file was written.
	const out = renderPostHtml(remote('<script>alert(1)</script>ok'))
	expect(out).not.toContain('script')
	expect(out).toContain('ok')
})

test('enrichEntries adds contentHtml per entry and leaves other fields untouched', () => {
	const entry = { id: 'p-1', content: '**md**', contentMarkdown: null, source: 'local' as const }
	const [out] = enrichEntries([entry])
	expect(out.contentHtml).toContain('<strong>md</strong>')
	expect(out.id).toBe('p-1')
	expect(out.content).toBe('**md**')
})

test('preview sanitizer forbids what the server strips (parity pin)', () => {
	expect(PREVIEW_SANITIZE_OPTS.FORBID_TAGS).toContain('input')
	expect(PREVIEW_SANITIZE_OPTS.FORBID_ATTR).toContain('align')
})
```

- [ ] **Step 2: Run against the OLD adapter to confirm the new tests pass before the swap**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- src/lib/server/render.test.ts`
Expected: PASS, **4 tests** — the old twin implements the same policy, so this pins behaviour before the implementation changes.

- [ ] **Step 3: Replace the adapter body**

Replace the whole of `web/src/lib/server/render.ts` with:

```ts
import { renderMarkdown, sanitize } from '@rsc/render/src/render.ts'

// The XSS gate itself lives in render/src/render.ts (@rsc/render); this file
// is web's display POLICY on top of it, and the only render path for display
// HTML. Precedence: source:markdown → local-compose markdown → remote HTML.
// Every branch ends in the sanitizer — raw HTML written in markdown dies at
// the parser AND the sanitizer still runs after; remote HTML goes straight
// through sanitize().
export function renderPostHtml(post: { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }): string {
	const md = post.contentMarkdown ?? (post.source === 'local' ? post.content : null)
	return md !== null ? renderMarkdown(md) : sanitize(post.content)
}

export function enrichEntries<T extends { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }>(entries: T[]): (T & { contentHtml: string })[] {
	return entries.map((e) => ({ ...e, contentHtml: renderPostHtml(e) }))
}
```

- [ ] **Step 4: Run the tests against the new adapter**

Run: `docker compose exec -T web env -u CORE_API_URL npm test -w web -- src/lib/server/render.test.ts`
Expected: PASS, **4 tests**.

- [ ] **Step 5: Prove the smoke test is load-bearing (mutation)**

Temporarily break the remote branch, confirm only the smoke test fails, restore. Run as ONE command:

```bash
B=$(mktemp) && cp web/src/lib/server/render.ts "$B"
sed -i 's/: sanitize(post.content)/: post.content/' web/src/lib/server/render.ts
echo "sanitize calls after mutation: $(grep -c 'sanitize(post.content)' web/src/lib/server/render.ts)"
docker compose exec -T web env -u CORE_API_URL npm test -w web -- src/lib/server/render.test.ts 2>&1 | grep -E "✓|×|FAIL|passed|failed"
cp "$B" web/src/lib/server/render.ts && rm "$B"
echo "sanitize calls after restore: $(grep -c 'sanitize(post.content)' web/src/lib/server/render.ts)"
```

Expected: `sanitize calls after mutation: 0`; with the mutation, **exactly one** test fails — "remote HTML is routed through the sanitizer…" — and the precedence test still passes; `sanitize calls after restore: 1`. If the smoke test does not fail, stop and report: the spec's load-bearing claim is wrong.

- [ ] **Step 6: Confirm the gate is defined exactly once**

```bash
grep -rln "const SANITIZE_CONFIG" --include='*.ts' --include='*.svelte' core web mcp render | grep -v node_modules
grep -rln "unified()" --include='*.ts' core/src web/src render/src | grep -v node_modules
```

Expected: each prints only `render/src/render.ts`. (Grep the *definition*, `const SANITIZE_CONFIG`: the bare name also appears in comments, e.g. `core/test/render.test.ts`'s header.)

- [ ] **Step 7: Web, svelte-check and core gates**

```bash
docker compose exec -T web env -u CORE_API_URL npm test -w web 2>&1 | grep -E "Test Files|Tests "
docker compose exec -T web npm run check -w web 2>&1 | tail -2
docker compose exec -T core npm test -w core 2>&1 | grep -E "Test Files|Tests "
```

Expected: web **56 files, 487 tests**; svelte-check **0 errors and 0 warnings**; core unchanged at **108 files, 1224 tests**.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/server/render.ts web/src/lib/server/render.test.ts
git commit -F - <<'EOF'
refactor(web): render.ts becomes display policy over @rsc/render

web/src/lib/server/render.ts keeps its path and both exports, so the 8 routes
that import it are untouched; its body is now only the precedence policy,
calling renderMarkdown()/sanitize() from the shared gate. The duplicated
pipeline and SANITIZE_CONFIG are gone — the gate is defined in exactly one
file. render.test.ts keeps 4 policy tests, including the adapter smoke test,
proven load-bearing by mutation (the precedence test alone passes when remote
HTML is returned raw). web/package.json is deliberately unchanged:
adapter-node externalizes only declared dependencies.

developed with the help of AI tools
EOF
```

---

### Task 4: Docs, and proof on the production image

**Files:**
- Modify: `CLAUDE.md` (workspaces section; sanitizer invariant)
- Modify: `docs/superpowers/documentation/TESTING.md` (suite map, two lines)
- Verification only (no change expected): `docker/Dockerfile.core`, `docker/Dockerfile.web`

**Interfaces:**
- Consumes: the finished `@rsc/render` workspace and both switched consumers (Tasks 1–3).
- Produces: nothing in code.

- [ ] **Step 1: Update the workspaces section of `CLAUDE.md`**

Replace the line `Three npm workspaces in one repo:` with `Four npm workspaces in one repo:`.

Then, immediately after the `web/` bullet (the one ending `server-side via \`CORE_API_URL\`.`) and before the `mcp/` bullet, insert:

```markdown
- **`render/`** — the XSS gate (`@rsc/render`), source only: `src/render.ts`
  plus a `package.json`; no build, no tsconfig, no test runner of its own.
  core and web import it by deep path (`@rsc/render/src/render.ts`) without
  declaring it — it resolves through the npm-workspace link, exactly like
  `@rsc/mcp`. Its tests run in core's suite (`core/test/render.test.ts`) and
  core's `tsc` type-checks it.
```

- [ ] **Step 2: Replace the sanitizer invariant in `CLAUDE.md`**

Replace the whole bullet that begins `- **The sanitizer is the XSS gate.** Display HTML is produced by ONE path and` (it ends with `web component (\`PostBody.svelte\`).`) with:

```markdown
- **The sanitizer is the XSS gate, and there is exactly one.** It lives in
  `render/src/render.ts` (`@rsc/render`); core (`domain/feed.ts`) and web
  (`lib/server/render.ts`) both import it — there is no second copy, and
  `SANITIZE_CONFIG` is unexported, so change it only there. Its two entry
  points are deliberately NOT equivalent: `renderMarkdown()` parses as
  markdown, so a raw-HTML block dies at the parser before the sanitizer runs;
  `sanitize()` cleans untrusted HTML directly, so benign text survives.
  `{@html}` appears in exactly one web component (`PostBody.svelte`). The
  DOMPurify preview in `MarkdownComposer.svelte` is cosmetic, not a gate.
  **web keeps declaring the gate's runtime dependencies on purpose:**
  adapter-node externalizes only web's `dependencies`, so removing them from
  `web/package.json` would inline the sanitizer into the production bundle.
```

- [ ] **Step 2b: Point `TESTING.md`'s suite map at the new home of the gate tests**

`docs/superpowers/documentation/TESTING.md`'s "What each suite covers" map would otherwise send readers to the wrong place for sanitizer tests (spec rev 3).

In the **core** bullet, replace

```markdown
  (`auth.test.ts`), feeds in/out and dual contract (`feed.test.ts`,
  `rich-content.test.ts`), ingest + discovery (`ingest*.test.ts`,
```

with

```markdown
  (`auth.test.ts`), feeds in/out and dual contract (`feed.test.ts`,
  `rich-content.test.ts`), the XSS gate `@rsc/render` — hostile fixtures, GFM,
  highlighting, the canonical fixture (`render.test.ts`), ingest + discovery
  (`ingest*.test.ts`,
```

In the **web** bullet, replace

```markdown
  the server render/sanitizer twin (`server/render.test.ts`), the cookie-relay
```

with

```markdown
  the display-precedence adapter over the XSS gate (`server/render.test.ts`), the cookie-relay
```

- [ ] **Step 3: Build the production (Cloudron) image locally**

```bash
docker build -f cloudron/Dockerfile -t rsc-render-check . 2>&1 | tail -5
```

Expected: build succeeds (several minutes; the image is ~4GB).

- [ ] **Step 4: In the image — Node version, both entry points, and the web bundle shape**

```bash
docker run --rm rsc-render-check sh -c '
  node -v
  cd /app/code/core && node --input-type=module -e "
    const m = await import(\"@rsc/render/src/render.ts\");
    console.log(\"renderMarkdown:\", m.renderMarkdown(\"**ok**\\n\\n<script>x</script>\"));
    console.log(\"sanitize:\", m.sanitize(\"<script>x</script>ok\"));
  "
  echo "--- @rsc/render import specifiers left in web/build (expect none):"
  grep -rhoE "from ?.@rsc/render[^ ;]*" /app/code/web/build/server | sort -u
  echo "--- gate deps still EXTERNAL imports in web/build (expect all three):"
  grep -rhoE "from ?.(sanitize-html|unified|rehype-highlight)." /app/code/web/build/server | sort -u
'
```

Expected:
- `v22.22.2` — type stripping across the workspace symlink works on the **production** Node, not just the dev container's Node 24.
- `renderMarkdown: <p><strong>ok</strong></p>`. The `<script>` stands as its own **block** (blank line before it), so remark drops it whole. Measured against today's pipeline. Contrast: the same tag *inline* in a paragraph loses its tags but keeps its text — `"**ok** <script>x</script>"` gives `<p><strong>ok</strong> x</p>`.
- `sanitize: ok`.
- **No** `@rsc/render` specifier in `web/build` — the gate is bundled into web's build. This is what keeps `docker/Dockerfile.web`'s runtime stage (which copies only `web/build` and `node_modules`, not `render/`) working.
- `sanitize-html`, `unified` and `rehype-highlight` all appear as **external** imports — the production web bundle has the same shape as before the move.

Then the feed, which is spec criterion 5 ("a feed is well-formed"), checked *before* any deploy. Core's `renderRssFeed` needs no database, so it runs directly in the production image on Node 22. The image writes the XML; the host parses it. Run as ONE command:

```bash
F=$(mktemp)
docker run --rm rsc-render-check sh -c 'cd /app/code/core && node --input-type=module -e "
  const { renderRssFeed } = await import(\"./src/domain/feed.ts\");
  const u = { id: \"u1\", kind: \"local\", handle: \"alice\", displayName: \"Alice\", feedUrl: null, createdAt: \"2026-01-01T00:00:00.000Z\", authUserId: null };
  const p = { id: \"p1\", authorId: \"u1\", source: \"local\", guid: \"g-1\", title: null, content: \"**hello**\\n\\n<script>alert(1)</script>\", url: null, publishedAt: \"2026-01-01T00:00:00.000Z\", createdAt: \"2026-01-01T00:00:00.000Z\" };
  process.stdout.write(renderRssFeed(u, [p], { publicUrl: \"https://cast.example\", hubUrl: null, rssCloud: false }));
"' > "$F"
python3 - "$F" <<'EOF'
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()          # raises if not well-formed
items = root.findall('.//item')
desc = items[0].findtext('description') or ''
print('WELL-FORMED:', root.tag, '| items:', len(items))
print('description:', repr(desc))
assert '<strong>hello</strong>' in desc, 'markdown was not rendered through the gate'
assert 'script' not in desc and 'alert' not in desc, 'hostile block survived'
print('OK: feed rendered through @rsc/render on the production image')
EOF
rm -f "$F"
```

Expected: `WELL-FORMED: rss | items: 1`, a description containing `<p><strong>hello</strong></p>` with no `script`, and `OK: …`.

If any expectation in this step fails, stop and report; do not deploy.

- [ ] **Step 5: Boot the image and confirm both processes load the gate**

core imports the gate at boot (through `feed.ts`) and web imports it when `/` is server-rendered, so a booting core and a 200 on `/` prove both processes load it in the production image.

```bash
docker run -d --name rsc-render-check -p 127.0.0.1:18000:8000 \
  -e CLOUDRON_APP_ORIGIN=http://localhost:18000 \
  -v rsc-render-check-data:/app/data rsc-render-check
for i in $(seq 1 60); do docker logs rsc-render-check 2>&1 | grep -q "rsc core listening" && break; sleep 2; done
docker logs rsc-render-check 2>&1 | grep -E "rsc core listening|Listening on|Error|error" | tail -8
curl -s -o /dev/null -w 'GET / -> %{http_code}\n' http://127.0.0.1:18000/ --max-time 30
```

Expected: logs contain `rsc core listening on :8787` and web's `Listening on`, no `Error`; `GET / -> 200`.

If the container fails for a **Cloudron-environment** reason (a missing `CLOUDRON_*` variable, a platform path) rather than a module-load error such as `Cannot find package` or `Cannot find module`, report the exact log lines and continue. Step 4's in-image checks still stand as gate-load evidence, and the canary deploy covers the rest. A **module-load** error means the gate did not ship correctly: stop.

- [ ] **Step 6: Clean up the local image check**

```bash
docker rm -f rsc-render-check
docker volume rm rsc-render-check-data
docker rmi rsc-render-check
```

- [ ] **Step 7: Lockfile proof across the whole change**

Compare against the parent of Task 1's commit, the one that first added `render/package.json`. This is computed rather than hard-coded, so a parallel session's commits in between can't confuse it. Run as ONE command:

```bash
BASE=$(git log --format=%H --diff-filter=A -- render/package.json | tail -1)^
echo "base: $(git log --oneline -1 $BASE)"
BASE="$BASE" python3 - <<'EOF'
import json, os, subprocess
pk = ['unified','remark-parse','remark-gfm','remark-breaks','remark-emoji','remark-rehype',
      'rehype-highlight','rehype-stringify','sanitize-html','unist-util-visit','@types/hast','@types/sanitize-html']
old = json.loads(subprocess.run(['git','show',os.environ['BASE']+':package-lock.json'],capture_output=True,text=True,check=True).stdout)['packages']
new = json.load(open('package-lock.json'))['packages']
bad = 0
for p in pk:
    o = old.get('node_modules/'+p,{}).get('version'); n = new.get('node_modules/'+p,{}).get('version')
    flag = '' if (o == n and n) else '   <== CHANGED OR MISSING'
    bad += bool(flag)
    print(f'{p:22} {o} -> {n}{flag}')
raise SystemExit(bad)
EOF
```

Expected: all 12 unchanged, exit 0.

- [ ] **Step 8: Final gates**

```bash
docker compose exec -T core npm run typecheck -w core; echo "tsc exit: $?"
docker compose exec -T core npm test -w core 2>&1 | grep -E "Test Files|Tests "
docker compose exec -T web env -u CORE_API_URL npm test -w web 2>&1 | grep -E "Test Files|Tests "
docker compose exec -T web npm run check -w web 2>&1 | tail -2
```

Expected: `tsc exit: 0`; core **108 / 1224**; web **56 / 487**; svelte-check **0 errors and 0 warnings**.

- [ ] **Step 9: Commit**

```bash
git add CLAUDE.md docs/superpowers/documentation/TESTING.md
git commit -F - <<'EOF'
docs(claude): one XSS gate in @rsc/render — replace the twins invariant

The "hand-duplicated twins, change both or neither" rule is retired: the
sanitizer now exists exactly once, in render/src/render.ts. Documents the two
deliberately non-equivalent entry points, and why web/package.json must keep
declaring the gate's deps (adapter-node externalizes only declared
dependencies). Verified on a locally built production image: Node 22.22.2
loads the gate across the workspace symlink, both processes boot and serve,
web's bundle keeps the gate deps external, and no lockfile version moved.

developed with the help of AI tools
EOF
```

---

## After the plan

Deploying is **not** a plan task. It needs the operator's explicit go-ahead and follows the normal procedure: `cloudron build`, then skyfleet.blue as canary, then alice → bob → rsc.rmendes.net → rsc.rmdes.be, waiting for `rsc core listening` before verifying each one.

## Notes beyond the spec

- **VPS image path** (`docker/Dockerfile.core`, `docker/Dockerfile.web`, used by `compose.prod.yaml`) — not mentioned in the spec. No change is needed. `Dockerfile.core` copies the whole repo before `npm ci`. `Dockerfile.web`'s runtime stage copies only `web/build` and `node_modules`, so it depends on the gate being bundled into `web/build`. Task 4 Step 4 verifies exactly that.
- **Criterion 5 coverage, all before any deploy:**
  - Booting the image proves the gate loads in both processes: core loads it at startup via `feed.ts`, and web loads it on the `/` SSR.
  - The in-image `renderMarkdown` / `sanitize` calls prove its output on Node 22.
  - The in-image `renderRssFeed` call, parsed on the host, proves a well-formed feed rendered through the gate.
  - A fresh image has no users, so "renders posts" on real data is the one part left to the canary deploy, where it is a confirmation rather than the test.
- **Not changed:** `README.md:153` says "Two workspaces". That was already stale before this change (mcp made three), and fixing it is out of scope.
