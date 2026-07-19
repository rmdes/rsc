import { test, expect } from 'vitest'
import { keepEvent } from './lens'
import type { TimelineEntry } from './types'

const entry = (authorId: string): TimelineEntry => ({ id: 'p', title: null, content: 'x', url: null, publishedAt: '', source: 'remote', author: { id: authorId, handle: 'h', displayName: 'H', kind: 'remote' } })

test('author lens keeps only the matching author', () => {
  expect(keepEvent(entry('a'), { kind: 'author', authorId: 'a' })).toBe(true)
  expect(keepEvent(entry('b'), { kind: 'author', authorId: 'a' })).toBe(false)
})

test('followed lens keeps only authors in the follow set', () => {
  const lens = { kind: 'followed' as const, followIds: new Set(['a', 'b']) }
  expect(keepEvent(entry('a'), lens)).toBe(true)
  expect(keepEvent(entry('c'), lens)).toBe(false)
})

test('thread lens keeps the root and its descendants only', () => {
  const lens = { kind: 'thread' as const, rootId: 'root' }
  expect(keepEvent({ ...entry('a'), id: 'root' }, lens)).toBe(true)
  expect(keepEvent({ ...entry('a'), threadRootId: 'root' }, lens)).toBe(true)
  expect(keepEvent(entry('a'), lens)).toBe(false)
})

test('source lens keeps only local posts', () => {
  expect(keepEvent({ ...entry('a'), source: 'local' }, { kind: 'source', source: 'local' })).toBe(true)
  expect(keepEvent(entry('a'), { kind: 'source', source: 'local' })).toBe(false)
})

test('feedType lens keeps only instance authors', () => {
  const e = entry('a')
  e.author.feedType = 'instance'
  expect(keepEvent(e, { kind: 'feedType', feedType: 'instance' })).toBe(true)
  expect(keepEvent(entry('b'), { kind: 'feedType', feedType: 'instance' })).toBe(false) // feedType absent → dropped
})
