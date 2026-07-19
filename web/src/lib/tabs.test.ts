import { test, expect } from 'vitest'
import { resolveTab, tabFilter } from './tabs'

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

test('tabFilter maps each tab to its getTimeline opts', () => {
  expect(tabFilter('local', undefined)).toEqual({ source: 'local' })
  expect(tabFilter('federated', undefined)).toEqual({ feedType: 'instance' })
  expect(tabFilter('personal', 'alice')).toEqual({ followedBy: 'alice' })
  expect(tabFilter('public', undefined)).toEqual({})
})
