import { test, expect } from 'vitest'
import { loadConfig } from '../src/config.ts'

test('requires a token', () => {
  expect(() => loadConfig({})).toThrow('TEXTCASTER_TOKEN')
})
test('applies defaults', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's' })
  expect(c.port).toBe(8787)
  expect(c.pollSeconds).toBe(60)
})
test('rejects a non-numeric port', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_PORT: 'abc' })).toThrow('TEXTCASTER_PORT')
})
test('rejects a non-numeric poll interval', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_POLL_SECONDS: 'soon' })).toThrow('TEXTCASTER_POLL_SECONDS')
})
test('push defaults off and publicUrl defaults null', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's' })
  expect(c.websub).toEqual({ mode: 'off' })
  expect(c.rssCloud).toBe(false)
  expect(c.publicUrl).toBeNull()
})
test('publicUrl is normalized and must be http(s)', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com/' })
  expect(c.publicUrl).toBe('https://cast.example.com')
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_PUBLIC_URL: 'ftp://x' })).toThrow('TEXTCASTER_PUBLIC_URL')
})
test('websub modes parse: self, external URL, garbage rejected', () => {
  const base = { TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com' }
  expect(loadConfig({ ...base, TEXTCASTER_WEBSUB: 'self' }).websub).toEqual({ mode: 'self' })
  expect(loadConfig({ ...base, TEXTCASTER_WEBSUB: 'https://websubhub.com/hub' }).websub).toEqual({ mode: 'external', hubUrl: 'https://websubhub.com/hub' })
  expect(() => loadConfig({ ...base, TEXTCASTER_WEBSUB: 'not a url' })).toThrow('TEXTCASTER_WEBSUB')
})
test('explicitly enabled push without publicUrl fails fast', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_WEBSUB: 'self' })).toThrow('TEXTCASTER_PUBLIC_URL')
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_RSSCLOUD: 'on' })).toThrow('TEXTCASTER_PUBLIC_URL')
})
test('rssCloud accepts only on/off', () => {
  const base = { TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com' }
  expect(loadConfig({ ...base, TEXTCASTER_RSSCLOUD: 'on' }).rssCloud).toBe(true)
  expect(() => loadConfig({ ...base, TEXTCASTER_RSSCLOUD: 'yes' })).toThrow('TEXTCASTER_RSSCLOUD')
})
test('pushIn defaults on, accepts off, rejects garbage', () => {
  expect(loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's' }).pushIn).toBe(true)
  expect(loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_PUSH_IN: 'off' }).pushIn).toBe(false)
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_PUSH_IN: 'maybe' })).toThrow('TEXTCASTER_PUSH_IN')
})
test('pushIn on without publicUrl is NOT a startup error (dormant, not fatal)', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_PUSH_IN: 'on' })).not.toThrow()
})
test('TEXTCASTER_AUTH_SECRET is required', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't' })).toThrow(/TEXTCASTER_AUTH_SECRET/)
})

test('auth env defaults: webOrigin and anonTtlDays', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's' })
  expect(c.webOrigin).toBe('http://localhost:5173')
  expect(c.anonTtlDays).toBe(7)
  const c2 = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_WEB_ORIGIN: 'https://tc.example', TEXTCASTER_ANON_TTL_DAYS: '30' })
  expect(c2.webOrigin).toBe('https://tc.example')
  expect(c2.anonTtlDays).toBe(30)
})

test('mail config: absent SMTP url disables mail; present enables it', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's' })
  expect(c.smtpUrl).toBeNull()
  expect(c.mailEnabled).toBe(false)
  expect(c.mailFrom).toMatch(/@/) // has a sane default
  const c2 = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's', TEXTCASTER_SMTP_URL: 'smtp://localhost:1025', TEXTCASTER_MAIL_FROM: 'hi@ex.test' })
  expect(c2.smtpUrl).toBe('smtp://localhost:1025')
  expect(c2.mailEnabled).toBe(true)
  expect(c2.mailFrom).toBe('hi@ex.test')
})

test('authOpenApi defaults off, accepts on, rejects garbage', () => {
  const base = { TEXTCASTER_TOKEN: 't', TEXTCASTER_AUTH_SECRET: 's' }
  expect(loadConfig(base).authOpenApi).toBe(false)
  expect(loadConfig({ ...base, TEXTCASTER_AUTH_OPENAPI: 'on' }).authOpenApi).toBe(true)
  expect(loadConfig({ ...base, TEXTCASTER_AUTH_OPENAPI: 'off' }).authOpenApi).toBe(false)
  expect(() => loadConfig({ ...base, TEXTCASTER_AUTH_OPENAPI: 'maybe' })).toThrow('TEXTCASTER_AUTH_OPENAPI')
})
