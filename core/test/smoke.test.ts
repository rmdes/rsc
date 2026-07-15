import { test, expect } from 'vitest'
import { hello } from '../src/smoke.ts'

test('toolchain runs TypeScript tests', () => {
  expect(hello()).toBe('textcaster')
})
