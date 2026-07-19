import type { PageServerLoad, Actions } from './$types'
import { redirect, type Cookies } from '@sveltejs/kit'
import { authedFetch, cookieHeader, relaySetCookies } from '$lib/server/session'
import { listDeviceSessions, getActiveAuthUserId, setActiveSession, revokeSession } from '$lib/api'
import { env } from '$env/dynamic/private'

const env_base = () => env.CORE_API_URL ?? 'http://localhost:8787'

// Registered-only (M4): a guest/anon or signed-out visitor never sees the switcher.
function guard(me: { isAnonymous?: boolean } | null): asserts me is { isAnonymous?: boolean } {
	if (!me || me.isAnonymous) throw redirect(303, '/')
}

// Explicit OutputData (not the bare `PageServerLoad`): the default generic's
// OutputDataShape wraps the return in `T | void`, which the test's direct
// `out.accounts` access (no cast, matching the brief) can't see through.
export const load: PageServerLoad<{ accounts: { id: string; email: string; active: boolean }[] }> = async ({
	fetch,
	cookies,
	url,
	parent,
}) => {
	const { me } = await parent()
	guard(me)
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	const [sessions, activeId] = await Promise.all([listDeviceSessions(f), getActiveAuthUserId(f)])
	const accounts = sessions
		.filter((s) => !s.user.isAnonymous) // M1: hide the guest slot
		.map((s) => ({ id: s.user.id, email: s.user.email, active: s.user.id === activeId }))
	return { accounts }
}

// Resolve an opaque auth-user id → its session token, server-side (M5: never
// trust a token from the form). Returns null if the id isn't a held registered
// session.
async function tokenForId(f: typeof fetch, id: string): Promise<string | null> {
	const sessions = await listDeviceSessions(f)
	const hit = sessions.find((s) => s.user.id === id && !s.user.isAnonymous)
	return hit?.session.token ?? null
}

// signOut = revoke-ALL held sessions (verified: needs JSON content-type + a
// body). Used for "log out of all" AND the "no registered account left" logout
// branch (R1) — we never revoke(active) there, because revoke of the active
// token auto-promotes validSessions[0], which would hand the browser to a
// lingering guest. signOut has no promote path.
async function signOutAll(fetch: typeof globalThis.fetch, cookies: Cookies, url: URL): Promise<void> {
	const cookie = cookieHeader(cookies)
	if (!cookie) return
	const res = await fetch(`${env_base()}/api/auth/sign-out`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: url.origin, cookie },
		body: '{}',
	})
	relaySetCookies(cookies, res)
}

export const actions = {
	switch: async ({ request, fetch, cookies, url }) => {
		const id = String((await request.formData()).get('id') ?? '')
		const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
		const token = await tokenForId(f, id)
		if (token) relaySetCookies(cookies, await setActiveSession(f, token))
		throw redirect(303, '/accounts')
	},

	// M2: switch to another registered account FIRST, then revoke the old active
	// token — so revoke never hits its arbitrary validSessions[0] auto-promote.
	logoutOne: async ({ fetch, cookies, url }) => {
		const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
		const [sessions, activeId] = await Promise.all([listDeviceSessions(f), getActiveAuthUserId(f)])
		const active = sessions.find((s) => s.user.id === activeId)
		if (!active) throw redirect(303, '/accounts') // no identifiable active session → bail, don't switch-without-revoke (P4)
		const next = sessions.find((s) => s.user.id !== activeId && !s.user.isAnonymous)
		if (next) {
			relaySetCookies(cookies, await setActiveSession(f, next.session.token))
			// re-wrap f with the NEW cookies so revoke runs as `next`, with `active`
			// no longer the active session
			const f2 = authedFetch(fetch, url.origin, cookieHeader(cookies))
			relaySetCookies(cookies, await revokeSession(f2, active.session.token))
			throw redirect(303, '/accounts')
		}
		// No other registered account: signOut (revoke-ALL) — NOT revoke(active),
		// which would auto-promote a lingering guest to active (R1). Clears
		// everything incl. the guest → signed-out.
		await signOutAll(fetch, cookies, url)
		throw redirect(303, '/')
	},

	logoutAll: async ({ fetch, cookies, url }) => {
		await signOutAll(fetch, cookies, url)
		throw redirect(303, '/')
	},
} satisfies Actions
