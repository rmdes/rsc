import { env } from '$env/dynamic/private'
import type { TimelineEntry } from './types.ts'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'
const token = () => env.CORE_API_TOKEN ?? ''

export async function getTimeline(f: typeof fetch): Promise<TimelineEntry[]> {
	const res = await f(`${base()}/timeline`)
	if (!res.ok) throw new Error(`timeline ${res.status}`)
	return (await res.json()).timeline
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
	if (!res.ok) throw new Error(`createPost ${res.status}`)
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
	if (!res.ok) throw new Error(`addRemoteUser ${res.status}`)
}
