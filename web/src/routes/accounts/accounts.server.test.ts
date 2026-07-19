import { test, expect, vi } from 'vitest'
import { load, actions } from './+page.server.ts'

function ctx(over: Record<string, unknown> = {}) {
  return {
    fetch: vi.fn(),
    cookies: { getAll: () => [{ name: 'textcaster.session_token', value: 's' }], set: vi.fn(), delete: vi.fn() },
    url: new URL('http://x/accounts'),
    getClientAddress: () => '203.0.113.1',
    parent: async () => ({ me: { user: { handle: 'admin' }, isAnonymous: false } }),
    ...over,
  }
}

test('load redirects a guest/anon to / (M4)', async () => {
  const event = ctx({ parent: async () => ({ me: { user: { handle: 'g' }, isAnonymous: true } }) })
  await expect(load(event as never)).rejects.toMatchObject({ status: 303, location: '/' })
})

test('load redirects when signed out entirely', async () => {
  const event = ctx({ parent: async () => ({ me: null }) })
  await expect(load(event as never)).rejects.toMatchObject({ status: 303, location: '/' })
})

test('load lists registered accounts, filters the guest, marks active (M1/M8)', async () => {
  const list = [
    { session: { token: 't1' }, user: { id: 'u1', email: 'admin@x', name: 'admin@x' } },
    { session: { token: 't2' }, user: { id: 'u2', email: 'me@x', name: 'me@x' } },
    { session: { token: 'tg' }, user: { id: 'ug', email: 'guest', name: 'guest', isAnonymous: true } },
  ]
  const fetch = vi.fn(async (url: string) =>
    url.includes('get-session')
      ? new Response(JSON.stringify({ user: { id: 'u2' } }), { status: 200 })
      : new Response(JSON.stringify(list), { status: 200 })
  )
  const out = await load(ctx({ fetch }) as never)
  expect(out.accounts).toEqual([
    { id: 'u1', email: 'admin@x', active: false },
    { id: 'u2', email: 'me@x', active: true },
  ])
})

test('switch resolves the opaque id → token server-side and relays cookies (M5)', async () => {
  const list = [{ session: { token: 't1' }, user: { id: 'u1', email: 'a@x', name: 'a@x' } }]
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('list-device-sessions')) return new Response(JSON.stringify(list), { status: 200 })
    if (url.includes('set-active')) {
      expect(JSON.parse(String(init?.body))).toEqual({ sessionToken: 't1' }) // token resolved server-side, not from the form
      return new Response('{}', { status: 200, headers: { 'set-cookie': 'textcaster.session_token=t1; Path=/; HttpOnly' } })
    }
    throw new Error(`unexpected ${url}`)
  })
  const cookies = { getAll: () => [{ name: 'textcaster.session_token', value: 's' }], set: vi.fn(), delete: vi.fn() }
  const form = new URLSearchParams({ id: 'u1' })
  const event = ctx({ fetch, cookies, request: new Request('http://x/accounts?/switch', { method: 'POST', body: form }) })
  await expect(actions.switch(event as never)).rejects.toMatchObject({ status: 303, location: '/accounts' })
  expect(cookies.set).toHaveBeenCalledWith('textcaster.session_token', 't1', expect.objectContaining({ path: '/' }))
})

test('logoutOne switches to another registered account THEN revokes the old (M2 order)', async () => {
  const list = [
    { session: { token: 'tActive' }, user: { id: 'u1', email: 'a@x', name: 'a@x' } },
    { session: { token: 'tOther' }, user: { id: 'u2', email: 'b@x', name: 'b@x' } },
  ]
  const calls: string[] = []
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('get-session')) return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 })
    if (url.includes('list-device-sessions')) return new Response(JSON.stringify(list), { status: 200 })
    if (url.includes('set-active')) { calls.push('set-active'); return new Response('{}', { status: 200 }) }
    if (url.includes('revoke')) { calls.push('revoke'); return new Response('{}', { status: 200 }) }
    throw new Error(`unexpected ${url}`)
  })
  const event = ctx({ fetch, request: new Request('http://x/accounts?/logoutOne', { method: 'POST', body: new URLSearchParams() }) })
  await expect(actions.logoutOne(event as never)).rejects.toMatchObject({ status: 303 })
  expect(calls).toEqual(['set-active', 'revoke']) // order is load-bearing (M2)
})

test('logoutOne with no OTHER registered account signs out ALL, never revoke(active) (R1)', async () => {
  const list = [
    { session: { token: 'tActive' }, user: { id: 'u1', email: 'a@x', name: 'a@x' } },
    { session: { token: 'tg' }, user: { id: 'ug', email: 'guest', name: 'guest', isAnonymous: true } },
  ]
  const calls: string[] = []
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('get-session')) return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 })
    if (url.includes('list-device-sessions')) return new Response(JSON.stringify(list), { status: 200 })
    if (url.includes('sign-out')) { calls.push('sign-out'); return new Response('{}', { status: 200 }) }
    if (url.includes('revoke')) { calls.push('revoke'); return new Response('{}', { status: 200 }) }
    throw new Error(`unexpected ${url}`)
  })
  const event = ctx({ fetch, request: new Request('http://x/accounts?/logoutOne', { method: 'POST', body: new URLSearchParams() }) })
  await expect(actions.logoutOne(event as never)).rejects.toMatchObject({ status: 303, location: '/' })
  expect(calls).toEqual(['sign-out']) // R1: only registered account left → signOut, NOT revoke(active)
})
