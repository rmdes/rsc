import { env } from '$env/dynamic/private'
import type { TimelineEntry } from './types.ts'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export interface TimelinePage {
	timeline: TimelineEntry[]
	nextCursor: string | null
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as { error?: unknown }
		if (typeof body.error === 'string') return body.error
	} catch {
		// non-JSON body — use the fallback
	}
	return fallback
}

export async function getTimeline(
	f: typeof fetch,
	opts: { before?: string; followedBy?: string; author?: string; source?: 'local'; feedType?: 'instance' } = {}
): Promise<TimelinePage> {
	// Build the query manually with encodeURIComponent — NOT URLSearchParams.
	// The cursor wire format is `<publishedAt>~<id>`; URLSearchParams'
	// form-encoding mangled it once already (found, fixed, revert rejected). P3.
	const url = new URL(`${base()}/timeline`)
	const params: string[] = []
	if (opts.before) params.push(`before=${encodeURIComponent(opts.before)}`)
	if (opts.followedBy) params.push(`followed_by=${encodeURIComponent(opts.followedBy)}`)
	if (opts.author) params.push(`author=${encodeURIComponent(opts.author)}`)
	if (opts.source) params.push(`source=${opts.source}`)
	if (opts.feedType) params.push(`feed_type=${opts.feedType}`)
	if (params.length) url.search = params.join('&')
	const res = await f(url.toString())
	if (!res.ok) throw new Error(await errorMessage(res, `timeline ${res.status}`))
	const body = (await res.json()) as { timeline: TimelineEntry[]; nextCursor?: string | null }
	return { timeline: body.timeline, nextCursor: body.nextCursor ?? null }
}

export interface Peer {
	handle: string
	displayName: string
	feedUrl: string | null
}

// Textcasting peers: remote feeds whose items carry source:markdown — the
// instances this one verifiably interops/threads with.
export async function getPeers(f: typeof fetch): Promise<Peer[]> {
	const res = await f(`${base()}/peers`)
	if (!res.ok) throw new Error(await errorMessage(res, `peers ${res.status}`))
	return (await res.json()).peers
}

export async function getFollowing(f: typeof fetch, handle: string): Promise<TimelineEntry['author'][]> {
	const res = await f(`${base()}/users/${encodeURIComponent(handle)}/follows`)
	if (!res.ok) throw new Error(await errorMessage(res, `following ${res.status}`))
	return (await res.json()).following
}

export async function addFollow(f: typeof fetch, target: string): Promise<void> {
	const res = await f(`${base()}/me/follows`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ handle: target })
	})
	if (!res.ok) throw new Error(await errorMessage(res, `addFollow ${res.status}`))
}

export async function removeFollow(f: typeof fetch, target: string): Promise<void> {
	const res = await f(`${base()}/me/follows/${encodeURIComponent(target)}`, { method: 'DELETE' })
	if (!res.ok) throw new Error(await errorMessage(res, `removeFollow ${res.status}`))
}

export async function importOpml(f: typeof fetch, opml: string): Promise<{ followed: number; created: number; skipped: number }> {
	const res = await f(`${base()}/me/follows/opml`, { method: 'POST', body: opml })
	if (!res.ok) throw new Error(await errorMessage(res, `importOpml ${res.status}`))
	return res.json()
}

export async function createPost(f: typeof fetch, input: { content: string; inReplyTo?: string }): Promise<void> {
	const res = await f(`${base()}/posts`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input)
	})
	if (!res.ok) throw new Error(await errorMessage(res, `createPost ${res.status}`))
}

