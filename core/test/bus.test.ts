import { test, expect, vi } from 'vitest'
import { createEventBus } from '../src/domain/bus.ts'

const entry = { authorId: 'a', handle: 'alice' }

test('delivers emitted posts to subscribers and stops after unsubscribe', () => {
  const bus = createEventBus()
  const fn = vi.fn()
  const off = bus.onNewPost(fn)
  bus.emitNewPost(entry)
  expect(fn).toHaveBeenCalledWith(entry)
  off()
  bus.emitNewPost(entry)
  expect(fn).toHaveBeenCalledTimes(1)
})
