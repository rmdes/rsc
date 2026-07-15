import { test, expect, vi } from 'vitest'
import { getTimeline, createPost, addRemoteUser } from './api.ts'

const entry = {
	id: 'p1',
	title: null,
	content: 'hi',
	url: null,
	publishedAt: '',
	source: 'local',
	author: { handle: 'a', displayName: 'A', kind: 'local' }
}

test('getTimeline returns entries and the next cursor', async () => {
	const f = vi.fn(
		async () => new Response(JSON.stringify({ timeline: [entry], nextCursor: '2026~p1' }), { status: 200 })
	)
	const page = await getTimeline(f as unknown as typeof fetch)
	expect(page.timeline[0].content).toBe('hi')
	expect(page.nextCursor).toBe('2026~p1')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/timeline')
})

test('getTimeline passes the before cursor as a query param and defaults nextCursor to null', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ timeline: [] }), { status: 200 }))
	const page = await getTimeline(f as unknown as typeof fetch, '2026-01-01T00:00:00.000Z~p9')
	expect(f).toHaveBeenCalledWith('http://localhost:8787/timeline?before=2026-01-01T00%3A00%3A00.000Z~p9')
	expect(page.nextCursor).toBeNull()
})

test('createPost sends the bearer token', async () => {
	const f = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 201 }))
	await createPost(f as unknown as typeof fetch, { handle: 'a', displayName: 'A', content: 'x' })
	const init = f.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer /)
})

test('addRemoteUser sends the bearer token', async () => {
	const f = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 201 }))
	await addRemoteUser(f as unknown as typeof fetch, { handle: 'a', displayName: 'A', feedUrl: 'https://x/f' })
	const init = f.mock.calls[0][1] as RequestInit
	expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer /)
})

test('createPost surfaces the core error message', async () => {
	const f = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid handle' }), { status: 400 }))
	await expect(createPost(f as unknown as typeof fetch, { handle: '!', displayName: '!', content: 'x' })).rejects.toThrow(
		'invalid handle'
	)
})

test('addRemoteUser falls back to a status message when the body has no error field', async () => {
	const f = vi.fn(async () => new Response('nope', { status: 502 }))
	await expect(
		addRemoteUser(f as unknown as typeof fetch, { handle: 'a', displayName: 'A', feedUrl: 'https://x/f' })
	).rejects.toThrow('addRemoteUser 502')
})
