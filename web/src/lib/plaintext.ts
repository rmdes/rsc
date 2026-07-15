// Feed content is stored verbatim (HTML included) per the Textcasting
// pass-through; the timeline displays it as plain text. Strip-for-display,
// isomorphic (no DOM), no sanitizer dep — the output is still rendered
// escaped by Svelte, so this is presentation, not a security boundary.
// ponytail: rich rendering needs a real sanitizer; add one when the UI
// decides to show markup instead of text.

const NAMED: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	hellip: '…',
	mdash: '—',
	ndash: '–'
}

export function plaintext(html: string): string {
	return html
		.replace(/<[^>]*>/g, ' ')
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
		.replace(/&([a-z]+);/g, (m, name: string) => NAMED[name] ?? m)
		.replace(/\s+/g, ' ')
		.trim()
}
