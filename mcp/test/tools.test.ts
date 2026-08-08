import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadConfig, resolveKey, renderItem, renderTimeline, renderThread, rscFetch } from '../src/tools.ts'
import { toolHandlers, buildServer, schemas } from '../src/tools.ts'
import type { RscItem } from '../src/tools.ts'

describe('loadConfig', () => {
  it('parses url and identities', () => {
    const cfg = loadConfig({ RSC_API_URL: 'https://rsc.example', RSC_IDENTITIES: 'me:k1,claude:k2' })
    expect(cfg.apiUrl).toBe('https://rsc.example')
    expect([...cfg.identities.entries()]).toEqual([['me', 'k1'], ['claude', 'k2']])
  })

  it('strips a trailing slash from the url', () => {
    expect(loadConfig({ RSC_API_URL: 'https://rsc.example/', RSC_IDENTITIES: 'me:k1' }).apiUrl).toBe('https://rsc.example')
  })

  it('throws when RSC_API_URL is missing', () => {
    expect(() => loadConfig({ RSC_IDENTITIES: 'me:k1' })).toThrow(/RSC_API_URL/)
  })

  it('allows no identities at all (keyless reads still work)', () => {
    expect(loadConfig({ RSC_API_URL: 'https://rsc.example' }).identities.size).toBe(0)
  })

  it('throws on a malformed identity pair', () => {
    expect(() => loadConfig({ RSC_API_URL: 'https://rsc.example', RSC_IDENTITIES: 'oops' })).toThrow(/RSC_IDENTITIES/)
  })
})

describe('resolveKey', () => {
  const one = loadConfig({ RSC_API_URL: 'https://rsc.example', RSC_IDENTITIES: 'me:k1' })
  const two = loadConfig({ RSC_API_URL: 'https://rsc.example', RSC_IDENTITIES: 'me:k1,claude:k2' })

  it('uses the only identity when as is omitted', () => {
    expect(resolveKey(one, undefined)).toEqual({ key: 'k1' })
  })

  it('requires as when several are configured', () => {
    const r = resolveKey(two, undefined)
    expect(r).toHaveProperty('error')
    expect((r as { error: string }).error).toMatch(/me, claude/)
  })

  it('resolves a named identity', () => {
    expect(resolveKey(two, 'claude')).toEqual({ key: 'k2' })
  })

  it('errors on an unknown name and does NOT fall back', () => {
    const r = resolveKey(two, 'nobody')
    expect(r).toHaveProperty('error')
    expect(r).not.toHaveProperty('key')
    expect((r as { error: string }).error).toMatch(/me, claude/)
  })

  it('never leaks a key in an error message', () => {
    const r = resolveKey(two, 'nobody') as { error: string }
    expect(r.error).not.toContain('k1')
    expect(r.error).not.toContain('k2')
  })

  it('errors when no identity is configured', () => {
    const none = loadConfig({ RSC_API_URL: 'https://rsc.example' })
    expect(resolveKey(none, undefined)).toHaveProperty('error')
  })
})

const localItem: RscItem = {
  id: 'li_1',
  origin: 'local',
  selectedAuthor: { handle: 'rmdes', displayName: 'Ricardo' },
  content: '<p>hello</p>',
  contentMarkdown: 'hello',
  permalink: 'https://rsc.example/post/li_1',
  publishedAt: '2026-08-07T09:14:00.000Z',
  directReplyCount: 2
}

const remoteNoMarkdown: RscItem = {
  id: 'li_2',
  origin: 'remote',
  selectedAuthor: { handle: 'someone', displayName: 'Some One' },
  content: '<p>from a feed</p>',
  contentMarkdown: null,
  permalink: 'https://elsewhere.example/p/2',
  publishedAt: '2026-08-07T10:00:00.000Z',
  directReplyCount: 0
}

