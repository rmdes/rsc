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
