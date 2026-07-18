import { describe, it, expect } from 'vitest'
import { mergeIncoming } from './live.ts'
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
