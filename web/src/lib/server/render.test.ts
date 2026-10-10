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
