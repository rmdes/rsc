import { base } from '$lib/server/session'
import type { OwnerFollowingView, TimelineEntry } from './types.ts'

async function errorMessage(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as { error?: unknown }
		if (typeof body.error === 'string') return body.error
	} catch {
		// non-JSON body — use the fallback
	}
	return fallback
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

export interface AdminUserRow {
	id: string
	handle: string
	displayName: string
	kind: string
	emailVerified: boolean | null
	createdAt: string
	feedUrl: string | null
}

// Cursor-paginated (Task 3): mirrors listAdminSources' shape ({items, nextCursor}).
export async function listAdminUsers(f: typeof fetch, cursor?: string): Promise<{ items: AdminUserRow[]; nextCursor: string | null }> {
	const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
	const res = await f(`${base()}/admin/users${qs}`)
	if (!res.ok) throw new Error(await errorMessage(res, 'listAdminUsers failed'))
	return (await res.json()) as { items: AdminUserRow[]; nextCursor: string | null }
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

export async function getAdminSettings(f: typeof fetch): Promise<{ maxSubsPerUser: number }> {
	const res = await f(`${base()}/admin/settings`)
	if (!res.ok) throw new Error(await errorMessage(res, 'getAdminSettings failed'))
	return (await res.json()) as { maxSubsPerUser: number }
}

export async function patchAdminSettings(f: typeof fetch, body: { maxSubsPerUser: number }): Promise<void> {
	const res = await f(`${base()}/admin/settings`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	})
	if (!res.ok) throw new Error(await errorMessage(res, 'patchAdminSettings failed'))
}

// --- v2 source registry -------------------------------------------------------

export type SubscribeOutcome =
	| { kind: 'source'; created: boolean }
	| { kind: 'pending' }
	| { kind: 'local'; handle: string; created: boolean }

// v2 subscribe: no `type` (core derives it), a durable `commandId` instead.
// Replaying an id returns the original result AND its original status, so
// `created` comes from the status line, not the body.
export async function subscribeToSource(f: typeof fetch, input: { url: string; commandId: string }): Promise<SubscribeOutcome> {
	const res = await f(`${base()}/me/subscriptions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input)
	})
	if (!res.ok) throw new Error(await errorMessage(res, `subscribe ${res.status}`))
	const body = (await res.json()) as { subscription?: unknown; follow?: { handle: string } }
	const created = res.status === 201
	// The pending payload is two keys and nothing else — never the owner
	// projection, so there is no governance to read even if we wanted to.
	if (body.subscription === 'pending') return { kind: 'pending' }
	if (body.follow) return { kind: 'local', handle: body.follow.handle, created }
	return { kind: 'source', created }
}

// By stable source id, never by URL or handle.
export async function unsubscribeSource(f: typeof fetch, sourceId: string, commandId: string): Promise<void> {
	const res = await f(`${base()}/me/subscriptions/${encodeURIComponent(sourceId)}`, {
		method: 'DELETE',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ commandId })
	})
	if (!res.ok) throw new Error(await errorMessage(res, `unsubscribe ${res.status}`))
}

export async function getOwnerFollowing(f: typeof fetch): Promise<OwnerFollowingView> {
	const res = await f(`${base()}/me/following`)
	if (!res.ok) throw new Error(await errorMessage(res, `following ${res.status}`))
	return (await res.json()) as OwnerFollowingView
}

export interface OpmlImportV2 {
	localFollowed: number
	active: number
	pending: number
	unavailable: number
	notSubscribable: number
	capSkipped: number
}
// The command id travels as a header here — the body is XML, not JSON.
export async function importOpmlV2(f: typeof fetch, opml: string, commandId: string): Promise<OpmlImportV2> {
	const res = await f(`${base()}/me/follows/opml`, { method: 'POST', headers: { 'x-rsc-command-id': commandId }, body: opml })
	if (!res.ok) throw new Error(await errorMessage(res, `importOpml ${res.status}`))
	return (await res.json()) as OpmlImportV2
}
