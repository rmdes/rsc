import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { deriveIsAdmin } from '../src/api/auth.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

// ── unit: the security-critical derivation ──
const admins = new Set(['admin@x.test'])
test('deriveIsAdmin: verified admin email → true', () => {
  expect(deriveIsAdmin({ email: 'admin@x.test', emailVerified: true }, admins)).toBe(true)
})
test('deriveIsAdmin: unverified admin email → false (linchpin)', () => {
  expect(deriveIsAdmin({ email: 'admin@x.test', emailVerified: false }, admins)).toBe(false)
})
test('deriveIsAdmin: verified non-admin → false', () => {
  expect(deriveIsAdmin({ email: 'someone@x.test', emailVerified: true }, admins)).toBe(false)
})
test('deriveIsAdmin: no email (anon) → false', () => {
  expect(deriveIsAdmin({ email: null, emailVerified: false }, admins)).toBe(false)
})
test('deriveIsAdmin: empty admin set → false', () => {
  expect(deriveIsAdmin({ email: 'admin@x.test', emailVerified: true }, new Set())).toBe(false)
})
test('deriveIsAdmin: case-insensitive match', () => {
  expect(deriveIsAdmin({ email: 'ADMIN@X.test', emailVerified: true }, admins)).toBe(true)
})

// ── integration: /me and /admin/status ──
async function makeApp(adminEmails: string[]) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, adminEmails: new Set(adminEmails) })
  return { app, repo }
}

test('admin session: /me isAdmin true, /admin/status 200', async () => {
  const { app, repo } = await makeApp(['boss@x.test'])
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const me = await app.request('/me', { headers: { cookie } })
  expect((await me.json()).isAdmin).toBe(true)
  const status = await app.request('/admin/status', { headers: { cookie } })
  expect(status.status).toBe(200)
  expect((await status.json())).toEqual({ ok: true, adminEmails: ['boss@x.test'] })
})

test('non-admin session: /me isAdmin false, /admin/status 403', async () => {
  const { app, repo } = await makeApp(['boss@x.test'])
  const cookie = await registeredSession(app, 'peon@x.test', repo)
  expect((await (await app.request('/me', { headers: { cookie } })).json()).isAdmin).toBe(false)
  expect((await app.request('/admin/status', { headers: { cookie } })).status).toBe(403)
})

test('anonymous session: /me isAdmin false, /admin/status 403', async () => {
  const { app } = await makeApp(['boss@x.test'])
  const cookie = await anonSession(app)
  expect((await (await app.request('/me', { headers: { cookie } })).json()).isAdmin).toBe(false)
  expect((await app.request('/admin/status', { headers: { cookie } })).status).toBe(403)
})

test('no admins configured: even a matching email is not admin (fail-closed)', async () => {
  const { app, repo } = await makeApp([])
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  expect((await (await app.request('/me', { headers: { cookie } })).json()).isAdmin).toBe(false)
  expect((await app.request('/admin/status', { headers: { cookie } })).status).toBe(403)
})
