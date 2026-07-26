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
  return createApp({
    service: createService(repo, bus, null, store), bus, token: 'secret', auth: makeAuth(repo), users: repo,
    sources: { service: createSourceService(repo, null), repo },
    logical: { store, acquisition: createAcquisition({ db }) },
  })
}
const patch = (cookie: string, content: string) => ({ method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content }) })

// The v2 history envelope (spec §4.5, logical-routes.ts:419 projectHistory):
// one `entries` chain oldest-first with the CURRENT content as its last entry,
// instead of v1's {post, revisions[]} split. Driven end to end here — through
// POST/PATCH and the real route — where logical-projector.test.ts pins the same
// chain at the projector boundary.
test('returns the local history chain oldest-first with a current marker (public, no auth)', async () => {
  const app = await makeApp()
  const cookie = await anonSession(app)
  const pid = (await (await app.request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ content: 'v1' }) })).json()).post.id
  await app.request(`/posts/${pid}`, patch(cookie, 'v2'))
  await app.request(`/posts/${pid}`, patch(cookie, 'v3'))
  const res = await app.request(`/posts/${pid}/revisions`) // no cookie → public
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toMatchObject({ model: 'logical-v2', logicalItemId: pid, origin: 'local', currentSequence: 2 })
  expect(body.entries.map((e: { content: string }) => e.content)).toEqual(['v1', 'v2', 'v3'])
  expect(body.entries.map((e: { current: boolean }) => e.current)).toEqual([false, false, true])
})

test('unknown post → 404', async () => {
  expect((await (await makeApp()).request('/posts/nope/revisions')).status).toBe(404)
})
