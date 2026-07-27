import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createSourceService } from '../src/domain/source-service.ts'
import { createDatabaseContext } from '../src/logical/database.ts'
import { createLogicalStore } from '../src/logical/store.ts'
import { createAcquisition } from '../src/logical/acquisition.ts'
import { createApp } from '../src/api/app.ts'
import { makeAuth, anonSession } from './auth-helper.ts'

async function makeApp() {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const db = createDatabaseContext(repo.raw)
  const store = createLogicalStore(db)
  const app = createApp({
    service: createService(repo, bus, null, store), bus, token: 'secret', auth: makeAuth(repo), users: repo,
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
  return { app, repo }
}
const patch = (cookie: string, content: string) => ({ method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content }) })
async function createPost(app: Awaited<ReturnType<typeof makeApp>>['app'], cookie: string, content: string): Promise<string> {
  const res = await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content }) })
  return (await res.json()).post.id
}

// The history chain itself (oldest-first, current marker) is revisions.test.ts's
// subject; here it is only the yardstick for "was a snapshot taken?".
async function historyContent(app: Awaited<ReturnType<typeof makeApp>>['app'], id: string): Promise<string[]> {
  const body = await (await app.request(`/posts/${id}/revisions`)).json()
  return body.entries.map((e: { content: string }) => e.content)
}

test('owner edits own local post → 200, one revision (original), edited_at set', async () => {
  const { app, repo } = await makeApp()
  const cookie = await anonSession(app)
  const pid = await createPost(app, cookie, 'original')
  const res = await app.request(`/posts/${pid}`, patch(cookie, 'corrected'))
  expect(res.status).toBe(200)
  expect((await res.json()).post.content).toBe('corrected')
  expect(await historyContent(app, pid)).toEqual(['original', 'corrected']) // the snapshot, then the current
  expect((await repo.getPost(pid))?.editedAt).toBeTruthy()
})

test('no-op edit (same content) → 200, no revision', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const pid = await createPost(app, cookie, 'same')
  expect((await app.request(`/posts/${pid}`, patch(cookie, 'same'))).status).toBe(200)
  expect(await historyContent(app, pid)).toEqual(['same']) // current only — nothing snapshotted
})

test('a different session (non-owner) → 403; missing → 404', async () => {
  const { app } = await makeApp()
  const owner = await anonSession(app)
  const pid = await createPost(app, owner, 'mine')
  const other = await anonSession(app)
  expect((await app.request(`/posts/${pid}`, patch(other, 'x'))).status).toBe(403)
  expect((await app.request(`/posts/does-not-exist`, patch(owner, 'x'))).status).toBe(404)
})

test('editing without a session → 401', async () => {
  const { app } = await makeApp()
  const cookie = await anonSession(app)
  const pid = await createPost(app, cookie, 'mine')
  expect((await app.request(`/posts/${pid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x' }) })).status).toBe(401)
})
