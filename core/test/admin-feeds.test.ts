import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession, registeredSession } from './auth-helper.ts'

async function makeApp(adminEmails: string[] = ['boss@x.test']) {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo, adminEmails: new Set(adminEmails) })
  return { app, repo }
}
const body = (handle: string) => JSON.stringify({ handle, displayName: handle, feedUrl: 'https://ex.com/f.xml' })

test('POST /users: bearer token allowed', async () => {
  const { app } = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: body('news') })
  expect(res.status).toBe(201)
})
test('POST /users: admin session allowed', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'boss@x.test', repo)
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: body('news2') })
  expect(res.status).toBe(201)
})
test('POST /users: non-admin registered session → 403', async () => {
  const { app, repo } = await makeApp()
  const cookie = await registeredSession(app, 'peon@x.test', repo)
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: body('news3') })
  expect(res.status).toBe(403)
})
test('POST /users: anonymous session → 403 (a session, just not admin — matches SP1 /admin/status)', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: body('news4') })
  expect(res.status).toBe(403)
})
test('POST /users: no session at all → 401', async () => {
  const { app } = await makeApp()
  const res = await app.request('/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body('news5') })
  expect(res.status).toBe(401)
})
