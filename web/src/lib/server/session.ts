import type { Cookies } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export function hasSession(cookies: Cookies): boolean {
	return cookies.getAll().some((c) => c.name.includes('session_token'))
}

export function cookieHeader(cookies: Cookies): string | null {
	const all = cookies.getAll()
	if (all.length === 0) return null
	return all.map((c) => `${c.name}=${c.value}`).join('; ')
}

// SEC-1: core sits on another origin — SvelteKit's fetch forwards nothing.
// Every authed core call carries the browser's cookies AND an explicit
// Origin (better-auth 403s cookie-bearing requests without one, probed).
export function authedFetch(f: typeof fetch, origin: string, cookie: string | null): typeof fetch {
	return (input, init = {}) => {
		const headers = new Headers(init?.headers)
		if (cookie) headers.set('cookie', cookie)
		headers.set('origin', origin)
		return f(input, { ...init, headers })
	}
}

// Relay contract (SEC-1): re-emit better-auth's cookies for the WEB origin —
// httpOnly, SameSite=Lax, Path=/; Secure comes from SvelteKit (auto off on
// localhost, on in production).
export function relaySetCookies(cookies: Cookies, res: Response): void {
	for (const sc of res.headers.getSetCookie()) {
		const [pair, ...attrs] = sc.split(';')
		const eq = pair.indexOf('=')
		if (eq < 1) continue
		const name = pair.slice(0, eq).trim()
		const value = pair.slice(eq + 1).trim()
		const maxAgeRaw = attrs.find((a) => a.trim().toLowerCase().startsWith('max-age'))?.split('=')[1]?.trim()
		const maxAge = maxAgeRaw !== undefined ? Number(maxAgeRaw) : undefined
		if (maxAge !== undefined && maxAge <= 0) {
			cookies.delete(name, { path: '/' })
		} else {
			cookies.set(name, value, { path: '/', httpOnly: true, sameSite: 'lax', ...(maxAge !== undefined ? { maxAge } : {}) })
		}
	}
}

// Mint-then-act (spec NEW-2): no session → sign in anonymously, thread the
// JUST-MINTED cookie onto the follow-up core call in-process, and relay it
// to the browser on this same response.
export async function ensureSessionFetch(event: { fetch: typeof fetch; cookies: Cookies; url: URL }): Promise<typeof fetch> {
	if (hasSession(event.cookies)) return authedFetch(event.fetch, event.url.origin, cookieHeader(event.cookies))
	const res = await event.fetch(`${base()}/api/auth/sign-in/anonymous`, {
		method: 'POST',
		headers: { origin: event.url.origin }
	})
	if (!res.ok) throw new Error(`anonymous sign-in failed (${res.status})`)
	relaySetCookies(event.cookies, res)
	const minted = res.headers.getSetCookie().map((sc) => sc.split(';')[0]).join('; ')
	return authedFetch(event.fetch, event.url.origin, minted)
}
