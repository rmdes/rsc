import { test, expect, vi } from 'vitest'
import { createEventBus } from '../src/domain/bus.ts'
import type { TimelineEntry } from '../src/domain/types.ts'

const entry: TimelineEntry = { id: 'p1', authorId: 'a', source: 'local', guid: 'g1', title: null, content: 'hi', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', author: { id: 'a', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z', authUserId: null } }

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