export async function editPost(f: typeof fetch, id: string, content: string): Promise<void> {
	const res = await f(`${base()}/posts/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ content })
	})
	if (!res.ok) throw new Error(await errorMessage(res, `editPost ${res.status}`))
}

export interface Revision { id: string; title: string | null; content: string; contentMarkdown: string | null; seenAt: string }
// `post` is core's bare Post (NO author at runtime) — typed via Omit so reading
// `.author` off it is a compile error. The history page reads only content/markdown/source/editedAt.
export async function getRevisions(f: typeof fetch, id: string): Promise<{ post: Omit<TimelineEntry, 'author'>; revisions: Revision[] }> {
	const res = await f(`${base()}/posts/${encodeURIComponent(id)}/revisions`)
	if (!res.ok) throw new Error(await errorMessage(res, `revisions ${res.status}`))
	return (await res.json()) as { post: Omit<TimelineEntry, 'author'>; revisions: Revision[] }
}

// emailVerified is optional and NOT sent by core's /me today (hard verification
// means an unverified password account can never reach a resolvable session —
// see auth.ts). Typed here so the identity bar's verify-nudge branch (which
// can never fire yet) is ready without another core change.
export async function getMe(f: typeof fetch): Promise<{ user: TimelineEntry['author']; isAnonymous: boolean; emailVerified?: boolean; isAdmin?: boolean } | null> {
	const res = await f(`${base()}/me`)
	if (res.status === 401) return null
	if (!res.ok) throw new Error(await errorMessage(res, 'getMe failed'))
	return (await res.json()) as { user: TimelineEntry['author']; isAnonymous: boolean; emailVerified?: boolean; isAdmin?: boolean }
}

export async function updateProfile(f: typeof fetch, patch: { handle?: string; displayName?: string }): Promise<void> {
	const res = await f(`${base()}/me`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(patch)
	})
	if (!res.ok) throw new Error(await errorMessage(res, 'updateProfile failed'))
}

export async function getThread(f: typeof fetch, id: string): Promise<TimelineEntry[]> {
	const res = await f(`${base()}/post/${encodeURIComponent(id)}/thread`)
	if (!res.ok) throw new Error(await errorMessage(res, `thread ${res.status}`))
	return (await res.json()).thread
}

export async function addRemoteUser(
	f: typeof fetch,
	input: { handle: string; displayName: string; feedUrl: string }
): Promise<void> {
	const res = await f(`${base()}/users`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input)
	})
	if (!res.ok) throw new Error(await errorMessage(res, `addRemoteUser ${res.status}`))
}

export async function listAdminFeeds(f: typeof fetch): Promise<Array<{ handle: string; displayName: string; feedUrl: string | null }>> {
	const res = await f(`${base()}/admin/feeds`)
	if (!res.ok) throw new Error(await errorMessage(res, 'listAdminFeeds failed'))
	return ((await res.json()) as { feeds: Array<{ handle: string; displayName: string; feedUrl: string | null }> }).feeds
}

export async function removeRemoteFeed(f: typeof fetch, handle: string): Promise<void> {
	const res = await f(`${base()}/users/${encodeURIComponent(handle)}`, { method: 'DELETE' })
	if (!res.ok) throw new Error(await errorMessage(res, 'removeRemoteFeed failed'))
}

export async function getAdminOverview(f: typeof fetch): Promise<{
	counts: { registeredUsers: number; guests: number; remoteFeeds: number; posts: number }
	federation: { websub: string; rssCloud: boolean; pushIn: boolean; publicUrl: string | null }
	mailEnabled: boolean
	adminEmails: string[]
}> {
	const res = await f(`${base()}/admin/overview`)
	if (!res.ok) throw new Error(await errorMessage(res, 'getAdminOverview failed'))
	return await res.json()
}

export async function listAdminUsers(
	f: typeof fetch
): Promise<Array<{ handle: string; displayName: string; kind: string; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }>> {
	const res = await f(`${base()}/admin/users`)
	if (!res.ok) throw new Error(await errorMessage(res, 'listAdminUsers failed'))
	return (
		(await res.json()) as {
			users: Array<{ handle: string; displayName: string; kind: string; emailVerified: boolean | null; createdAt: string; feedUrl: string | null }>
		}
	).users
}

export async function deleteLocalAccount(f: typeof fetch, handle: string): Promise<void> {
	const res = await f(`${base()}/admin/users/${encodeURIComponent(handle)}`, { method: 'DELETE' })
	if (!res.ok) throw new Error(await errorMessage(res, 'deleteLocalAccount failed'))
}

export async function deletePost(f: typeof fetch, id: string): Promise<void> {
	const res = await f(`${base()}/admin/posts/${encodeURIComponent(id)}`, { method: 'DELETE' })
	if (!res.ok) throw new Error(await errorMessage(res, 'deletePost failed'))
}

export interface DeviceSession {
	session: { token: string }
	user: { id: string; email: string; name: string; isAnonymous?: boolean }
}

// GET (M3). f already carries cookie + Origin.
export async function listDeviceSessions(f: typeof fetch): Promise<DeviceSession[]> {
	const res = await f(`${base()}/api/auth/multi-session/list-device-sessions`)
	if (!res.ok) throw new Error(await errorMessage(res, `sessions ${res.status}`))
	return (await res.json()) as DeviceSession[]
}

// The active auth user id (better-auth's /get-session); null when signed out.
export async function getActiveAuthUserId(f: typeof fetch): Promise<string | null> {
	const res = await f(`${base()}/api/auth/get-session`)
	if (!res.ok) return null
	const body = (await res.json()) as { user?: { id?: string } } | null
	return body?.user?.id ?? null
}

// POST; caller relays the Set-Cookie the plugin returns.
export async function setActiveSession(f: typeof fetch, sessionToken: string): Promise<Response> {
	const res = await f(`${base()}/api/auth/multi-session/set-active`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ sessionToken })
	})
	if (!res.ok) throw new Error(await errorMessage(res, `set-active ${res.status}`))
	return res
}

export async function revokeSession(f: typeof fetch, sessionToken: string): Promise<Response> {
	const res = await f(`${base()}/api/auth/multi-session/revoke`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ sessionToken })
	})
	if (!res.ok) throw new Error(await errorMessage(res, `revoke ${res.status}`))
	return res
}
