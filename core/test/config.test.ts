import { test, expect } from 'vitest'
import { loadConfig } from '../src/config.ts'

test('requires a token', () => {
  expect(() => loadConfig({})).toThrow('RSC_TOKEN')
})
test('applies defaults', () => {
  const c = loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' })
  expect(c.port).toBe(8787)
  expect(c.pollSeconds).toBe(60)
})
test('rejects a non-numeric port', () => {
  expect(() => loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PORT: 'abc' })).toThrow('RSC_PORT')
})
test('rejects a non-numeric poll interval', () => {
  expect(() => loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_POLL_SECONDS: 'soon' })).toThrow('RSC_POLL_SECONDS')
})
test('push defaults off and publicUrl defaults null', () => {
  const c = loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' })
  expect(c.websub).toEqual({ mode: 'off' })
  expect(c.rssCloud).toBe(false)
  expect(c.publicUrl).toBeNull()
})
test('publicUrl is normalized and must be http(s)', () => {
  const c = loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://cast.example.com/' })
  expect(c.publicUrl).toBe('https://cast.example.com')
  expect(() => loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'ftp://x' })).toThrow('RSC_PUBLIC_URL')
})
test('websub modes parse: self, external URL, garbage rejected', () => {
  const base = { RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://cast.example.com' }
  expect(loadConfig({ ...base, RSC_WEBSUB: 'self' }).websub).toEqual({ mode: 'self' })
  expect(loadConfig({ ...base, RSC_WEBSUB: 'https://websubhub.com/hub' }).websub).toEqual({ mode: 'external', hubUrl: 'https://websubhub.com/hub' })
  expect(() => loadConfig({ ...base, RSC_WEBSUB: 'not a url' })).toThrow('RSC_WEBSUB')
})
test('explicitly enabled push without publicUrl fails fast', () => {
  expect(() => loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_WEBSUB: 'self' })).toThrow('RSC_PUBLIC_URL')
  expect(() => loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_RSSCLOUD: 'on' })).toThrow('RSC_PUBLIC_URL')
})
test('rssCloud accepts only on/off', () => {
  const base = { RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUBLIC_URL: 'https://cast.example.com' }
  expect(loadConfig({ ...base, RSC_RSSCLOUD: 'on' }).rssCloud).toBe(true)
  expect(() => loadConfig({ ...base, RSC_RSSCLOUD: 'yes' })).toThrow('RSC_RSSCLOUD')
})
test('pushIn defaults on, accepts off, rejects garbage', () => {
  expect(loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' }).pushIn).toBe(true)
  expect(loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUSH_IN: 'off' }).pushIn).toBe(false)
  expect(() => loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUSH_IN: 'maybe' })).toThrow('RSC_PUSH_IN')
})
test('pushIn on without publicUrl is NOT a startup error (dormant, not fatal)', () => {
  expect(() => loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_PUSH_IN: 'on' })).not.toThrow()
})
test('RSC_AUTH_SECRET is required', () => {
  expect(() => loadConfig({ RSC_TOKEN: 't' })).toThrow(/RSC_AUTH_SECRET/)
})

test('auth env defaults: webOrigin and anonTtlDays', () => {
  const c = loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' })
  expect(c.webOrigin).toBe('http://localhost:5173')
  expect(c.anonTtlDays).toBe(7)
  const c2 = loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_WEB_ORIGIN: 'https://tc.example', RSC_ANON_TTL_DAYS: '30' })
  expect(c2.webOrigin).toBe('https://tc.example')
  expect(c2.anonTtlDays).toBe(30)
})

test('mail config: absent SMTP url disables mail; present enables it', () => {
  const c = loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' })
  expect(c.smtpUrl).toBeNull()
  expect(c.mailEnabled).toBe(false)
  expect(c.mailFrom).toMatch(/@/) // has a sane default
  const c2 = loadConfig({ RSC_TOKEN: 't', RSC_AUTH_SECRET: 's', RSC_SMTP_URL: 'smtp://localhost:1025', RSC_MAIL_FROM: 'hi@ex.test' })
  expect(c2.smtpUrl).toBe('smtp://localhost:1025')
  expect(c2.mailEnabled).toBe(true)
  expect(c2.mailFrom).toBe('hi@ex.test')
})

test('authOpenApi defaults off, accepts on, rejects garbage', () => {
  const base = { RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' }
  expect(loadConfig(base).authOpenApi).toBe(false)
  expect(loadConfig({ ...base, RSC_AUTH_OPENAPI: 'on' }).authOpenApi).toBe(true)
  expect(loadConfig({ ...base, RSC_AUTH_OPENAPI: 'off' }).authOpenApi).toBe(false)
  expect(() => loadConfig({ ...base, RSC_AUTH_OPENAPI: 'maybe' })).toThrow('RSC_AUTH_OPENAPI')
})

test('RSC_SOURCE_MODEL_V2 defaults off and accepts only on/off', () => {
  const base = { RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' }
  expect(loadConfig(base).sourceModelV2).toBe(false)
  expect(loadConfig({ ...base, RSC_SOURCE_MODEL_V2: 'on' }).sourceModelV2).toBe(true)
  expect(() => loadConfig({ ...base, RSC_SOURCE_MODEL_V2: 'yes' })).toThrow('RSC_SOURCE_MODEL_V2')
})
