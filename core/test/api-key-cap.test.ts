import { test, expect } from 'vitest'
import { Hono } from 'hono'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { sessionAuth, requireAdmin } from '../src/api/auth.ts'
import { mountPersonalApiRoutes, mountAdminApiRoutes } from '../src/api/logical-routes.ts'
import { makeAuth, registeredSession } from './auth-helper.ts'

// Security audit M4: the apiKey plugin's 300/hr rate limit is stored and
// evaluated per KEY ROW, not per user (referenceId) — so without a cap on
// issuance, a scripted caller could mint keys without bound to cycle past
// that limit (N keys x 300/hr). Mirrors MAX_API_KEYS_PER_USER in
// logical-routes.ts; not exported since only these two routes need it.
const MAX = 20

async function setupPersonal() {
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const bus = createEventBus()
  const auth = makeAuth(repo)
  const service = createService(repo, bus, null, store)
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'capped@x.test', repo)
  const app = new Hono()
  mountPersonalApiRoutes(app, { store, auth, users: repo, service, sourceService: createSourceService(repo, null) })
  return { app, cookie, repo }
}

// Same wiring app.ts uses for real: sessionAuth + requireAdmin gate '/admin/*'
// BEFORE mountAdminApiRoutes is mounted (see app.ts's own `app.use('/admin/*',
// authed, requireAdmin())` immediately before its mountAdminApiRoutes call).
async function setupAdmin() {
  const adminEmails: ReadonlySet<string> = new Set(['admin@x.test'])
  const repo = await createSqliteRepository(':memory:')
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const bus = createEventBus()
  const auth = makeAuth(repo, undefined, false, adminEmails)
  const service = createService(repo, bus, null, store)
  const sourceService = createSourceService(repo, null)
  const authApp = new Hono()
  authApp.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
  const cookie = await registeredSession(authApp, 'admin@x.test', repo)
  const app = new Hono()
  app.use('/admin/*', sessionAuth(auth, repo, adminEmails), requireAdmin())
  mountAdminApiRoutes(app, {
    auth, users: repo, adminEmails, service, sourceRepo: repo, sourceService,
    logicalStore: store, feeds: { publicUrl: null, hubUrl: null, rssCloud: false },
    websubMode: 'off', pushInEnabled: false, mailEnabled: true, pollSeconds: 60,
  })
  return { app, cookie, repo }
}

test('POST /me/api-keys refuses past the per-user cap (user tier)', async () => {
  const { app, cookie, repo } = await setupPersonal()
  for (let i = 0; i < MAX; i++) {
    const res = await app.request('/me/api-keys', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: `k${i}`, permissions: { timeline: ['read'] } })
    })
    expect(res.status).toBe(201)
  }
  const overCap = await app.request('/me/api-keys', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'over-cap', permissions: { timeline: ['read'] } })
  })
  expect(overCap.status).toBe(429)
  expect(await overCap.json()).toEqual({ error: 'api key limit reached' })
  // Prove the 429 actually stopped the write, not just the response body:
  // the 21st key must never have reached the apikey table.
  const authRow = repo.raw.prepare('SELECT id FROM user WHERE email = ?').get('capped@x.test') as { id: string }
  expect(await repo.countApiKeys(authRow.id, 'user')).toBe(MAX)
})

test('POST /admin/api-keys refuses past the per-user cap (admin tier, counted separately from user tier)', async () => {
  const { app, cookie, repo } = await setupAdmin()
  for (let i = 0; i < MAX; i++) {
    const res = await app.request('/admin/api-keys', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: `k${i}`, permissions: { 'admin.read': ['read'] } })
    })
    expect(res.status).toBe(201)
  }
  const overCap = await app.request('/admin/api-keys', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'over-cap', permissions: { 'admin.read': ['read'] } })
  })
  expect(overCap.status).toBe(429)
  expect(await overCap.json()).toEqual({ error: 'api key limit reached' })
  // Prove the 429 actually stopped the write, not just the response body:
  // the 21st key must never have reached the apikey table.
  const authRow = repo.raw.prepare('SELECT id FROM user WHERE email = ?').get('admin@x.test') as { id: string }
  expect(await repo.countApiKeys(authRow.id, 'admin')).toBe(MAX)
})
