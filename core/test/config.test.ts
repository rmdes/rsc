import { test, expect } from 'vitest'
import { loadConfig } from '../src/config.ts'

test('requires a token', () => {
  expect(() => loadConfig({})).toThrow('TEXTCASTER_TOKEN')
})
test('applies defaults', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't' })
  expect(c.port).toBe(8787)
  expect(c.pollSeconds).toBe(60)
})
