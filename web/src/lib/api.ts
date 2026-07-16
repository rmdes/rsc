import { env } from '$env/dynamic/private'
import type { TimelineEntry } from './types.ts'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'
const token = () => env.CORE_API_TOKEN ?? ''

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
	opts: { before?: string; followedBy?: string; author?: string } = {}
): Promise<TimelinePage> {
	// Build the query manually with encodeURIComponent — NOT URLSearchParams.
	// The cursor wire format is `<publishedAt>~<id>`; URLSearchParams'
	// form-encoding mangled it once already (found, fixed, revert rejected). P3.
	const url = new URL(`${base()}/timeline`)
	const params: string[] = []
	if (opts.before) params.push(`before=${encodeURIComponent(opts.before)}`)
	if (opts.followedBy) params.push(`followed_by=${encodeURIComponent(opts.followedBy)}`)
	if (opts.author) params.push(`author=${encodeURIComponent(opts.author)}`)
	if (params.length) url.search = params.join('&')
	const res = await f(url.toString())
	if (!res.ok) throw new Error(await errorMessage(res, `timeline ${res.status}`))
	const body = (await res.json()) as { timeline: TimelineEntry[]; nextCursor?: string | null }
	return { timeline: body.timeline, nextCursor: body.nextCursor ?? null }
}

export async function getFollowing(f: typeof fetch, handle: string): Promise<TimelineEntry['author'][]> {
	const res = await f(`${base()}/users/${encodeURIComponent(handle)}/follows`)
	if (!res.ok) throw new Error(await errorMessage(res, `following ${res.status}`))
	return (await res.json()).following
}

export async function addFollow(f: typeof fetch, handle: string, target: string): Promise<void> {
	const res = await f(`${base()}/users/${encodeURIComponent(handle)}/follows`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
		body: JSON.stringify({ handle: target })
	})
	if (!res.ok) throw new Error(await errorMessage(res, `addFollow ${res.status}`))
}

export async function removeFollow(f: typeof fetch, handle: string, target: string): Promise<void> {
	const res = await f(`${base()}/users/${encodeURIComponent(handle)}/follows/${encodeURIComponent(target)}`, {
		method: 'DELETE',
		headers: { authorization: `Bearer ${token()}` }
	})
	if (!res.ok) throw new Error(await errorMessage(res, `removeFollow ${res.status}`))
}

export async function importOpml(f: typeof fetch, handle: string, opml: string): Promise<{ followed: number; created: number; skipped: number }> {
	const res = await f(`${base()}/users/${encodeURIComponent(handle)}/follows/opml`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token()}` },
		body: opml
	})
	if (!res.ok) throw new Error(await errorMessage(res, `importOpml ${res.status}`))
	return res.json()
}

export async function createPost(
	f: typeof fetch,
	input: { handle: string; displayName: string; content: string; inReplyTo?: string }
): Promise<void> {
	const res = await f(`${base()}/posts`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
		body: JSON.stringify(input)
	})
	if (!res.ok) throw new Error(await errorMessage(res, `createPost ${res.status}`))
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
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
		body: JSON.stringify(input)
	})
	if (!res.ok) throw new Error(await errorMessage(res, `addRemoteUser ${res.status}`))
}
