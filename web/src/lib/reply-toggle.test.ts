import { test, expect } from 'vitest'
import { replyToggleLabel, replyToggleClick } from './reply-toggle'

test('the accessible name says what activating the control does', () => {
  expect(replyToggleLabel(2, false, false)).toBe('Show 2 replies')
  expect(replyToggleLabel(2, true, false)).toBe('Hide 2 replies')
})

test('busy wins over the show/hide verb', () => {
  expect(replyToggleLabel(1, false, true)).toBe('Loading 1 reply')
})

test('one reply is singular in every state', () => {
  expect(replyToggleLabel(1, false, false)).toBe('Show 1 reply')
  expect(replyToggleLabel(1, true, false)).toBe('Hide 1 reply')
})

const click = () => {
  const calls: string[] = []
  return {
    calls,
    ev: (mod: Record<string, boolean> = {}) => ({
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      ...mod,
      preventDefault: () => calls.push('preventDefault')
    })
  }
}

test('a plain click is an inline expansion, not a navigation', () => {
  const c = click()
  replyToggleClick(c.ev(), false, () => c.calls.push('activate'))
  expect(c.calls).toEqual(['preventDefault', 'activate'])
})

// It is a LINK first: cmd/ctrl/shift+click must reach the browser so the
// conversation opens in a new tab/window, exactly like any other permalink.
test('a modified click is left to the browser — no preventDefault, no expansion', () => {
  const mods: Record<string, boolean>[] = [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }]
  for (const mod of mods) {
    const c = click()
    replyToggleClick(c.ev(mod), false, () => c.calls.push('activate'))
    expect(c.calls).toEqual([])
  }
})

// Double-click while the thread is still loading must not start a second fetch.
test('a click while busy is swallowed: navigation suppressed, no second fetch', () => {
  const c = click()
  replyToggleClick(c.ev(), true, () => c.calls.push('activate'))
  expect(c.calls).toEqual(['preventDefault'])
})
