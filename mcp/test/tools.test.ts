import { describe, it, expect } from 'vitest'
import { loadConfig, resolveKey } from '../src/tools.ts'

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
