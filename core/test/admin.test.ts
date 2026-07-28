import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
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

// ── integration: /me and /admin/overview ──
async function makeApp(adminEmails: string[]) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const service = createService(repo, bus, null, store)
  const app = createApp({
    service, bus, token: 'secret', auth: makeAuth(repo), users: repo, adminEmails: new Set(adminEmails),
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { app, repo }
}

test('admin session: /me isAdmin true, /admin/overview 200', async () => {
  const { app, repo } = await makeApp(['boss@x.test'])
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const me = await app.request('/me', { headers: { cookie } })
  expect((await me.json()).isAdmin).toBe(true)
  const status = await app.request('/admin/overview', { headers: { cookie } })
  expect(status.status).toBe(200)
  expect((await status.json()).adminEmails).toEqual(['boss@x.test'])
})

test('non-admin session: /me isAdmin false, /admin/overview 403', async () => {
  const { app, repo } = await makeApp(['boss@x.test'])
  const cookie = await registeredSession(app, 'peon@x.test', repo)
  expect((await (await app.request('/me', { headers: { cookie } })).json()).isAdmin).toBe(false)
  expect((await app.request('/admin/overview', { headers: { cookie } })).status).toBe(403)
})

test('anonymous session: /me isAdmin false, /admin/overview 403', async () => {
  const { app } = await makeApp(['boss@x.test'])
  const cookie = await anonSession(app)
  expect((await (await app.request('/me', { headers: { cookie } })).json()).isAdmin).toBe(false)
  expect((await app.request('/admin/overview', { headers: { cookie } })).status).toBe(403)
})

test('no admins configured: even a matching email is not admin (fail-closed)', async () => {
  const { app, repo } = await makeApp([])
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  expect((await (await app.request('/me', { headers: { cookie } })).json()).isAdmin).toBe(false)
  expect((await app.request('/admin/overview', { headers: { cookie } })).status).toBe(403)
})

test('admin session: /admin/overview includes scheduler stats', async () => {
  const { app, repo } = await makeApp(['boss@x.test'])
  repo.raw.prepare(
    `INSERT INTO remote_sources_v2 (id, canonical_url, attribution_mode, operation, governance, provenance, provenance_note, admin_retained, created_at)
     VALUES ('s1', 'https://feed.test/s1', 'single_publisher', 'enabled', 'allowed', 'admin_federation', NULL, 0, ?)`,
  ).run('2026-07-28T00:00:00.000Z')
  const owner = await repo.createLocalUser({ handle: 'owner1', displayName: 'Owner' })
  repo.raw.prepare(`INSERT INTO source_subscriptions_v2 (id, owner_id, source_id, state, created_at) VALUES ('sub1', ?, 's1', 'active', ?)`)
    .run(owner.id, '2026-07-28T00:00:00.000Z')

  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/admin/overview', { headers: { cookie } })
  const body = await res.json()
  expect(body.scheduler.catalogSize).toBe(1)
  expect(body.scheduler.mostOverdueSeconds).toBeNull() // never polled = maximally overdue, reported as null
  expect(body.scheduler.attemptedLastWindow).toBe(0)
  expect(body.scheduler.windowSpanSeconds).toBeNull()
})
