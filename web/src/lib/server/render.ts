import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'

const SANITIZE_CONFIG: sanitizeHtml.IOptions = {
	allowedTags: ['p', 'br', 'a', 'em', 'strong', 'b', 'i', 'blockquote', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'img'],
	allowedAttributes: { a: ['href', 'rel'], img: ['src', 'loading'] },
	allowedSchemes: ['http', 'https'],
	transformTags: {
		a: sanitizeHtml.simpleTransform('a', { rel: 'noreferrer' }),
		img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' })
	}
}

// The one render path. Precedence: source:markdown → local-compose markdown →
// remote HTML. Every branch ends in the sanitizer — marked passes raw HTML
// through (probed), so sanitize-after-marked is load-bearing.
export function renderPostHtml(post: { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }): string {
	const md = post.contentMarkdown ?? (post.source === 'local' ? post.content : null)
	const html = md !== null ? (marked.parse(md, { async: false }) as string) : post.content
	return sanitizeHtml(html, SANITIZE_CONFIG)
}

export function enrichEntries<T extends { content: string; contentMarkdown?: string | null; source: 'local' | 'remote' }>(entries: T[]): (T & { contentHtml: string })[] {
	return entries.map((e) => ({ ...e, contentHtml: renderPostHtml(e) }))
}
