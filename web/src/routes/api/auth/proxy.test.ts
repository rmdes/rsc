import { test, expect, vi, afterEach } from 'vitest'
import { GET } from './[...path]/+server.ts'

function event(path: string) {
  return {
    request: new Request(`http://x/api/auth/${path}`),
    params: { path },
    url: new URL(`http://x/api/auth/${path}`),
    cookies: { getAll: () => [], set: vi.fn(), delete: vi.fn() },
    getClientAddress: () => '203.0.113.1',
  }
}

afterEach(() => vi.unstubAllGlobals())

test('proxy hard-404s the openAPI reference + schema without reaching core', async () => {
  const upstream = vi.fn(async () => new Response('should not be called', { status: 200 }))
  vi.stubGlobal('fetch', upstream)
  for (const p of ['reference', 'open-api/generate-schema']) {
    const res = await GET(event(p) as never)
    expect(res.status).toBe(404)
  }
  expect(upstream).not.toHaveBeenCalled()
})

// Both guards below match the RESOLVED upstream path, not the raw segment:
// SvelteKit hands `params.path` already percent-decoded, so `..%2f` arrives as
// a real `../` that a string match reads straight past — and Node's fetch then
// normalizes it away when resolving the URL, landing on a path nobody checked.
// Live-confirmed on the dev stack before the fix (137KB Scalar UI, and core's
// /admin/overview answering 401 through a proxy that only fronts /api/auth).
test('traversal cannot reach the openAPI reference the plain guard misses', async () => {
  const upstream = vi.fn(async () => new Response('should not be called', { status: 200 }))
  vi.stubGlobal('fetch', upstream)
  for (const p of ['../auth/reference', '../auth/open-api/generate-schema']) {
    expect((await GET(event(p) as never)).status).toBe(404)
  }
  expect(upstream).not.toHaveBeenCalled()
})

test('traversal cannot escape /api/auth/ into core at large (perimeter invariant)', async () => {
  const upstream = vi.fn(async () => new Response('should not be called', { status: 200 }))
  vi.stubGlobal('fetch', upstream)
  for (const p of ['../../health', '../../admin/overview', '../../users/rss.xml']) {
    expect((await GET(event(p) as never)).status).toBe(404)
  }
  expect(upstream).not.toHaveBeenCalled()
})

// M2 (security audit): a leading slash on params.path produces a doubled
// slash in target.pathname ('/api/auth//reference'), which still starts
// with '/api/auth/' but no longer equals '/api/auth/reference' — the
// exact-match guard on the reference page misses it. Not currently
// exploitable (core's own router doesn't collapse `//` either) but the
// guard itself must hold the property it claims to.
test('doubled slash in the path does not bypass the reference guard', async () => {
  const upstream = vi.fn(async () => new Response('should not be called', { status: 200 }))
  vi.stubGlobal('fetch', upstream)
  const res = await GET(event('/reference') as never)
  expect(res.status).toBe(404)
  expect(upstream).not.toHaveBeenCalled()
})

test('proxy still forwards a normal auth path to core', async () => {
  const upstream = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', upstream)
  const res = await GET(event('sign-in/email') as never)
  expect(upstream).toHaveBeenCalledOnce()
  expect(res.status).toBe(200)
})