describe('renderItem', () => {
  it('labels origin and handle, and prefers contentMarkdown', () => {
    const out = renderItem(localItem)
    expect(out).toContain('[local]')
    expect(out).toContain('@rmdes')
    expect(out).toContain('id=li_1')
    expect(out).toContain('hello')
    expect(out).not.toContain('<p>')
  })

  it('falls back to content when contentMarkdown is null', () => {
    const out = renderItem(remoteNoMarkdown)
    expect(out).toContain('[remote]')
    expect(out).toContain('from a feed')
  })

  it('shows a reply count only when there are replies', () => {
    expect(renderItem(localItem)).toContain('2 replies')
    expect(renderItem(remoteNoMarkdown)).not.toContain('replies')
  })

  it('tolerates a null author handle', () => {
    const anon = { ...localItem, selectedAuthor: null }
    expect(() => renderItem(anon)).not.toThrow()
    expect(renderItem(anon)).toContain('[local]')
  })

  it('fences the raw-HTML fallback so it cannot render as markup', () => {
    const out = renderItem(remoteNoMarkdown)
    expect(out).toContain('```html')
    expect(out).toContain('from a feed')
    // the tag is present as literal text inside the fence, not as loose markup
    const fenced = out.slice(out.indexOf('```html'))
    expect(fenced).toContain('<p>from a feed</p>')
  })

  it('widens the fence when the feed content contains backticks', () => {
    const tricky = { ...remoteNoMarkdown, content: '<p>```html\nescape attempt\n```</p>' }
    const out = renderItem(tricky)
    const opening = out.slice(out.indexOf('`')).match(/^`+/)![0]
    expect(opening.length).toBeGreaterThan(3)
    // every backtick run inside the content is shorter than the fence
    expect(out).toContain('escape attempt')
  })

  it('still prefers contentMarkdown and never fences it', () => {
    expect(renderItem(localItem)).not.toContain('```html')
  })
})

describe('renderTimeline', () => {
  it('renders every entry and reports the cursor', () => {
    const out = renderTimeline({ timeline: [localItem, remoteNoMarkdown], nextCursor: 'cur_9' })
    expect(out).toContain('@rmdes')
    expect(out).toContain('@someone')
    expect(out).toContain('cur_9')
  })

  it('says so when the timeline is empty', () => {
    expect(renderTimeline({ timeline: [], nextCursor: null })).toMatch(/no entries/i)
  })

  it('omits the cursor line when there is no next page', () => {
    expect(renderTimeline({ timeline: [localItem], nextCursor: null })).not.toMatch(/before=/)
  })
})

describe('renderThread', () => {
  it('renders items and keeps placeholders visible', () => {
    const out = renderThread({
      requestedLogicalItemId: 'li_1',
      rootId: 'li_0',
      nodes: [
        { kind: 'placeholder', logicalItemId: 'li_0', parentLogicalItemId: null, timelineSortAt: '2026-08-07T08:00:00.000Z', placeholderKind: 'unavailable' },
        { kind: 'item', item: localItem }
      ],
      truncated: { depth: false, nodes: false, cycle: false }
    })
    expect(out).toContain('unavailable')
    expect(out).toContain('li_0')
    expect(out).toContain('@rmdes')
  })

  it('warns when the thread was truncated', () => {
    const out = renderThread({
      requestedLogicalItemId: 'li_1',
      rootId: 'li_1',
      nodes: [{ kind: 'item', item: localItem }],
      truncated: { depth: false, nodes: true, cycle: false }
    })
    expect(out).toMatch(/truncated/i)
  })
})

const cfg2 = loadConfig({ RSC_API_URL: 'https://rsc.example', RSC_IDENTITIES: 'me:k1,claude:k2' })

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => vi.unstubAllGlobals())

