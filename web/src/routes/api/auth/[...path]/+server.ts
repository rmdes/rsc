import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { relaySetCookies } from '$lib/server/session'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

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
	// Dev-only openAPI reference (spec 2026-07-19-auth-openapi): better-auth's
	// openAPI() plugin serves /api/auth/reference + /api/auth/open-api/* under
	// the auth base path, which this proxy would otherwise publish. Hard-404 them
	// in EVERY environment — the second, independent guard beside the core flag
	// defaulting off. 404 (not 403) so we don't even confirm the route exists.
	if (params.path === 'reference' || params.path.startsWith('open-api')) {
		return new Response(null, { status: 404 })
	}
	const target = `${base()}/api/auth/${params.path}${url.search}`
	const headers = new Headers()
	const cookie = cookies.getAll().map((c) => `${c.name}=${c.value}`).join('; ')
	if (cookie) headers.set('cookie', cookie)
	headers.set('origin', url.origin) // trustedOrigin; better-auth 403s cookie-bearing requests without it
	headers.set('x-forwarded-for', getClientAddress())
	const ct = request.headers.get('content-type')
	if (ct) headers.set('content-type', ct)

	const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
	const upstream = await fetch(target, {
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
