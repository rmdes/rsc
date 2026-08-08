import { describe, it, expect } from 'vitest'
import { loadConfig, resolveKey, renderItem, renderTimeline, renderThread } from '../src/tools.ts'
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
