// Split out of routes/mcp/+server.ts: SvelteKit's postbuild endpoint analysis
// rejects any +server.ts export that isn't a recognized route export (GET,
// POST, ...) or '_'-prefixed — `export function bearer` there builds fine
// under vitest but fails a real `vite build` ("Invalid export 'bearer' in
// /mcp"). This predicate is the whole hosted-transport auth perimeter, so it
// still gets a direct unit test — just from a plain module, not the endpoint.

// RFC 7235: the auth scheme is case-insensitive.
export function bearer(request: Request): string | null {
	const raw = request.headers.get('authorization')
	if (!raw) return null
	const m = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim())
	return m ? m[1] : null
}
