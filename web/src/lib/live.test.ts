import { describe, it, expect } from 'vitest'
import { mergeIncoming, overlayVisibleRootCount, applyRiverEvent } from './live.ts'
const e = (id: string, over = {}) => ({ id, content: 'c', ...over }) as any

describe('mergeIncoming', () => {
  it('new id → prepends to live', () => {
    const r = mergeIncoming([], {}, e('n1'), new Set())
    expect(r.live.map((p) => p.id)).toEqual(['n1'])
    expect(r.edited).toEqual({})
  })
  it('id already on the page → overlays into edited (swap, not prepend)', () => {
    const r = mergeIncoming([], {}, e('p1', { editedAt: 'x' }), new Set(['p1']))
    expect(r.live).toEqual([])
    expect(r.edited.p1.editedAt).toBe('x')
  })
  it('id already in live → overlays into edited', () => {
    const r = mergeIncoming([e('l1')], {}, e('l1', { editedAt: 'x' }), new Set())
    expect(r.edited.l1.editedAt).toBe('x')
  })
  it('unknown id with editedAt set (off-page edit) → dropped, not prepended', () => {
    const r = mergeIncoming([], {}, e('x1', { editedAt: 'x' }), new Set())
    expect(r.live).toEqual([])
    expect(r.edited).toEqual({})
  })
})

describe('overlayVisibleRootCount', () => {
  it('replaces a visible root count with the server total, and never materializes an absent root', () => {
    const posts = [e('root', { replyCount: 1 })]
    expect(overlayVisibleRootCount({}, posts, 'root', 3).root.replyCount).toBe(3)
    expect(overlayVisibleRootCount({}, posts, 'off-page', 3)).toEqual({})
    expect(overlayVisibleRootCount({ root: e('root', { replyCount: 2 }) }, posts, 'root', 3).root.replyCount).toBe(3)
  })
})

// The governing constraint: a resolved-reply frame only ever updates a VISIBLE
// root's count. It is never prepended, never passed to mergeIncoming, and
// never touches an expanded thread.
describe('applyRiverEvent', () => {
  const reply = (over = {}) => e('rep', { inReplyToPostId: 'p', threadRootId: 'root', ...over })
  const ctx = (posts: any[], keep = true) => ({ posts, pageIds: new Set(posts.map((p) => p.id)), keep })
  const roots = [e('root', { replyCount: 1 })]

  it('resolved reply with both fields → overlays the visible root, prepends nothing', () => {
    const r = applyRiverEvent({ live: [], edited: {} }, reply({ rootReplyCount: 3 }), ctx(roots))
    expect(r.live).toEqual([])
    expect(r.edited.root.replyCount).toBe(3)
    expect(r.edited.rep).toBeUndefined()
  })

  it('applying the same frame twice is idempotent (authoritative, never incremented)', () => {
    const frame = reply({ rootReplyCount: 3 })
    const once = applyRiverEvent({ live: [], edited: {} }, frame, ctx(roots))
    const twice = applyRiverEvent(once, frame, ctx(roots.map((p) => once.edited[p.id] ?? p)))
    expect(twice.edited.root.replyCount).toBe(3)
    expect(twice.live).toEqual([])
  })

  it('rootReplyCount 0 is a legitimate total, not a falsy frame to drop', () => {
    const r = applyRiverEvent({ live: [], edited: {} }, reply({ rootReplyCount: 0 }), ctx(roots))
    expect(r.edited.root.replyCount).toBe(0)
  })

  it('enrichment failed (no rootReplyCount) → dropped whole: no card, no NaN/undefined overlay', () => {
    const r = applyRiverEvent({ live: [], edited: {} }, reply(), ctx(roots))
    expect(r.live).toEqual([])
    expect(r.edited).toEqual({})
  })

  it('root off this page → nothing happens, the parent is never materialized', () => {
    const r = applyRiverEvent({ live: [], edited: {} }, reply({ rootReplyCount: 3, threadRootId: 'elsewhere' }), ctx(roots))
    expect(r.live).toEqual([])
    expect(r.edited).toEqual({})
  })

  it('a resolved reply the lens would have kept is still never a card', () => {
    const r = applyRiverEvent({ live: [], edited: {} }, reply({ rootReplyCount: 3 }), ctx([], true))
    expect(r.live).toEqual([])
    expect(r.edited).toEqual({})
  })

  it('an edit of a resolved reply carries no count → no card, no count change', () => {
    const r = applyRiverEvent({ live: [], edited: {} }, reply({ editedAt: 'x' }), ctx(roots))
    expect(r.live).toEqual([])
    expect(r.edited).toEqual({})
  })

  it('roots and unresolved replies still go through the lens and mergeIncoming', () => {
    expect(applyRiverEvent({ live: [], edited: {} }, e('n1'), ctx([], false)).live).toEqual([])
    expect(applyRiverEvent({ live: [], edited: {} }, e('n1'), ctx([], true)).live.map((p: any) => p.id)).toEqual(['n1'])
    const onPage = applyRiverEvent({ live: [], edited: {} }, e('root', { editedAt: 'x' }), ctx(roots))
    expect(onPage.edited.root.editedAt).toBe('x')
  })
})
