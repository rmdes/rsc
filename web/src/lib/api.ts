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

export async function getTimeline(f: typeof fetch, before?: string): Promise<TimelinePage> {
	const url = new URL(`${base()}/timeline`)
	if (before) url.search = `before=${encodeURIComponent(before)}`
	const res = await f(url.toString())
	if (!res.ok) throw new Error(await errorMessage(res, `timeline ${res.status}`))
	const body = (await res.json()) as { timeline: TimelineEntry[]; nextCursor?: string | null }
	return { timeline: body.timeline, nextCursor: body.nextCursor ?? null }
}

export async function createPost(
	f: typeof fetch,
	input: { handle: string; displayName: string; content: string }
): Promise<void> {
	const res = await f(`${base()}/posts`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
		body: JSON.stringify(input)
	})
	if (!res.ok) throw new Error(await errorMessage(res, `createPost ${res.status}`))
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