describe('rscFetch', () => {
  it('prefixes /api/v1 and sends no key when none is given', async () => {
    const spy = stubFetch(200, { ok: true })
    await rscFetch(cfg2, '/post/li_1/thread')
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://rsc.example/api/v1/post/li_1/thread')
    expect(new Headers(init.headers).has('x-api-key')).toBe(false)
  })

  it('sends x-api-key when a key is given', async () => {
    const spy = stubFetch(200, { ok: true })
    await rscFetch(cfg2, '/me/timeline', { key: 'k2' })
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get('x-api-key')).toBe('k2')
  })

  it('passes core error messages through verbatim', async () => {
    stubFetch(400, { error: 'content invalid' })
    const r = await rscFetch(cfg2, '/me/posts', { method: 'POST', body: { content: '' }, key: 'k1' })
    expect(r).toEqual({ ok: false, message: expect.stringContaining('content invalid') })
  })

  it('names the identity on a 401 without leaking the key', async () => {
    stubFetch(401, { error: 'unauthorized' })
    const r = await rscFetch(cfg2, '/me/timeline', { key: 'k2', identityName: 'claude' }) as { ok: false; message: string }
    expect(r.message).toContain('claude')
    expect(r.message).toContain('RSC_IDENTITIES')
    expect(r.message).not.toContain('k2')
  })

  it('explains a 429 as the per-key hourly limit', async () => {
    stubFetch(429, { error: 'rate limited' })
    const r = await rscFetch(cfg2, '/me/timeline', { key: 'k1' }) as { ok: false; message: string }
    expect(r.message).toMatch(/300/)
  })

  it('reports an unreachable instance on 503', async () => {
    stubFetch(503, {})
    const r = await rscFetch(cfg2, '/me/timeline', { key: 'k1' }) as { ok: false; message: string }
    expect(r.message).toMatch(/unreachable|unavailable/i)
  })

  it('reports a network failure instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const r = await rscFetch(cfg2, '/me/timeline', { key: 'k1' })
    expect(r.ok).toBe(false)
  })

  it('issues exactly ONE request when the server 500s on a write', async () => {
    const spy = stubFetch(500, { error: 'boom' })
    await rscFetch(cfg2, '/me/posts', { method: 'POST', body: { content: 'hi' }, key: 'k1' })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

const cfgOne = loadConfig({ RSC_API_URL: 'https://rsc.example', RSC_IDENTITIES: 'me:k1' })
const cfgTwo = loadConfig({ RSC_API_URL: 'https://rsc.example', RSC_IDENTITIES: 'me:k1,claude:k2' })

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => c.text ?? '').join('')
}

