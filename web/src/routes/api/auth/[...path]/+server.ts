import type { RequestHandler } from './$types'
import { base, relaySetCookies } from '$lib/server/session'

// C1 (final review): better-auth's baseURL is the WEB origin, so every emailed
// link — verify, magic-link, password-reset — points at `<web>/api/auth/*`.
// The web app must actually serve those: SvelteKit forwards nothing to core on
// its own, and the form-action relays only cover the POSTs the app initiates.
// This catch-all proxies the whole surface (GET link-clicks included) to core,
// forwarding cookies + Origin (CSRF) + the client address (rate limiting), and
// relaying Set-Cookie back — so a magic-link GET actually lands a session in
// the browser. Redirects are RELAYED (redirect: 'manual'), not followed: a
// verify/magic link returns a 302 the browser must navigate to.
const proxy: RequestHandler = async ({ request, params, url, cookies, getClientAddress }) => {
	// Resolve first, match on the RESOLVED path. `params.path` arrives
	// percent-decoded, so `..%2f` is a real `../` that a string match misses and
	// fetch normalizes away — checking the segment instead of the path we send
	// served the reference page and turned this into a general-purpose core
	// proxy (live-confirmed, fixed 2026-08-04). Absolute string, NOT
	// `new URL(params.path, base)`: relative resolution lets `//evil.host`
	// repoint the request off-box.
	const target = new URL(`${base()}/api/auth/${params.path}${url.search}`)
	// Confined to /api/auth/* (the rest of core stays internal), and the
	// dev-only openAPI reference (spec 2026-07-19-auth-openapi) blocked in EVERY
	// environment — the second, independent guard beside the core flag defaulting
	// off. 404 not 403, so we don't confirm the routes exist.
	if (
		!target.pathname.startsWith('/api/auth/') ||
		target.pathname === '/api/auth/reference' ||
		target.pathname.startsWith('/api/auth/open-api')
	) {
		return new Response(null, { status: 404 })
	}
	const headers = new Headers()
	const cookie = cookies.getAll().map((c) => `${c.name}=${c.value}`).join('; ')
	if (cookie) headers.set('cookie', cookie)
	headers.set('origin', url.origin) // trustedOrigin; better-auth 403s cookie-bearing requests without it
	headers.set('x-forwarded-for', getClientAddress())
	const ct = request.headers.get('content-type')
	if (ct) headers.set('content-type', ct)

	const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
	const upstream = await fetch(target.href, {
		method: request.method,
		headers,
		body: hasBody ? await request.text() : undefined,
		redirect: 'manual' // relay 302s to the browser (verify/magic links redirect to a callbackURL)
	})

	relaySetCookies(cookies, upstream) // SvelteKit merges these into the response we return
	const out = new Headers()
	for (const h of ['location', 'content-type']) {
		const v = upstream.headers.get(h)
		if (v) out.set(h, v)
	}
	return new Response(upstream.body, { status: upstream.status, headers: out })
}

export const GET = proxy
export const POST = proxy
