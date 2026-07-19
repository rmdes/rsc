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

test('proxy still forwards a normal auth path to core', async () => {
  const upstream = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', upstream)
  const res = await GET(event('sign-in/email') as never)
  expect(upstream).toHaveBeenCalledOnce()
  expect(res.status).toBe(200)
})