describe('rsc_timeline', () => {
  it('sends the key and renders entries', async () => {
    const spy = stubFetch(200, { timeline: [localItem], nextCursor: null })
    const r = await toolHandlers.timeline({}, cfgOne)
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/v1/me/timeline')
    expect(new Headers(init.headers).get('x-api-key')).toBe('k1')
    expect(textOf(r)).toContain('@rmdes')
    expect(r.isError).toBeUndefined()
  })

  it('passes limit and before through as query params', async () => {
    const spy = stubFetch(200, { timeline: [], nextCursor: null })
    await toolHandlers.timeline({ limit: 10, before: 'cur_1' }, cfgOne)
    const [url] = spy.mock.calls[0] as unknown as [string]
    expect(url).toContain('limit=10')
    expect(url).toContain('before=cur_1')
  })

  it('reports an error result rather than throwing', async () => {
    stubFetch(401, { error: 'unauthorized' })
    const r = await toolHandlers.timeline({}, cfgOne)
    expect(r.isError).toBe(true)
  })

  it('requires as when several identities are configured', async () => {
    const spy = stubFetch(200, { timeline: [], nextCursor: null })
    const r = await toolHandlers.timeline({}, cfgTwo)
    expect(r.isError).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('reads the named identity timeline', async () => {
    const spy = stubFetch(200, { timeline: [], nextCursor: null })
    await toolHandlers.timeline({ as: 'claude' }, cfgTwo)
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get('x-api-key')).toBe('k2')
  })
})

describe('rsc_thread', () => {
  it('sends NO key', async () => {
    const spy = stubFetch(200, { requestedLogicalItemId: 'li_1', rootId: 'li_1', nodes: [{ kind: 'item', item: localItem }], truncated: { depth: false, nodes: false, cycle: false } })
    await toolHandlers.thread({ postId: 'li_1' }, cfgOne)
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://rsc.example/api/v1/post/li_1/thread')
    expect(new Headers(init.headers).has('x-api-key')).toBe(false)
  })

  it('percent-encodes the post id', async () => {
    const spy = stubFetch(200, { requestedLogicalItemId: 'a/b', rootId: null, nodes: [], truncated: { depth: false, nodes: false, cycle: false } })
    await toolHandlers.thread({ postId: 'a/b' }, cfgOne)
    const [url] = spy.mock.calls[0] as unknown as [string]
    expect(url).toContain('a%2Fb')
  })

  it('surfaces a 404 as a recoverable error', async () => {
    stubFetch(404, { error: 'not found' })
    const r = await toolHandlers.thread({ postId: 'nope' }, cfgOne)
    expect(r.isError).toBe(true)
  })
})

describe('rsc_post', () => {
  it('posts as the only identity and reports the new id', async () => {
    const spy = stubFetch(201, { post: { id: 'p_1', url: 'https://rsc.example/post/p_1' } })
    const r = await toolHandlers.post({ content: 'hello' }, cfgOne)
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://rsc.example/api/v1/me/posts')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ content: 'hello' })
    expect(new Headers(init.headers).get('x-api-key')).toBe('k1')
    expect(textOf(r)).toContain('p_1')
    expect(r.isError).toBeUndefined()
  })

  it('includes inReplyTo when replying', async () => {
    const spy = stubFetch(201, { post: { id: 'p_2', url: null } })
    await toolHandlers.post({ content: 'a reply', inReplyTo: 'li_1' }, cfgOne)
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ content: 'a reply', inReplyTo: 'li_1' })
  })

  it('refuses to guess an identity when several are configured', async () => {
    const spy = stubFetch(201, { post: { id: 'p_3', url: null } })
    const r = await toolHandlers.post({ content: 'hi' }, cfgTwo)
    expect(r.isError).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('uses the named identity', async () => {
    const spy = stubFetch(201, { post: { id: 'p_4', url: null } })
    await toolHandlers.post({ content: 'hi', as: 'claude' }, cfgTwo)
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get('x-api-key')).toBe('k2')
  })

  it('rejects an unknown identity WITHOUT sending anything', async () => {
    const spy = stubFetch(201, { post: { id: 'p_5', url: null } })
    const r = await toolHandlers.post({ content: 'hi', as: 'nobody' }, cfgTwo)
    expect(r.isError).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('names the reply target when it does not resolve', async () => {
    stubFetch(404, { error: 'unknown post' })
    const r = await toolHandlers.post({ content: 'hi', inReplyTo: 'ghost' }, cfgOne)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('ghost')
  })
})

describe('tool schemas', () => {
  it('exposes exactly the three tools', () => {
    expect(Object.keys(schemas).sort()).toEqual(['rsc_post', 'rsc_thread', 'rsc_timeline'])
  })

  it('builds a server without throwing', () => {
    expect(() => buildServer(cfgOne)).not.toThrow()
  })

  // These bounds are transcribed from core/src/api/logical-routes/personal.ts
  // (:111 content 1..100000, :112 inReplyTo 1..64). Asserting them here means
  // a drift from core's validator fails locally instead of as a 400 at runtime.
  it('rejects empty content and accepts a real post', () => {
    expect(schemas.rsc_post.safeParse({ content: '' }).success).toBe(false)
    expect(schemas.rsc_post.safeParse({ content: 'hi' }).success).toBe(true)
  })

  it('rejects content over 100000 chars', () => {
    expect(schemas.rsc_post.safeParse({ content: 'x'.repeat(100001) }).success).toBe(false)
    expect(schemas.rsc_post.safeParse({ content: 'x'.repeat(100000) }).success).toBe(true)
  })

  it('rejects an inReplyTo over 64 chars', () => {
    expect(schemas.rsc_post.safeParse({ content: 'hi', inReplyTo: 'x'.repeat(65) }).success).toBe(false)
    expect(schemas.rsc_post.safeParse({ content: 'hi', inReplyTo: 'x'.repeat(64) }).success).toBe(true)
  })

  it('clamps timeline limit to 1..100', () => {
    expect(schemas.rsc_timeline.safeParse({ limit: 0 }).success).toBe(false)
    expect(schemas.rsc_timeline.safeParse({ limit: 101 }).success).toBe(false)
    expect(schemas.rsc_timeline.safeParse({ limit: 50 }).success).toBe(true)
    expect(schemas.rsc_timeline.safeParse({}).success).toBe(true)
  })

  it('requires a postId for thread', () => {
    expect(schemas.rsc_thread.safeParse({}).success).toBe(false)
    expect(schemas.rsc_thread.safeParse({ postId: 'li_1' }).success).toBe(true)
  })
})
