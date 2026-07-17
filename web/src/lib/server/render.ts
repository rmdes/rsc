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
		img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' })
	}
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

// The twin of core/src/domain/markdown.ts — same chain, same order, same
// versions (exact-pinned in both package.json). The canonical fixture in
// both test suites asserts byte-identity. Everything here is sync:
// renderPostHtml's SSE path cannot await, so an async plugin is a defect.
const pipeline = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkBreaks)
	.use(remarkEmoji) // accessible stays default-off: emoji must be bare text
	.use(remarkRehype)
	.use(skipOversizedFences)
	.use(rehypeHighlight) // detect stays default-off: unlabeled fences render plain
	.use(rehypeStringify)

// The one render path. Precedence: source:markdown → local-compose markdown →
// remote HTML. Every branch ends in the sanitizer — raw HTML written in
// markdown dies at the parser AND the sanitizer still runs after.
export function renderPostHtml(post: { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }): string {
	const md = post.contentMarkdown ?? (post.source === 'local' ? post.content : null)
	const html = md !== null ? String(pipeline.processSync(md)) : post.content
	return sanitizeHtml(html, SANITIZE_CONFIG)
}

export function enrichEntries<T extends { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }>(entries: T[]): (T & { contentHtml: string })[] {
	return entries.map((e) => ({ ...e, contentHtml: renderPostHtml(e) }))
}
