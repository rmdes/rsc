import { test, expect } from 'vitest'
import { resolveTab, TAB_LABELS, TAB_SUBTITLES, TABS } from './tabs'

const registered = { isAnonymous: false }
const anon = { isAnonymous: true }

test('defaults: registered → personal, anon → public, guest → public', () => {
  expect(resolveTab(null, registered)).toBe('personal')
  expect(resolveTab(null, anon)).toBe('public')
  expect(resolveTab(null, null)).toBe('public')
})

test('valid explicit tabs pass through; anon may select personal', () => {
  expect(resolveTab('local', null)).toBe('local')
  expect(resolveTab('personal', anon)).toBe('personal')
})

test('invalid tab and guest-on-personal fall back to the viewer default', () => {
  expect(resolveTab('bogus', registered)).toBe('personal')
  expect(resolveTab('bogus', null)).toBe('public')
  expect(resolveTab('personal', null)).toBe('public')
})

test('each tab has its own distinct subtitle; following keeps the you-and-follows line', () => {
  // The page-head subtitle was hardcoded to the following description on every
  // tab; each tab must now describe its own scope.
  expect(TAB_SUBTITLES.personal).toBe('Everything from you and the people you follow')
  const subtitles = TABS.map((t) => TAB_SUBTITLES[t])
  expect(subtitles.every((s) => s.length > 0)).toBe(true)
  expect(new Set(subtitles).size).toBe(TABS.length)
})

test('labels rename personal→following and public→explore while URL keys stay personal/public', () => {
  // The display label is decoupled from the routing key: renaming the tab must
  // never change ?tab= or resolveTab (bookmarks + lens logic depend on the key).
  expect(TAB_LABELS.personal).toBe('following')
  expect(TAB_LABELS.public).toBe('explore')
  expect(resolveTab('personal', registered)).toBe('personal')
  expect(resolveTab('public', null)).toBe('public')
})
