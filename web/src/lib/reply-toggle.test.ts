import { test, expect } from 'vitest'
import { replyToggleLabel } from './reply-toggle'

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
