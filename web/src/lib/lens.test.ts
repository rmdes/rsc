import { test, expect } from 'vitest'
import { keepEvent } from './lens'
import type { TimelineEntry } from './types'

const entry = (authorId: string): TimelineEntry => ({ id: 'p', title: null, content: 'x', url: null, publishedAt: '', source: 'remote', author: { id: authorId, handle: 'h', displayName: 'H', kind: 'remote' } })

test('author lens keeps only the matching author', () => {
  expect(keepEvent(entry('a'), { kind: 'author', authorId: 'a' })).toBe(true)
  expect(keepEvent(entry('b'), { kind: 'author', authorId: 'a' })).toBe(false)
})

test('followed lens keeps entries by classification.personal', () => {
  const lens = { kind: 'followed' as const }
  expect(keepEvent({ ...entry('a'), classification: { personal: true, federated: false } }, lens)).toBe(true)
  expect(keepEvent({ ...entry('c'), classification: { personal: false, federated: false } }, lens)).toBe(false)
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

// D2: a v2 upsert never sets author.feedType — the federated tab must key off the
// server-computed classification.federated instead, or every live remote item drops.
test('feedType lens keeps a v2 entry by classification.federated, ignoring the null feedType', () => {
  const e = { ...entry('a'), classification: { personal: false, federated: true } }
  expect(e.author.feedType).toBeUndefined() // the field the v1 path keyed off is absent
  expect(keepEvent(e, { kind: 'feedType', feedType: 'instance' })).toBe(true)
  const notFed = { ...entry('a'), classification: { personal: true, federated: false } }
  expect(keepEvent(notFed, { kind: 'feedType', feedType: 'instance' })).toBe(false)
})

// D3: a followed remote publisher carries no local user id — the personal tab
// keys off classification.personal alone, which the projector always sets.
test('followed lens keeps a v2 entry by classification.personal regardless of author id', () => {
  const lens = { kind: 'followed' as const }
  const e = { ...entry('remote-pub'), classification: { personal: true, federated: false } }
  expect(keepEvent(e, lens)).toBe(true)
  const notPersonal = { ...entry('remote-pub'), classification: { personal: false, federated: true } }
  expect(keepEvent(notPersonal, lens)).toBe(false)
})
