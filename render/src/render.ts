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
