import { test, expect } from 'vitest'
import { loadConfig } from '../src/config.ts'

// loadConfig only hard-requires TOKEN + AUTH_SECRET; everything else defaults
// (websub off, no public URL needed).
const base = { RSC_TOKEN: 't', RSC_AUTH_SECRET: 's' }

test('RSC_ADMIN_EMAIL parses to a lowercased, trimmed set', () => {
  const c = loadConfig({ ...base, RSC_ADMIN_EMAIL: ' Admin@X.test , owner@Y.test ,, ' })
  expect([...c.adminEmails].sort()).toEqual(['admin@x.test', 'owner@y.test'])
})

test('unset or blank RSC_ADMIN_EMAIL → empty set', () => {
  expect(loadConfig(base).adminEmails.size).toBe(0)
  expect(loadConfig({ ...base, RSC_ADMIN_EMAIL: '  ,  , ' }).adminEmails.size).toBe(0)
})
