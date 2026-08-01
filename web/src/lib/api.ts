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

// null ⇒ the handle does not resolve (core 404) — the caller renders not-found;
// any other non-ok still throws (a core problem, not a missing user).
export async function getHandleStats(f: typeof fetch, handle: string): Promise<{ posts: number; followers: number; following: number; kind: 'local' | 'remote' } | null> {
	const res = await f(`${base()}/users/${encodeURIComponent(handle)}/stats`)
	if (res.status === 404) return null
	if (!res.ok) throw new Error(await errorMessage(res, `stats ${res.status}`))
	return res.json()
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

// Public instance config (mail capability + tab label/subtitle overrides).
// Fail-soft: any fetch/parse error falls back to defaults, never crashes the layout.
export async function getInstanceConfig(f: typeof fetch): Promise<{
	mailEnabled: boolean
	tabLabels: Record<string, string | null>
	tabSubtitles: Record<string, string | null>
}> {
	try {
		const res = await f(`${base()}/instance/config`)
		if (!res.ok) throw new Error(`instance/config ${res.status}`)
		const body = (await res.json()) as { mailEnabled?: boolean; tabs?: { labels?: Record<string, string | null>; subtitles?: Record<string, string | null> } }
		return { mailEnabled: body.mailEnabled === true, tabLabels: body.tabs?.labels ?? {}, tabSubtitles: body.tabs?.subtitles ?? {} }
	} catch {
		return { mailEnabled: false, tabLabels: {}, tabSubtitles: {} }
	}
}

export async function getAdminOverview(f: typeof fetch): Promise<{
	counts: { registeredUsers: number; guests: number; remoteFeeds: number; posts: number }
	federation: { websub: string; rssCloud: boolean; pushIn: boolean; publicUrl: string | null }
	mailEnabled: boolean
	adminEmails: string[]
	scheduler: {
		catalogSize: number
		mostOverdueSeconds: number | null
		attemptedLastWindow: number
		windowSpanSeconds: number | null
	}
}> {
	const res = await f(`${base()}/admin/overview`)
	if (!res.ok) throw new Error(await errorMessage(res, 'getAdminOverview failed'))
	return await res.json()
}

export interface AdminUserRow {
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

export async function getAdminSettings(f: typeof fetch): Promise<{
	maxSubsPerUser: number
	maxRemoteItemsPerSource: number
	maxRemoteItemAgeDays: number
	tabLabels: Record<string, string | null>
	tabSubtitles: Record<string, string | null>
}> {
	const res = await f(`${base()}/admin/settings`)
	if (!res.ok) throw new Error(await errorMessage(res, 'getAdminSettings failed'))
	return (await res.json()) as {
		maxSubsPerUser: number
		maxRemoteItemsPerSource: number
		maxRemoteItemAgeDays: number
		tabLabels: Record<string, string | null>
		tabSubtitles: Record<string, string | null>
	}
}

export async function patchAdminSettings(
	f: typeof fetch,
	body: {
		maxSubsPerUser: number
		maxRemoteItemsPerSource: number
		maxRemoteItemAgeDays: number
		tabLabels?: Record<string, string>
		tabSubtitles?: Record<string, string>
	}
): Promise<void> {
	const res = await f(`${base()}/admin/settings`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	})
	if (!res.ok) throw new Error(await errorMessage(res, 'patchAdminSettings failed'))
}

// --- personal API keys (phase 2 read API) --------------------------------------
// configId: 'user' is required on every call — better-auth's resolveConfiguration()
// falls back to a config literally named 'default' otherwise and throws
// NO_DEFAULT_API_KEY_CONFIGURATION_FOUND (confirmed against the installed
// @better-auth/api-key source and core/test/api-key-plugin.test.ts, Task 1).

export interface ApiKeySummary {
	id: string
	name: string | null
	// The CONFIG-WIDE prefix constant (identical on every key in this config,
	// e.g. "rsc_") — kept for completeness of the real wire shape, but never
	// the field the UI shows to tell keys apart; that's `start` below.
	prefix: string | null
	// The per-key distinguishing fragment ("the starting characters of the
	// API key... for the users to easily identify" — better-auth's own field
	// description). This is what the settings page renders per row.
	start: string | null
	createdAt: string
	permissions: Record<string, string[]> | null
}

export async function listApiKeys(f: typeof fetch): Promise<ApiKeySummary[]> {
	const res = await f(`${base()}/api/auth/api-key/list?configId=user`)
	if (!res.ok) throw new Error(await errorMessage(res, `listApiKeys ${res.status}`))
	const body = (await res.json()) as { apiKeys: ApiKeySummary[] }
	return body.apiKeys
}

export interface CreatedApiKey {
	id: string
	key: string // plaintext — the plugin returns this exactly once, on creation
	name: string | null
	prefix: string | null
}

// Core's OWN /me/api-keys route, NOT better-auth's /api/auth/api-key/create —
// that REST endpoint hard-rejects a `permissions` field on any real HTTP
// request (SERVER_ONLY_PROPERTY; verified against the running server, not
// from the plugin's docs). Setting permissions only works via an in-process
// auth.api.createApiKey call, so core exposes this cookie-authed wrapper
// instead (core/src/api/logical-routes.ts, mountPersonalApiRoutes).
// Status is attached to the thrown error (not just folded into the message)
// so the caller can tell a clean 4xx core rejection (bad name, guest
// session) apart from a genuine server error — same distinction
// register/+page.server.ts makes by reading res.status directly, needed
// here too since this helper is the one that owns the fetch.
export async function createApiKey(f: typeof fetch, input: { name: string; permissions: Record<string, string[]> }): Promise<CreatedApiKey> {
	const res = await f(`${base()}/me/api-keys`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name: input.name, permissions: input.permissions })
	})
	if (!res.ok) throw Object.assign(new Error(await errorMessage(res, `createApiKey ${res.status}`)), { status: res.status })
	return (await res.json()) as CreatedApiKey
}

// Body field is `keyId`, not `id` (the plugin's deleteApiKeyBodySchema).
// Status is attached to the thrown error, same as createApiKey above — the
// revoke action (settings/api-keys/+page.server.ts) needs it to tell a clean
// 4xx core rejection (e.g. an already-revoked/nonexistent key id, a real 404)
// apart from a genuine server error (final review Finding 4).
export async function revokeApiKey(f: typeof fetch, keyId: string): Promise<void> {
	const res = await f(`${base()}/api/auth/api-key/delete`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ configId: 'user', keyId })
	})
	if (!res.ok) throw Object.assign(new Error(await errorMessage(res, `revokeApiKey ${res.status}`)), { status: res.status })
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
