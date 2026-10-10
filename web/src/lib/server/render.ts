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
